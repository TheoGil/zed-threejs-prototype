import type { BladeApi, FolderApi } from "tweakpane";
import type { Debug } from "./Debug";
import type { Status } from "./Status";
import type { DepthSettings } from "./ZedSettings";

// The bridge's address; override with ?ws=ws://host:port in the page URL.
const WS_URL =
  new URLSearchParams(location.search).get("ws") ?? "ws://localhost:8765";

// Sent by the bridge on connect and after each scene switch, depth settings change or
// background capture (see bridge.py).
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
  depth: DepthSettings; // the ZED SDK settings the depth is computed with
  background: BackgroundInfo | null; // the scene's captured background, if any
}

export interface BackgroundInfo {
  depthWidth: number; // its depth map size, in pixels
  depthHeight: number;
  capturedAt: string; // local time, ISO 8601
  frames: number; // how many frames its median was taken over
}

export interface Frame {
  image: HTMLImageElement;
  depthMm: Uint16Array; // depthWidth * depthHeight, millimeters, 0 = invalid
}

interface Handlers {
  onInfo: (info: StreamInfo) => void;
  onFrame: (frame: Frame) => void;
  onBackground: (background: Frame) => void; // sent after an info whose `background` describes it
}

// Binary message kinds: the first byte of their 2-byte header.
const FRAME = 0;
const BACKGROUND = 1;
const HEADER_BYTES = 2;

// The connection to bridge.py. Receives the stream info, the frames and the background,
// and sends play/pause, speed, scene switches and the other modules' requests. Playback is driven by the bridge; the page
// only tells it what it wants.
export class Bridge {
  info: StreamInfo | null = null;
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
      const playButton = this.ui.addButton({ title: "Pause" });
      playButton.on("click", () => {
        this.playback.playing = !this.playback.playing;
        playButton.title = this.playback.playing ? "Pause" : "Play";
        this.sendControl();
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
      if (typeof e.data === "string") this.onInfo(JSON.parse(e.data));
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
    const info = this.info!;
    if (kind === BACKGROUND && info.background) {
      const { depthWidth, depthHeight } = info.background;
      const background = await decode(buffer, depthWidth, depthHeight);
      if (background) this.handlers.onBackground(background);
    } else if (kind === FRAME) {
      if (this.decoding) return; // drop frames rather than queue them up
      this.decoding = true;
      const frame = await decode(buffer, info.depthWidth, info.depthHeight);
      this.decoding = false;
      if (!frame) return;
      this.handlers.onFrame(frame);
      this.frames++;
    }
  }

  private updateStatus() {
    if (this.waiting) this.status.set(this.waiting);
    else if (this.info)
      this.status.set(this.playback.playing ? `${this.frames} fps` : "paused");
    this.frames = 0;
  }
}

// A frame or background message: [header][depth: uint16 mm][color: JPEG]. null if the JPEG is broken.
async function decode(buffer: ArrayBuffer, depthWidth: number, depthHeight: number): Promise<Frame | null> {
  const depthCount = depthWidth * depthHeight;
  const depthMm = new Uint16Array(buffer, HEADER_BYTES, depthCount);
  const jpeg = new Blob([new Uint8Array(buffer, HEADER_BYTES + depthCount * 2)], { type: "image/jpeg" });
  const url = URL.createObjectURL(jpeg);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { image, depthMm };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
