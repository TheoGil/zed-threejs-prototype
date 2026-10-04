import type { BladeApi, FolderApi } from "tweakpane";
import type { Debug } from "./Debug";
import type { Status } from "./Status";

// The bridge's address; override with ?ws=ws://host:port in the page URL.
const WS_URL =
  new URLSearchParams(location.search).get("ws") ?? "ws://localhost:8765";

// Sent by the bridge on connect and after each scene switch (see bridge.py).
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
}

export interface Frame {
  image: HTMLImageElement;
  depthMm: Uint16Array; // depthWidth * depthHeight, millimeters, 0 = invalid
}

interface Handlers {
  onInfo: (info: StreamInfo) => void;
  onFrame: (frame: Frame) => void;
}

// The connection to bridge.py. Receives the stream info and the frames, and sends
// play/pause, speed and scene switches. Playback is driven by the bridge; the page
// only tells it what it wants.
export class Bridge {
  info: StreamInfo | null = null;
  private readonly playback = { scene: "", playing: true, speed: 1 };
  private socket: WebSocket | null = null;
  private decoding = false;
  private frames = 0; // frames shown since the last status update
  private loadingScene: string | null = null;
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
    if (name === this.info?.scene || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "scene", name }));
    this.loadingScene = name;
    this.status.set(`loading ${name}…`);
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
      else if (this.info) this.onFrame(e.data);
    };
    socket.onclose = () => {
      this.status.set(`waiting for bridge on ${WS_URL}…`);
      setTimeout(() => this.connect(), 1000);
    };
  }

  private sendControl() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const { playing, speed } = this.playback;
    this.socket.send(JSON.stringify({ type: "control", playing, speed }));
  }

  private onInfo(info: StreamInfo) {
    this.info = info;
    this.loadingScene = null;
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

  private onFrame(buffer: ArrayBuffer) {
    if (this.decoding) return; // drop frames rather than queue them up
    this.decoding = true;

    const { depthWidth, depthHeight } = this.info!;
    const depthCount = depthWidth * depthHeight;
    const depthMm = new Uint16Array(buffer, 0, depthCount);
    const jpeg = new Blob([new Uint8Array(buffer, depthCount * 2)], {
      type: "image/jpeg",
    });

    const image = new Image();
    const url = URL.createObjectURL(jpeg);
    image.onload = () => {
      this.handlers.onFrame({ image, depthMm });
      URL.revokeObjectURL(url);
      this.decoding = false;
      this.frames++;
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      this.decoding = false;
    };
    image.src = url;
  }

  private updateStatus() {
    if (this.loadingScene) this.status.set(`loading ${this.loadingScene}…`);
    else if (this.info)
      this.status.set(this.playback.playing ? `${this.frames} fps` : "paused");
    this.frames = 0;
  }
}
