"""ZED -> WebSocket bridge.

Grabs the left color image + depth map from a ZED camera (or an .svo recording)
and streams them to the browser. The page can switch between scenes.

    python bridge.py                      # every .svo next to this script (live camera if none)
    python bridge.py a.svo b.svo          # these recordings (wildcards like *.svo work)
    python bridge.py --live               # add the live camera to the scenes

Protocol (ws://localhost:8765):
  1. On connect, and again after each scene switch or depth, matting or detection settings
     change, one JSON text message with the image and depth sizes, intrinsics, the list of
     scenes, the current scene, and the depth, matting and detection settings.
  2. Binary messages, each starting with a 2-byte header [kind, flags]:
       kind 0, a frame (one per frame):
         [depth: depthWidth*depthHeight uint16 little-endian, millimeters,
                 0 = unknown, 65535 = too far (beyond the ZED's range)]
         if flags & HAS_OBJECTS: [objects length: uint32 little-endian]
                                 [objects detected: UTF-8 JSON list, see object_info()]
         if flags & HAS_MATTE: [matte length: uint32 little-endian]
                               [people's alpha matte: grayscale JPEG, video size, 255 = person]
         [color: JPEG bytes, until end of message]
  Browser -> bridge:
     {"type": "control", "playing": bool, "speed": float}
       (speed only applies to SVO sources; a live camera runs at its own rate)
     {"type": "scene", "name": str}
     {"type": "depth", "settings": {...}}   any subset of DEPTH_SETTINGS
     {"type": "matting", "settings": {...}}  any subset of MATTING_SETTINGS
     {"type": "detection", "settings": {...}}  any subset of DETECTION_SETTINGS
"""

import asyncio
import glob
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import websockets

from matting import Matting

PORT = 8765
IMG_W, IMG_H = 1280, 720
JPEG_QUALITY = 85

# ZED SDK depth settings, which the page can change. Most apply from the next frame;
# REOPEN_SETTINGS only apply when the camera opens, so changing them reopens it
# (a second or two, at the same SVO frame; minutes the first time a depth mode is used).
DEPTH_SETTINGS = dict(
    mode="NEURAL",  # one of DEPTH_MODES
    stabilization=30,  # 0-100, smooths depth over time where the scene is static
    confidence=95,  # 1-100, lower drops more uncertain pixels (mostly along edges)
    textureConfidence=100,  # 1-100, lower drops more pixels in plain, textureless areas
    fill=False,  # fill every hole: no invalid pixels, but guessed depth there
    removeSaturated=True,  # drop pixels in over-exposed areas
    resolution="640x360",  # depth map size sent to the page, one of DEPTH_RESOLUTIONS
)
REOPEN_SETTINGS = {"mode", "stabilization"}
DEPTH_MODES = ["NEURAL_LIGHT", "NEURAL", "NEURAL_PLUS"]  # fastest to sharpest
DEPTH_RESOLUTIONS = {"640x360": (640, 360), "1280x720": (1280, 720)}

# People matting (see matting.py), which the page can change; applies from the next frame.
MATTING_SETTINGS = dict(
    enabled=True,
    input="640x360",  # the size of the image RVM gets, one of MATTING_INPUTS: smaller is faster, softer edges
    ratio=0.5,  # the share of that size RVM works at internally: higher finds smaller people, slower
)
MATTING_INPUTS = {"640x360": (640, 360), "1280x720": (1280, 720)}
MATTE_JPEG_QUALITY = 90

# ZED SDK object detection (built-in models), which the page can change. The confidence applies
# from the next frame; changing the model takes about a second (minutes the first time a model
# is used: the SDK optimizes it for the GPU, then caches it).
DETECTION_SETTINGS = dict(
    enabled=True,
    model="MULTI_CLASS_BOX_FAST",  # one of DETECTION_MODELS
    confidence=50,  # 1-99, objects detected with less are dropped
)
DETECTION_MODELS = [
    "MULTI_CLASS_BOX_FAST", "MULTI_CLASS_BOX_MEDIUM", "MULTI_CLASS_BOX_ACCURATE",  # people, vehicles, bags...
    "PERSON_HEAD_BOX_FAST", "PERSON_HEAD_BOX_ACCURATE",  # heads only, for crowds
]

# Binary message kinds (the first byte of the 2-byte header), and flags (the second).
FRAME = 0
HAS_MATTE, HAS_OBJECTS = 1, 2
# Depth beyond the ZED's range (+inf from the SDK), sent as the largest uint16: "nothing within
# range here" never occludes, unlike an unknown pixel (0). The page reads it as 65.535 m.
TOO_FAR_MM = 65535


