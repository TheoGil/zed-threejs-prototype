# ZED + three.js occlusion prototype

A ZED 2 streams color + depth to the browser. three.js draws the video as a
background and renders 3D content on top. Any fragment that is farther away than
the real-world depth at that pixel is discarded, so people walk *in front of*
virtual objects.

```
ZED / .svo ──► bridge.py (pyzed) ──ws://localhost:8765──► web/ (three.js + tweakpane, served by Vite)
```

## Files

- `bridge.py`: grabs the left image (1280×720 JPEG) and depth (640×360, uint16 mm). It sends the intrinsics and the list of scenes on connect, and again after each scene switch.
- `web/src/` (TypeScript), one class per feature. `App` creates and wires the others.
  - `App.ts`: the renderer, the render loop, and the canvas size.
  - `Bridge.ts`: the WebSocket to `bridge.py`, the protocol types, and the playback controls (play, speed, scene).
  - `Feed.ts`: the latest frame as textures (video, and depth in meters), plus `sampleDepth()`.
  - `ZedCamera.ts`: a three.js camera whose projection is built from the ZED intrinsics.
  - `Occlusion.ts`: `apply(material)` adds the depth test to any built-in material.
  - `DepthView.ts`: the *Depth only* colormap view.
  - `Recordings.ts`: one `THREE.Scene` per recording, and loading `default-planes.json`.
  - `Plane.ts`: one plane, with its mesh, its gizmo and its controls.
  - `PlaneTool.ts`: placing planes with 4 clicks, and the keyboard shortcuts.
  - `Debug.ts`: the Tweakpane pane and the Stats panel. Set `SHOW_DEBUG` to `false` to hide all controls.
  - `Status.ts`: the status line at the bottom-left.
- `web/public/default-planes.json`: the planes created on load, per recording (see Planes below).
- `vite.config.ts`: Vite serves `web/` on port 8000. `yarn typecheck` runs the TypeScript checker.

## Setup (once)

1. Install the **ZED SDK** for Windows (it installs CUDA if needed). Update the NVIDIA driver first.
2. Create the venv and install the Python dependencies:
   ```
   py -3.10 -m venv .venv
   .venv\Scripts\python -m pip install -r requirements.txt
   ```
   If pip fails with `CERTIFICATE_VERIFY_FAILED` (HTTPS inspection on this machine), download the wheels with the newer system pip, then install offline:
   ```
   py -3.14 -m pip download --python-version 3.10 --only-binary=:all: --platform win_amd64 -d wheels -r requirements.txt
   .venv\Scripts\python -m pip install --no-index --find-links wheels -r requirements.txt
   ```
3. Install `pyzed` into the venv using the script that ships with the SDK:
   ```
   .venv\Scripts\python "C:\Program Files (x86)\ZED SDK\get_python_api.py"
   ```
   If that fails (it needs `requests` and internet access through pip), do its steps by hand. Example for SDK 5.5 and Python 3.10:
   ```
   curl.exe -L -o pyzed.whl https://download.stereolabs.com/zedsdk/5.5/whl/win_amd64/pyzed-5.5-cp310-cp310-win_amd64.whl
   .venv\Scripts\python -m pip install --no-deps pyzed.whl
   copy "C:\Program Files (x86)\ZED SDK\bin\sl_ai64.dll" .venv\Lib\site-packages\pyzed\
   copy "C:\Program Files (x86)\ZED SDK\bin\sl_zed64.dll" .venv\Lib\site-packages\pyzed\
   ```
   Repeat this after every ZED SDK update.
4. Install the web dependencies with Yarn (Node.js 20.19+ or 22.12+):
   ```
   yarn
   ```

The first run with NEURAL depth downloads the AI model and optimizes it for the GPU,
which takes a few minutes. Later runs start in seconds.

## Run

```
.venv\Scripts\python bridge.py      # every .svo in this folder, switchable from the page
yarn dev                            # Vite dev server for web/, reloads the page on edits
```

Other ways to start the bridge: `bridge.py a.svo b.svo` (only these; wildcards like `*.svo` work),
`--live` (adds the live camera). With no `.svo` in the folder,
it opens the live camera.

Open http://localhost:8000. If the 3D content looks stretched or shifted, check
that the browser runs on the NVIDIA GPU (Windows Graphics settings → High performance).
To use a bridge on another address or port, add `?ws=ws://host:port` to the page URL.

## Controls

- **Video**: scene (switches the recording; takes a second or two, and the camera re-aligns to that recording's calibration),
  play/pause, playback speed (SVO only: the bridge paces playback, and a live camera runs at its own rate),
  and the view: *Composite* (the final render) or *Depth only* (a depth colormap: red is near, blue is far, black has no depth).
- **Planes**: planes belong to a recording. Each recording has its own `THREE.Scene` and its own folder
  here; only the current recording's scene is rendered and only its folder is shown.
  Inside it there's one section per plane, with color, alpha, thickness and Remove. Thickness grows from the surface toward the camera.
  - Every change logs the plane's definition to the browser console, labelled with its recording. Paste it into
    `web/public/default-planes.json`, under that recording's name, to have the plane created on load. The Unity prototype
    (`../zed-unity-prototype`) reads the same file.
  - **edit** shows a TransformControls gizmo on the plane, for one plane at a time. A new plane starts in edit mode.
    The gizmo moves the whole plane, so it always stays a rectangle.
  - **mode**: *Move* (`W`) slides it along its own axes. *Rotate* (`E`) turns it with the rings, or freely
    (trackball style) by dragging inside the rings, away from any of them.
  - **Reset position** puts it back where it was fitted.

The bridge prints the fps it actually sends every 5 s. At 1× it should match the recording's frame rate (15 fps for the runners SVO).

## Placing planes

Click 4 corners in order around the outline of a rectangle, either clockwise or counter-clockwise. Each click
is lifted to 3D using the depth at that pixel (the median of a small neighborhood). The plane
is a true rectangle fitted to the 4 points: its center is their average, its sides follow the clicked edges, and
its width and height are the averages of the opposite edges. Press `Esc` to cancel the current corners.
Clicks where the ZED has no depth (sky, reflections, very close or far) are ignored.

## Coordinates

Everything is in the ZED left camera's frame: meters, right-handed, Y up, looking down **-Z**
(the same as three.js). The cube starts at `(0, 0, -2.5)`, which is 2.5 m in front of the lens.
Your sensor's points and boxes need to be transformed into this frame, using the sensor-to-camera calibration.
