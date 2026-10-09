import type { BladeApi, ButtonApi, FolderApi } from "tweakpane";
import type { Debug } from "./Debug";
import type { DetectedObject, DetectionInfo } from "./Detections";
import type { MattingInfo } from "./People";
import type { Status } from "./Status";
import type { DepthSettings } from "./ZedSettings";

// The bridge's address; override with ?ws=ws://host:port in the page URL.
const WS_URL =
  new URLSearchParams(location.search).get("ws") ?? "ws://localhost:8765";

// Sent by the bridge on connect and after each scene switch or depth, matting or detection
// settings change (see bridge.py).
export interface StreamInfo {
  width: number; // color image size, in pixels
  height: number;
  depthWidth: number; // depth map size, in pixels
  depthHeight: number;
  fx: number; // intrinsics of the color image, in pixels
  fy: number;
  cx: number;
  cy: number;
  scenes: string[]; // every scene the bridge can play
  scene: string; // the one playing
  live: boolean; // it's the live camera
  fps: number | null; // its frame rate, null for a live camera
  depth: DepthSettings; // the ZED SDK settings the depth is computed with
  matting: MattingInfo; // people matting in the bridge
  detection: DetectionInfo; // ZED SDK object detection in the bridge
}

export interface Frame {
  position: number | null; // the frame's number in the SVO, null for a live camera
  image: HTMLImageElement;
  depthMm: Uint16Array; // depthWidth * depthHeight, millimeters, 0 = invalid
  matte: HTMLImageElement | null; // people's alpha matte, video size (white = person), when matting is on
  objects: DetectedObject[] | null; // the objects detected in this frame, when detection is on
  // The objects' masks, video size, when masks are on: each pixel's red is 1 + the index in
  // `objects` of the object there, over 255 (0 = none).
  objectMasks: HTMLImageElement | null;
}

// The floor the ZED SDK found, after a floor request (ZedSource.find_floor() in bridge.py), in
// meters in the camera's frame (the scene's).
export interface FloorPlane {
  normal: number[]; // unit, facing the camera
  center: number[];
  bounds: number[][]; // the outline of the floor seen
}

interface FloorMessage {
  type: "floor";
  plane: FloorPlane | null;
  error: string | null; // why no floor was found
}

interface Handlers {
  onInfo: (info: StreamInfo) => void;
  onFrame: (frame: Frame) => void;
  onPause: (position: number | null) => void; // the Pause button, with the frame shown
  onFloor: (plane: FloorPlane | null, error: string | null) => void; // the reply to a floor request
}

// Binary message kinds: the first byte of their header. Flags: the second byte. Then the frame's
// position in the SVO (uint32, NO_POSITION for a live camera).
const FRAME = 0;
const HAS_MATTE = 1;
const HAS_OBJECTS = 2;
const HAS_OBJECT_MASKS = 4;
const NO_POSITION = 0xffffffff;
const HEADER_BYTES = 6;

// The connection to bridge.py. Receives the stream info and the frames,
// and sends play/pause, speed, scene switches and the other modules' requests. Playback is driven by the bridge; the page
// only tells it what it wants.
export class Bridge {
  info: StreamInfo | null = null;
  readonly playButton: ButtonApi | null = null;
  private position: number | null = null; // of the last frame shown
  private readonly playback = { scene: "", playing: true, speed: 1 };
  private socket: WebSocket | null = null;
  private decoding = false;
  private frames = 0; // frames shown since the last status update
  private waiting: string | null = null; // status shown until the bridge's next info
  private readonly ui: FolderApi | null;
  private sceneBinding: BladeApi | null = null;
  private sceneList = "";

  constructor(
    private readonly handlers: Handlers,
    private readonly status: Status,
    debug: Debug,
  ) {
    this.ui = debug.folder("Video");
    if (this.ui) {
      this.playButton = this.ui.addButton({ title: "Pause" }).on("click", () => {
        if (this.playback.playing) this.handlers.onPause(this.pause());
        else this.play();
      });
      this.ui
        .addBinding(this.playback, "speed", { min: 0.1, max: 2, step: 0.05 })
        .on("change", () => this.sendControl());
    }

    this.connect();
    setInterval(() => this.updateStatus(), 1000);
  }

  requestScene(name: string) {
    if (name === this.info?.scene) return;
    if (this.send({ type: "scene", name })) this.waitForInfo(`loading ${name}…`);
  }

  // Pauses on SVO frame `position`, or by default on the frame shown: the bridge shows it again,
  // in case it had already sent the next one. Returns the frame paused on.
  pause(position = this.position): number | null {
    this.playback.playing = false;
    if (this.playButton) this.playButton.title = "Play";
    this.sendControl();
    if (position !== null) this.send({ type: "seek", position });
    return position;
  }