def encode_frame(bgr, depth_m, matte=None, objects=None):
    """bgr: HxWx3 uint8, depth_m: float32 meters
    (+inf = too far, NaN/-inf/0 = unknown), matte: HxW uint8 or None,
    objects: a list of object_info() or None (detection off)."""
    mm = np.nan_to_num(depth_m, nan=0.0, posinf=TOO_FAR_MM / 1000, neginf=0.0) * 1000.0
    mm = np.clip(mm, 0, TOO_FAR_MM).astype("<u2")
    ok, jpeg = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    # 2 bytes keep the depth aligned for a Uint16Array on the page.
    flags, parts = 0, [mm.tobytes()]
    if objects is not None:
        flags |= HAS_OBJECTS
        data = json.dumps(objects, separators=(",", ":")).encode()
        parts += [len(data).to_bytes(4, "little"), data]
    if matte is not None:
        flags |= HAS_MATTE
        # A grayscale JPEG: a few dozen KB instead of about 900 KB raw, without the cost of compressing it losslessly.
        ok, matte_jpeg = cv2.imencode(".jpg", matte, [cv2.IMWRITE_JPEG_QUALITY, MATTE_JPEG_QUALITY])
        parts += [len(matte_jpeg).to_bytes(4, "little"), matte_jpeg.tobytes()]
    return bytes([FRAME, flags]) + b"".join(parts) + jpeg.tobytes()


def json_values(values, digits=3):
    """A (nested) list for JSON: rounded, with None where unknown (JSON has no NaN)."""
    a = np.asarray(values, dtype=np.float64).round(digits)
    return np.where(np.isfinite(a), a, None).tolist()


def object_info(obj, box_scale):
    """One object the ZED SDK detected, for the page. 3D values in meters, in the camera's
    frame (the page's); box2d in pixels of the image sent."""
    return dict(
        id=obj.id,  # stable while the object is tracked
        label=obj.label.name,  # PERSON, VEHICLE, BAG, ANIMAL, ELECTRONICS, FRUIT_VEGETABLE, SPORT
        sublabel=obj.sublabel.name,  # finer: CAR, BUS, BICYCLE, BACKPACK, PERSON_HEAD...
        confidence=round(obj.confidence),  # 0-100
        tracking=obj.tracking_state.name,  # OK, OFF, SEARCHING (lost for now), TERMINATE
        moving=obj.action_state.name == "MOVING",
        position=json_values(obj.position),
        velocity=json_values(obj.velocity),  # meters per second
        dimensions=json_values(obj.dimensions),  # width, height, length
        # 8 corners: 0-3 one horizontal face, 4-7 the other, corner i above or below i+4.
        box3d=json_values(obj.bounding_box),
        # 4 corners, clockwise from the top-left, at the recording's native resolution: scaled.
        box2d=json_values(np.asarray(obj.bounding_box_2d, dtype=np.float64).reshape(-1, 2) * box_scale, 1),
    )


def update_matting_settings(settings, changes):
    """`settings` with the valid entries of `changes` (from the page) applied."""
    settings = dict(settings)
    if "enabled" in changes:
        settings["enabled"] = bool(changes["enabled"])
    if "ratio" in changes:
        settings["ratio"] = min(max(float(changes["ratio"]), 0.1), 1.0)
    if changes.get("input") in MATTING_INPUTS:
        settings["input"] = changes["input"]
    return settings


def update_detection_settings(settings, changes):
    """`settings` with the valid entries of `changes` (from the page) applied."""
    settings = dict(settings)
    if "enabled" in changes:
        settings["enabled"] = bool(changes["enabled"])
    if "confidence" in changes:
        settings["confidence"] = min(max(int(changes["confidence"]), 1), 99)
    if changes.get("model") in DETECTION_MODELS:
        settings["model"] = changes["model"]
    return settings


def update_depth_settings(settings, changes):
    """`settings` with the valid entries of `changes` (from the page) applied."""
    settings = dict(settings)
    for key, value in changes.items():
        if key in ("fill", "removeSaturated"):
            settings[key] = bool(value)
        elif key in ("confidence", "textureConfidence"):
            settings[key] = min(max(int(value), 1), 100)
        elif key == "stabilization":
            settings[key] = min(max(int(value), 0), 100)
        elif key == "mode" and value in DEPTH_MODES:
            settings[key] = value
        elif key == "resolution" and value in DEPTH_RESOLUTIONS:
            settings[key] = value
    return settings


