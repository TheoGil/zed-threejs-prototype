"""ZED -> WebSocket bridge.

Grabs the left color image + depth map from a ZED camera (or an .svo recording)
and streams them to the browser. The page can switch between scenes.

    python bridge.py                      # every .svo next to this script (live camera if none)
    python bridge.py a.svo b.svo          # these recordings (wildcards like *.svo work)
    python bridge.py --live               # add the live camera to the scenes

Protocol (ws://localhost:8765):
  1. On connect, and again after each scene switch, one JSON text message with the
     image size, intrinsics, the list of scenes and the current scene.
  2. Then one binary message per frame:
       [depth: depthWidth*depthHeight uint16 little-endian, millimeters, 0 = invalid]
       [color: JPEG bytes, until end of message]
  Browser -> bridge:
     {"type": "control", "playing": bool, "speed": float}
       (speed only applies to SVO sources; a live camera runs at its own rate)
     {"type": "scene", "name": str}
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
DEPTH_W, DEPTH_H = 640, 360
JPEG_QUALITY = 85


def encode_frame(bgr, depth_m):
    """bgr: HxWx3 uint8, depth_m: float32 meters (NaN/inf = invalid)."""
    mm = np.nan_to_num(depth_m, nan=0.0, posinf=0.0, neginf=0.0) * 1000.0
    mm = np.clip(mm, 0, 65535).astype("<u2")
    ok, jpeg = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return mm.tobytes() + jpeg.tobytes()


class ZedSource:
    def __init__(self, svo_path=None):
        import pyzed.sl as sl

        self.sl = sl
        init = sl.InitParameters()
        if svo_path:
            init.set_from_svo_file(svo_path)
            init.svo_real_time_mode = False  # we pace playback ourselves, see main()
        init.depth_mode = sl.DEPTH_MODE.NEURAL  # use PERFORMANCE if too slow
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

    def grab(self):
        sl = self.sl
        err = self.cam.grab(self.runtime)
        if err == sl.ERROR_CODE.END_OF_SVOFILE_REACHED:
            self.cam.set_svo_position(0)
            return None
        if err != sl.ERROR_CODE.SUCCESS:
            return None
        self.cam.retrieve_image(self.image, sl.VIEW.LEFT, sl.MEM.CPU, sl.Resolution(IMG_W, IMG_H))
        self.cam.retrieve_measure(self.depth, sl.MEASURE.DEPTH, sl.MEM.CPU, sl.Resolution(DEPTH_W, DEPTH_H))
        bgr = self.image.get_data()[:, :, :3]  # BGRA -> BGR
        return encode_frame(bgr, self.depth.get_data())

    def close(self):
        self.cam.close()


def find_scenes(args):
    """Scene name -> function that opens it, from the command-line arguments."""
    paths = []
    for arg in (a for a in args if not a.startswith("--")):
        paths += sorted(glob.glob(arg)) or [arg]  # PowerShell doesn't expand wildcards itself
    if not paths and "--live" not in args:
        paths = sorted(str(p) for p in Path(__file__).parent.glob("*.svo"))
    scenes = {Path(p).stem: (lambda p=p: ZedSource(p)) for p in paths}
    if "--live" in args or not scenes:
        scenes = {"Live camera": ZedSource, **scenes}
    return scenes


async def main():
    scenes = find_scenes(sys.argv[1:])
    print("Scenes:", ", ".join(scenes))
    scene = next(iter(scenes))
    source = scenes[scene]()

    def make_info():
        return json.dumps(dict(
            width=IMG_W, height=IMG_H, depthWidth=DEPTH_W, depthHeight=DEPTH_H, **source.intrinsics,
            scenes=list(scenes), scene=scene,
        ))

    info = make_info()
    clients = set()
    playback = dict(playing=True, speed=1.0)
    requested_scene = None

    async def handler(ws):
        nonlocal requested_scene
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
        finally:
            clients.discard(ws)

    def send_frame(frame):
        if frame:
            # Skip pages that haven't taken the previous frame yet (e.g. a hidden tab):
            # queuing frames for them slows the bridge down for everyone.
            ready = [ws for ws in clients if ws.transport.get_write_buffer_size() < len(frame)]
            websockets.broadcast(ready, frame)

    async with websockets.serve(handler, "localhost", PORT, max_size=None):
        print(f"Streaming {scene} on ws://localhost:{PORT}")
        frames, work, stats_start = 0, 0.0, time.perf_counter()
        next_frame = time.perf_counter()
        while True:
            if requested_scene is not None:
                name, requested_scene = requested_scene, None
                if name != scene:
                    print(f"Switching to {name}...")
                    previous = scene
                    source.close()
                    try:
                        source, scene = scenes[name](), name
                    except RuntimeError as e:
                        print(e)
                        source = scenes[previous]()  # fall back to the scene we had
                    info = make_info()
                    websockets.broadcast(clients, info)  # new intrinsics: the page re-aligns its camera
                    send_frame(source.grab())  # show the new scene right away, even when paused
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