  private play() {
    this.playback.playing = true;
    if (this.playButton) this.playButton.title = "Pause";
    this.sendControl();
  }

  // Sends a message to the bridge; false if it isn't connected.
  send(message: object): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  // Shows `status` until the bridge sends its next info, which ends whatever it was doing.
  waitForInfo(status: string) {
    this.waiting = status;
    this.status.set(status);
  }

  private connect() {
    const socket = new WebSocket(WS_URL);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      this.status.set("connected");
      this.sendControl(); // the page is the source of truth for play/pause and speed
    };
    socket.onmessage = (e) => {
      if (typeof e.data === "string") {
        const message: StreamInfo | FloorMessage = JSON.parse(e.data);
        if ("type" in message) this.handlers.onFloor(message.plane, message.error);
        else this.onInfo(message);
      }
      else if (this.info) this.onBinary(e.data);
    };
    socket.onclose = () => {
      this.status.set(`waiting for bridge on ${WS_URL}…`);
      setTimeout(() => this.connect(), 1000);
    };
  }

  private sendControl() {
    const { playing, speed } = this.playback;
    this.send({ type: "control", playing, speed });
  }

  private onInfo(info: StreamInfo) {
    this.info = info;
    this.waiting = null;
    this.updateSceneDropdown(info);
    this.handlers.onInfo(info);
  }

  // The scene list comes from the bridge, so the dropdown is (re)built when it arrives.
  private updateSceneDropdown({ scenes, scene }: StreamInfo) {
    this.playback.scene = scene;
    if (!this.ui) return;
    if (JSON.stringify(scenes) === this.sceneList) {
      this.ui.refresh();
      return;
    }
    this.sceneList = JSON.stringify(scenes);
    this.sceneBinding?.dispose();
    this.sceneBinding = null;
    if (!scenes.length) return;
    this.sceneBinding = this.ui
      .addBinding(this.playback, "scene", {
        options: Object.fromEntries(scenes.map((name) => [name, name])),
        index: 0,
      })
      .on("change", (e) => this.requestScene(e.value));
  }

  private async onBinary(buffer: ArrayBuffer) {
    const kind = new Uint8Array(buffer, 0, 1)[0];
    if (kind !== FRAME || this.decoding) return; // drop frames rather than queue them up
    const info = this.info!;
    this.decoding = true;
    const frame = await decode(buffer, info.depthWidth, info.depthHeight);
    this.decoding = false;
    if (!frame) return;
    this.position = frame.position;
    this.handlers.onFrame(frame);
    this.frames++;
  }

  private updateStatus() {
    if (this.waiting) this.status.set(this.waiting);
    else if (this.info)
      this.status.set(this.playback.playing ? `${this.frames} fps` : "paused");
    this.frames = 0;
  }
}

// A frame message: [header][position: uint32][depth: uint16 mm]([objects length: uint32][objects: JSON])
// ([masks length: uint32][objects' masks: PNG])([matte length: uint32][matte: JPEG])[color: JPEG].
// null if an image is broken.
async function decode(buffer: ArrayBuffer, depthWidth: number, depthHeight: number): Promise<Frame | null> {
  const flags = new Uint8Array(buffer, 1, 1)[0];
  const position = new DataView(buffer, 2, 4).getUint32(0, true);
  let offset = HEADER_BYTES;
  const depthCount = depthWidth * depthHeight;
  const depthMm = new Uint16Array(buffer, offset, depthCount);
  offset += depthCount * 2;
  let objects: DetectedObject[] | null = null;
  if (flags & HAS_OBJECTS) {
    const length = new DataView(buffer, offset, 4).getUint32(0, true);
    objects = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 4, length)));
    offset += 4 + length;
  }
  let masksPng: Uint8Array<ArrayBuffer> | null = null;
  if (flags & HAS_OBJECT_MASKS) {
    const length = new DataView(buffer, offset, 4).getUint32(0, true);
    masksPng = new Uint8Array(buffer, offset + 4, length);
    offset += 4 + length;
  }
  let matteJpeg: Uint8Array<ArrayBuffer> | null = null;
  if (flags & HAS_MATTE) {
    const length = new DataView(buffer, offset, 4).getUint32(0, true);
    matteJpeg = new Uint8Array(buffer, offset + 4, length);
    offset += 4 + length;
  }
  try {
    const [image, matte, objectMasks] = await Promise.all([
      decodeImage(new Uint8Array(buffer, offset), "image/jpeg"),
      matteJpeg ? decodeImage(matteJpeg, "image/jpeg") : null,
      masksPng ? decodeImage(masksPng, "image/png") : null,
    ]);
    return { position: position === NO_POSITION ? null : position, image, depthMm, matte, objects, objectMasks };
  } catch {
    return null;
  }
}

async function decodeImage(bytes: Uint8Array<ArrayBuffer>, type: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