class ZedSource:
    def __init__(self, svo_path, depth_settings):
        import pyzed.sl as sl

        self.sl = sl
        self.svo = bool(svo_path)
        init = sl.InitParameters()
        if svo_path:
            init.set_from_svo_file(svo_path)
            init.svo_real_time_mode = False  # we pace playback ourselves, see main()
        init.depth_mode = getattr(sl.DEPTH_MODE, depth_settings["mode"])
        init.depth_stabilization = depth_settings["stabilization"]
        init.coordinate_units = sl.UNIT.METER
        init.coordinate_system = sl.COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP  # same as three.js

        self.cam = sl.Camera()
        err = self.cam.open(init)
        if err != sl.ERROR_CODE.SUCCESS:
            raise RuntimeError(f"Could not open {svo_path or 'the ZED camera'}: {err}")

        # Intrinsics of the rectified left image, at the resolution we send.
        info = self.cam.get_camera_information(sl.Resolution(IMG_W, IMG_H))
        left = info.camera_configuration.calibration_parameters.left_cam
        self.intrinsics = dict(fx=left.fx, fy=left.fy, cx=left.cx, cy=left.cy)
        # Recorded frame rate, used to pace SVO playback. A live camera paces itself.
        self.fps = info.camera_configuration.fps if svo_path else None

        self.runtime = sl.RuntimeParameters()
        # Detected objects in the camera's frame (the page's), not the world's: with the IMU,
        # positional tracking would align the world with gravity.
        self.runtime.measure3D_reference_frame = sl.REFERENCE_FRAME.CAMERA
        self.image = sl.Mat()
        self.depth = sl.Mat()
        self.set_depth_settings(depth_settings)

        self.detection_model = None  # the model enabled, None when detection is off
        self.detection_runtime = sl.ObjectDetectionRuntimeParameters()
        self.objects = sl.Objects()
        native = info.camera_configuration.resolution
        self.box_scale = (IMG_W / native.width, IMG_H / native.height)

    def set_depth_settings(self, settings):
        """Applies the settings that don't need a reopen, from the next grab."""
        self.runtime.confidence_threshold = settings["confidence"]
        self.runtime.texture_confidence_threshold = settings["textureConfidence"]
        self.runtime.enable_fill_mode = settings["fill"]
        self.runtime.remove_saturated_areas = settings["removeSaturated"]
        self.depth_size = DEPTH_RESOLUTIONS[settings["resolution"]]

    def set_detection(self, settings):
        """Enables, changes or disables object detection, from the next grab.
        Returns None, or why detection couldn't start."""
        sl = self.sl
        self.detection_runtime.detection_confidence_threshold = settings["confidence"]
        model = settings["model"] if settings["enabled"] else None
        if model == self.detection_model:
            return None
        if self.detection_model:
            self.cam.disable_object_detection()
            self.detection_model = None
        if not model:
            return None
        # Tracking objects across frames (stable ids, velocity) needs positional tracking.
        if not self.cam.is_positional_tracking_enabled():
            tracking = sl.PositionalTrackingParameters()
            tracking.set_as_static = True  # the camera doesn't move
            err = self.cam.enable_positional_tracking(tracking)
            if err != sl.ERROR_CODE.SUCCESS:
                return f"positional tracking: {err}"
        params = sl.ObjectDetectionParameters()
        params.detection_model = getattr(sl.OBJECT_DETECTION_MODEL, model)
        params.enable_tracking = True
        err = self.cam.enable_object_detection(params)
        if err != sl.ERROR_CODE.SUCCESS:
            return str(err)
        self.detection_model = model
        return None

    def detect(self):
        """The objects detected in the frame last grabbed (see object_info), or None when detection is off."""
        if not self.detection_model:
            return None
        self.cam.retrieve_objects(self.objects, self.detection_runtime)
        return [object_info(obj, self.box_scale) for obj in self.objects.object_list]

    # The SVO frame last grabbed (None for a live camera), and going back to it:
    # the next grab returns the frame at the position set.
    def svo_position(self):
        return self.cam.get_svo_position() if self.svo else None

    def seek(self, position):
        if self.svo and position is not None:
            self.cam.set_svo_position(position)

    def regrab(self):
        """The last frame again (a new one for a live camera), e.g. with new settings while paused."""
        self.seek(self.svo_position())
        return self.grab()

    def grab(self):
        """(bgr, depth_m) of the next frame, or None. Both are views into buffers the next grab reuses."""
        sl = self.sl
        err = self.cam.grab(self.runtime)
        if err == sl.ERROR_CODE.END_OF_SVOFILE_REACHED:
            self.cam.set_svo_position(0)
            return None
        if err != sl.ERROR_CODE.SUCCESS:
            return None
        self.cam.retrieve_image(self.image, sl.VIEW.LEFT, sl.MEM.CPU, sl.Resolution(IMG_W, IMG_H))
        self.cam.retrieve_measure(self.depth, sl.MEASURE.DEPTH, sl.MEM.CPU, sl.Resolution(*self.depth_size))
        bgr = self.image.get_data()[:, :, :3]  # BGRA -> BGR
        return bgr, self.depth.get_data()

    def close(self):
        self.cam.close()


