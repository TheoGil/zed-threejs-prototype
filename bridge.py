"""ZED -> WebSocket bridge.

Grabs the left color image + depth map from a ZED camera (or an .svo recording)
and streams them to the browser. The page can switch between scenes.

    python bridge.py                      # every .svo next to this script (live camera if none)
    python bridge.py a.svo b.svo          # these recordings (wildcards like *.svo work)
    python bridge.py --live               # add the live camera to the scenes

Protocol (ws://localhost:8765):
  1. On connect, and again after each scene switch, depth or matting settings change or
     background capture, one JSON text message with the image and depth sizes, intrinsics,
     the list of scenes, the current scene, the depth and matting settings and the
     background's description.
  2. Binary messages, each starting with a 2-byte header [kind, flags]:
       kind 0, a frame (one per frame):
         [depth: depthWidth*depthHeight uint16 little-endian, millimeters,
                 0 = unknown, 65535 = too far (beyond the ZED's range)]
         if flags & HAS_MATTE: [matte length: uint32 little-endian]
                               [people's alpha matte: grayscale JPEG, video size, 255 = person]
         [color: JPEG bytes, until end of message]
       kind 1, the scene's background, same layout (never with a matte), with the size given
         by the info's "background". Sent on connect, after a scene switch and after a capture.
  Browser -> bridge:
     {"type": "control", "playing": bool, "speed": float}
       (speed only applies to SVO sources; a live camera runs at its own rate)
     {"type": "scene", "name": str}
     {"type": "depth", "settings": {...}}   any subset of DEPTH_SETTINGS
     {"type": "capture", "seconds": float}  capture the background from the next frames
     {"type": "matting", "settings": {...}}  any subset of MATTING_SETTINGS
"""

import asyncio
import glob
import json
import re
import sys
import time
from datetime import datetime
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

# Binary message kinds (the first byte of the 2-byte header), and flags (the second).
FRAME, BACKGROUND = 0, 1
HAS_MATTE = 1
# Depth beyond the ZED's range (+inf from the SDK), sent as the largest uint16: "nothing within
# range here" never occludes, unlike an unknown pixel (0). The page reads it as 65.535 m.
TOO_FAR_MM = 65535

# Background capture: the median of up to this many frames, spread over the capture.
# A pixel needs valid depth in this share of them, or its background depth is unknown (0).
MAX_BACKGROUND_FRAMES = 50
MIN_VALID_SHARE = 0.25
BACKGROUND_DIR = Path(__file__).parent / "backgrounds"


def encode_frame(kind, bgr, depth_m, matte=None):
    """kind: FRAME or BACKGROUND, bgr: HxWx3 uint8, depth_m: float32 meters
    (+inf = too far, NaN/-inf/0 = unknown), matte: HxW uint8 or None."""
    mm = np.nan_to_num(depth_m, nan=0.0, posinf=TOO_FAR_MM / 1000, neginf=0.0) * 1000.0
    mm = np.clip(mm, 0, TOO_FAR_MM).astype("<u2")
    ok, jpeg = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    # 2 bytes keep the depth aligned for a Uint16Array on the page.
    if matte is None:
        return bytes([kind, 0]) + mm.tobytes() + jpeg.tobytes()
    # A grayscale JPEG: a few dozen KB instead of about 900 KB raw, without the cost of compressing it losslessly.
    ok, matte_jpeg = cv2.imencode(".jpg", matte, [cv2.IMWRITE_JPEG_QUALITY, MATTE_JPEG_QUALITY])
    length = len(matte_jpeg).to_bytes(4, "little")
    return bytes([kind, HAS_MATTE]) + mm.tobytes() + length + matte_jpeg.tobytes() + jpeg.tobytes()


class Capture:
    """The frames kept over `seconds` of streaming, to compute a background from."""

    def __init__(self, seconds, fps):
        self.end = time.perf_counter() + seconds
        # Keep every `stride`-th frame, so the frames kept span the whole capture.
        self.stride = max(1, round(seconds * (fps or 30) / MAX_BACKGROUND_FRAMES))
        self.count = 0
        self.images, self.depths = [], []

    def add(self, bgr, depth_m):
        if self.count % self.stride == 0:
            self.images.append(bgr.copy())  # grab() returns views into buffers it reuses
            self.depths.append(depth_m.copy())
        self.count += 1

    def done(self):
        return time.perf_counter() >= self.end or len(self.depths) >= MAX_BACKGROUND_FRAMES


