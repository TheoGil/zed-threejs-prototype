"""ZED -> WebSocket bridge.

Grabs the left color image + depth map from a ZED camera (or an .svo recording)
and streams them to the browser. The page can switch between scenes.

    python bridge.py                      # every .svo next to this script (live camera if none)
    python bridge.py a.svo b.svo          # these recordings (wildcards like *.svo work)
    python bridge.py --live               # add the live camera to the scenes

Protocol (ws://localhost:8765):
  1. On connect, and again after each scene switch or depth settings change, one JSON
     text message with the image and depth sizes, intrinsics, the list of scenes, the
     current scene and the depth settings.
  2. Then one binary message per frame:
       [depth: depthWidth*depthHeight uint16 little-endian, millimeters, 0 = invalid]
       [color: JPEG bytes, until end of message]
  Browser -> bridge:
     {"type": "control", "playing": bool, "speed": float}
       (speed only applies to SVO sources; a live camera runs at its own rate)
     {"type": "scene", "name": str}
     {"type": "depth", "settings": {...}}   any subset of DEPTH_SETTINGS
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


def encode_frame(bgr, depth_m):
    """bgr: HxWx3 uint8, depth_m: float32 meters (NaN/inf = invalid)."""
    mm = np.nan_to_num(depth_m, nan=0.0, posinf=0.0, neginf=0.0) * 1000.0
    mm = np.clip(mm, 0, 65535).astype("<u2")
    ok, jpeg = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return mm.tobytes() + jpeg.tobytes()


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
        return encode_frame(bgr, self.depth.get_data())

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

    def make_info():
        depth_w, depth_h = source.depth_size
        return json.dumps(dict(
            width=IMG_W, height=IMG_H, depthWidth=depth_w, depthHeight=depth_h, **source.intrinsics,
            scenes=list(scenes), scene=scene, depth=depth_settings,
        ))

    info = make_info()
    clients = set()
    playback = dict(playing=True, speed=1.0)
    # Changes asked by the page, applied between frames by the main loop.
    requested_scene = None
    requested_depth = None

    async def handler(ws):
        nonlocal requested_scene, requested_depth
        clients.add(ws)
        try:
            await ws.send(info)
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
        finally:
            clients.discard(ws)

    def send_frame(frame):
        if frame:
            # Skip pages that haven't taken the previous frame yet (e.g. a hidden tab):
            # queuing frames for them slows the bridge down for everyone.
            ready = [ws for ws in clients if ws.transport.get_write_buffer_size() < len(frame)]
            websockets.broadcast(ready, frame)

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
                        source, scene, depth_settings = scenes[name](settings), name, settings
                    except RuntimeError as e:
                        print(e)
                        source = scenes[scene](depth_settings)  # fall back to what we had
                    source.seek(position)
                else:
                    source.set_depth_settings(settings)
                    depth_settings = settings
                # New intrinsics or depth size: the page re-aligns its camera and resizes its textures.
                info = make_info()
                websockets.broadcast(clients, info)
                send_frame(source.regrab())  # show the change right away, even when paused
                next_frame = time.perf_counter()
                await asyncio.sleep(0)

            if not playback["playing"]:
                await asyncio.sleep(0.05)
                next_frame = time.perf_counter()
                continue
            start = time.perf_counter()
            # Grabbing on the event-loop thread is deliberate: from a worker thread,
            # pyzed ran about 40% slower here. Messages are handled between frames.
            send_frame(source.grab())
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