def find_scenes(args):
    """Scene name -> function(depth_settings) that opens it, from the command-line arguments."""
    paths = []
    for arg in (a for a in args if not a.startswith("--")):
        paths += sorted(glob.glob(arg)) or [arg]  # PowerShell doesn't expand wildcards itself
    if not paths and "--live" not in args:
        paths = sorted(str(p) for p in Path(__file__).parent.glob("*.svo"))
    scenes = {Path(p).stem: (lambda settings, p=p: ZedSource(p, settings)) for p in paths}
    if "--live" in args or not scenes:
        scenes = {"Live camera": lambda settings: ZedSource(None, settings), **scenes}
    return scenes


async def main():
    scenes = find_scenes(sys.argv[1:])
    print("Scenes:", ", ".join(scenes))
    scene = next(iter(scenes))
    depth_settings = dict(DEPTH_SETTINGS)
    detection_settings = dict(DETECTION_SETTINGS)
    detection_error = None  # why detection couldn't start, if it couldn't

    def open_source(name, settings):
        nonlocal detection_error
        opened = scenes[name](settings)
        detection_error = opened.set_detection(detection_settings)
        if detection_error:
            print(f"Object detection unavailable: {detection_error}")
        return opened

    source = open_source(scene, depth_settings)
    try:
        matting = Matting()
    except RuntimeError as e:
        print(f"People matting unavailable: {e}")
        matting = None
    matting_settings = dict(MATTING_SETTINGS)

    def make_info():
        depth_w, depth_h = source.depth_size
        return json.dumps(dict(
            width=IMG_W, height=IMG_H, depthWidth=depth_w, depthHeight=depth_h, **source.intrinsics,
            scenes=list(scenes), scene=scene, depth=depth_settings,
            matting=dict(available=matting is not None, **matting_settings),
            detection=dict(error=detection_error, **detection_settings),
        ))

    info = make_info()
    clients = set()
    playback = dict(playing=True, speed=1.0)
    # Changes asked by the page, applied between frames by the main loop.
    requested_scene = None
    requested_depth = None
    requested_detection = None

    async def handler(ws):
        nonlocal requested_scene, requested_depth, requested_detection, matting_settings, info
        # Queued without waiting, like the frames: awaiting a send waits for the connection to
        # drain, which the frames broadcast meanwhile can keep from ever happening, and then this
        # handler would never read the page's messages. The page gets the info before any frame.
        websockets.broadcast([ws], info)
        clients.add(ws)
        try:
            async for message in ws:
                msg = json.loads(message)
                if msg.get("type") == "control":
                    playback["playing"] = bool(msg.get("playing", True))
                    playback["speed"] = min(max(float(msg.get("speed", 1.0)), 0.05), 4.0)
                elif msg.get("type") == "scene" and msg.get("name") in scenes:
                    requested_scene = msg["name"]
                elif msg.get("type") == "depth":
                    requested_depth = update_depth_settings(
                        requested_depth or depth_settings, msg.get("settings", {})
                    )
                elif msg.get("type") == "matting":
                    matting_settings = update_matting_settings(matting_settings, msg.get("settings", {}))
                    send_info()
                elif msg.get("type") == "detection":
                    requested_detection = update_detection_settings(
                        requested_detection or detection_settings, msg.get("settings", {})
                    )
        finally:
            clients.discard(ws)

    matting_time = 0.0  # seconds spent matting, since the last stats

    def send_frame(frame):
        nonlocal matting_time
        if frame:
            bgr, depth_m = frame
            # Detection itself runs in grab(); this only reads its results.
            objects = source.detect()
            matte = None
            if matting and matting_settings["enabled"]:
                start = time.perf_counter()
                size = MATTING_INPUTS[matting_settings["input"]]
                small = bgr if size == (IMG_W, IMG_H) else cv2.resize(bgr, size, interpolation=cv2.INTER_AREA)
                matte = matting.run(small, matting_settings["ratio"])
                if size != (IMG_W, IMG_H):
                    matte = cv2.resize(matte, (IMG_W, IMG_H), interpolation=cv2.INTER_LINEAR)
                matting_time += time.perf_counter() - start
            message = encode_frame(bgr, depth_m, matte, objects)
            # Skip pages that haven't taken the previous frame yet (e.g. a hidden tab):
            # queuing frames for them slows the bridge down for everyone.
            ready = [ws for ws in clients if ws.transport.get_write_buffer_size() < len(message)]
            websockets.broadcast(ready, message)

    def send_info():
        nonlocal info
        info = make_info()
        websockets.broadcast(clients, info)

    # No per-message compression: it's on by default, and deflating every frame cost about
    # 25 ms on this thread, for data that barely compresses (JPEG, noisy depth).
    async with websockets.serve(handler, "localhost", PORT, max_size=None, compression=None):
        print(f"Streaming {scene} on ws://localhost:{PORT}")
        frames, work, stats_start = 0, 0.0, time.perf_counter()
        next_frame = time.perf_counter()
        while True:
            if requested_scene is not None or requested_depth is not None:
                name = requested_scene or scene
                settings = requested_depth or depth_settings
                requested_scene = requested_depth = None
                reopen = name != scene or any(settings[k] != depth_settings[k] for k in REOPEN_SETTINGS)
                if reopen:
                    print(f"Opening {name} ({settings['mode']}, stabilization {settings['stabilization']})...")
                    # Same scene: come back to the same frame, to compare settings.
                    position = source.svo_position() if name == scene else None
                    source.close()
                    try:
                        source, scene, depth_settings = open_source(name, settings), name, settings
                    except RuntimeError as e:
                        print(e)
                        source = open_source(scene, depth_settings)  # fall back to what we had
                    source.seek(position)
                    if matting:
                        matting.reset()
                else:
                    source.set_depth_settings(settings)
                    depth_settings = settings
                # New intrinsics or depth size: the page re-aligns its camera and resizes its textures.
                send_info()
                send_frame(source.regrab())  # show the change right away, even when paused
                next_frame = time.perf_counter()
                await asyncio.sleep(0)

            if requested_detection is not None:
                detection_settings, requested_detection = requested_detection, None
                if detection_settings["enabled"] and detection_settings["model"] != source.detection_model:
                    print(f"Enabling object detection ({detection_settings['model']})...")
                detection_error = source.set_detection(detection_settings)
                if detection_error:
                    print(f"Object detection unavailable: {detection_error}")
                send_info()
                send_frame(source.regrab())
                next_frame = time.perf_counter()
                await asyncio.sleep(0)

            if not playback["playing"]:
                await asyncio.sleep(0.05)
                next_frame = time.perf_counter()
                continue
            start = time.perf_counter()
            # Grabbing on the event-loop thread is deliberate: from a worker thread,
            # pyzed ran about 40% slower here. Messages are handled between frames.
            frame = source.grab()
            send_frame(frame)
            await asyncio.sleep(0)  # let the event loop send frames and read messages

            frames += 1
            work += time.perf_counter() - start
            if time.perf_counter() - stats_start >= 5:
                elapsed = time.perf_counter() - stats_start
                print(
                    f"{frames / elapsed:.1f} fps sent, {work / frames * 1000:.0f} ms per frame of work"
                    f" (matting {matting_time / frames * 1000:.0f} ms)"
                )
                frames, work, stats_start = 0, 0.0, time.perf_counter()
                matting_time = 0.0

            if source.fps:
                # Pace against a fixed schedule rather than sleeping "the rest of this frame":
                # Windows sleeps overshoot by up to ~15 ms, and the schedule absorbs that.
                # If depth computation is slower than the schedule, playback runs as fast as it can.
                period = 1 / (source.fps * playback["speed"])
                next_frame += period
                now = time.perf_counter()
                if next_frame > now:
                    await asyncio.sleep(next_frame - now)
                elif now - next_frame > period:
                    next_frame = now  # too far behind: don't try to catch up in a burst


if __name__ == "__main__":
    asyncio.run(main())