class Background:
    """A scene's empty set: the per-pixel median of a capture's depth and color.
    Saved in backgrounds/, and loaded again when the scene opens."""

    def __init__(self, bgr, depth_m, captured_at, frames):
        self.bgr, self.depth_m, self.captured_at, self.frames = bgr, depth_m, captured_at, frames

    @classmethod
    def from_capture(cls, capture):
        # "Too far" is a valid value here: a pixel beyond range most of the time has a far background.
        depths = np.stack(capture.depths)
        depths[np.isposinf(depths)] = TOO_FAR_MM / 1000
        valid = np.isfinite(depths) & (depths > 0)
        # Median of the valid values only: unknown ones sort last, as +inf.
        depths = np.where(valid, depths, np.inf)
        depths.sort(axis=0)
        count = valid.sum(axis=0)
        middle = np.maximum((count - 1) // 2, 0)
        depth_m = np.take_along_axis(depths, middle[None], axis=0)[0]
        depth_m[count < len(capture.depths) * MIN_VALID_SHARE] = 0  # too rarely seen: unknown
        images = np.stack(capture.images)
        half = len(images) // 2
        bgr = np.partition(images, half, axis=0)[half]
        captured_at = datetime.now().isoformat(timespec="seconds")
        return cls(bgr, depth_m.astype(np.float32), captured_at, len(images))

    @staticmethod
    def path(scene):
        return BACKGROUND_DIR / (re.sub(r"[^\w.-]", "_", scene) + ".npz")

    @classmethod
    def load(cls, scene):
        path = cls.path(scene)
        if not path.exists():
            return None
        data = np.load(path)
        return cls(data["bgr"], data["depth_m"], str(data["captured_at"]), int(data["frames"]))

    def save(self, scene):
        BACKGROUND_DIR.mkdir(exist_ok=True)
        np.savez_compressed(
            self.path(scene), bgr=self.bgr, depth_m=self.depth_m,
            captured_at=self.captured_at, frames=self.frames,
        )

    def info(self):
        height, width = self.depth_m.shape
        return dict(depthWidth=width, depthHeight=height, capturedAt=self.captured_at, frames=self.frames)

    def message(self):
        return encode_frame(BACKGROUND, self.bgr, self.depth_m)


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
        self.image = sl.Mat()
        self.depth = sl.Mat()
        self.set_depth_settings(depth_settings)

    def set_depth_settings(self, settings):
        """Applies the settings that don't need a reopen, from the next grab."""
        self.runtime.confidence_threshold = settings["confidence"]
        self.runtime.texture_confidence_threshold = settings["textureConfidence"]
        self.runtime.enable_fill_mode = settings["fill"]
        self.runtime.remove_saturated_areas = settings["removeSaturated"]
        self.depth_size = DEPTH_RESOLUTIONS[settings["resolution"]]

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
    source = scenes[scene](depth_settings)
    background = Background.load(scene)
    capture = None
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
            background=background.info() if background else None,
            matting=dict(available=matting is not None, **matting_settings),
        ))

    info = make_info()
    clients = set()
    playback = dict(playing=True, speed=1.0)
    # Changes asked by the page, applied between frames by the main loop.
    requested_scene = None
    requested_depth = None
    requested_capture = None  # seconds

    async def handler(ws):
        nonlocal requested_scene, requested_depth, requested_capture, matting_settings, info
        # Queued without waiting, like the frames: awaiting a send waits for the connection to
        # drain, which the frames broadcast meanwhile can keep from ever happening, and then this
        # handler would never read the page's messages. The page gets the info before any frame.
        websockets.broadcast([ws], info)
        if background:
            websockets.broadcast([ws], background.message())
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
                elif msg.get("type") == "capture":
                    requested_capture = min(max(float(msg.get("seconds", 5)), 0.5), 30)
                elif msg.get("type") == "matting":
                    matting_settings = update_matting_settings(matting_settings, msg.get("settings", {}))
                    info = make_info()
                    websockets.broadcast(clients, info)
        finally:
            clients.discard(ws)

    def send_frame(frame):
        if frame:
            bgr, depth_m = frame
            matte = None
            if matting and matting_settings["enabled"]:
                size = MATTING_INPUTS[matting_settings["input"]]
                small = bgr if size == (IMG_W, IMG_H) else cv2.resize(bgr, size, interpolation=cv2.INTER_AREA)
                matte = matting.run(small, matting_settings["ratio"])
                if size != (IMG_W, IMG_H):
                    matte = cv2.resize(matte, (IMG_W, IMG_H), interpolation=cv2.INTER_LINEAR)
            message = encode_frame(FRAME, bgr, depth_m, matte)
            # Skip pages that haven't taken the previous frame yet (e.g. a hidden tab):
            # queuing frames for them slows the bridge down for everyone.
            ready = [ws for ws in clients if ws.transport.get_write_buffer_size() < len(message)]
            websockets.broadcast(ready, message)

    def send_info():
        nonlocal info
        info = make_info()
        websockets.broadcast(clients, info)
        if background:
            websockets.broadcast(clients, background.message())

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
                if capture:
                    print("Background capture cancelled: the scene or depth settings changed.")
                    capture = None
                if reopen:
                    print(f"Opening {name} ({settings['mode']}, stabilization {settings['stabilization']})...")
                    # Same scene: come back to the same frame, to compare settings.
                    position = source.svo_position() if name == scene else None
                    source.close()
                    try:
                        source, scene, depth_settings = scenes[name](settings), name, settings
                    except RuntimeError as e:
                        print(e)
                        source = scenes[scene](depth_settings)  # fall back to what we had
                    source.seek(position)
                    background = Background.load(scene)
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

            if requested_capture is not None:
                print(f"Capturing the background over {requested_capture:g} s...")
                capture, requested_capture = Capture(requested_capture, source.fps), None

            # A capture needs frames, so it plays even when paused.
            if not playback["playing"] and not capture:
                await asyncio.sleep(0.05)
                next_frame = time.perf_counter()
                continue
            start = time.perf_counter()
            # Grabbing on the event-loop thread is deliberate: from a worker thread,
            # pyzed ran about 40% slower here. Messages are handled between frames.
            frame = source.grab()
            send_frame(frame)
            if capture and frame:
                capture.add(*frame)
                if capture.done():
                    background = Background.from_capture(capture)
                    background.save(scene)
                    capture = None
                    print(f"Background captured ({background.frames} frames), saved to {Background.path(scene)}")
                    send_info()
            await asyncio.sleep(0)  # let the event loop send frames and read messages

            frames += 1
            work += time.perf_counter() - start
            if time.perf_counter() - stats_start >= 5:
                elapsed = time.perf_counter() - stats_start
                print(f"{frames / elapsed:.1f} fps sent, {work / frames * 1000:.0f} ms per frame of work")
                frames, work, stats_start = 0, 0.0, time.perf_counter()

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
