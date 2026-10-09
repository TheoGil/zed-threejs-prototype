import type { BladeApi, FolderApi } from "tweakpane";
import type { Bridge } from "./Bridge";
import type { Debug } from "./Debug";

// The ZED SDK settings the bridge computes depth with (DEPTH_SETTINGS in bridge.py).
export interface DepthSettings {
  mode: "NEURAL_LIGHT" | "NEURAL" | "NEURAL_PLUS";
  stabilization: number; // 0-100
  confidence: number; // 1-100
  textureConfidence: number; // 1-100
  fill: boolean;
  removeSaturated: boolean;
  resolution: "640x360" | "1280x720";
  cameraResolution: keyof typeof CAMERA_FPS; // live camera only: what it captures
  cameraFps: number; // live camera only, one of CAMERA_FPS[cameraResolution]
}

// The ZED 2i's capture resolutions and the frame rates each allows (as in bridge.py).
const CAMERA_FPS = { HD2K: [15], HD1080: [15, 30], HD720: [15, 30, 60], VGA: [15, 30, 60, 100] };

// These only apply when the bridge reopens the camera: a second or two, back at the same frame.
const REOPEN: (keyof DepthSettings)[] = ["mode", "stabilization", "cameraResolution", "cameraFps"];

// The "ZED depth" controls, to change the bridge's depth settings live. The bridge owns
// the settings: the controls are built from the first info it sends, and follow the next ones.
// Each change is sent when a control is released; while paused, the bridge recomputes the same frame.
// The camera's resolution and frame rate are only shown for the live camera.
export class ZedSettings {
  private readonly ui: FolderApi | null;
  private settings: DepthSettings | null = null; // bound to the controls
  private applied: DepthSettings | null = null; // as last reported by the bridge
  private cameraResolution: BladeApi | null = null;
  private cameraFps: BladeApi | null = null; // rebuilt for each resolution: its options depend on it
  private fpsOptionsFor: string | null = null;

  constructor(
    private readonly bridge: Bridge,
    debug: Debug,
  ) {
    this.ui = debug.folder("ZED depth");
  }

  // Call with each info from the bridge. live: the scene playing is the live camera.
  sync(depth: DepthSettings, live: boolean) {
    this.applied = depth;
    if (!this.ui) return;
    if (this.settings) {
      Object.assign(this.settings, depth);
      this.ui.refresh();
    } else {
      this.settings = { ...depth };
      this.addControls(this.ui, this.settings);
    }
    this.updateCameraFps(this.ui, this.settings);
    this.cameraResolution!.hidden = !live;
    this.cameraFps!.hidden = !live;
  }

  // The fps dropdown, with the frame rates the camera resolution allows.
  private updateCameraFps(ui: FolderApi, settings: DepthSettings) {
    if (this.fpsOptionsFor === settings.cameraResolution) return;
    this.fpsOptionsFor = settings.cameraResolution;
    const hidden = this.cameraFps?.hidden ?? true;
    this.cameraFps?.dispose();
    const options = Object.fromEntries(CAMERA_FPS[settings.cameraResolution].map((fps) => [`${fps}`, fps]));
    this.cameraFps = ui
      .addBinding(settings, "cameraFps", { label: "camera fps", options, index: 1 })
      .on("change", (e) => this.change("cameraFps", e.value, e.last));
    this.cameraFps.hidden = hidden;
  }

  private change<K extends keyof DepthSettings>(key: K, value: DepthSettings[K], last: boolean) {
    if (!last) return; // mid-drag
    if (value === this.applied?.[key]) return; // the controls following the bridge, not a change
    const sent = this.bridge.send({ type: "depth", settings: { [key]: value } });
    if (sent && REOPEN.includes(key)) this.bridge.waitForInfo("loading depth settings…");
  }

  private addControls(ui: FolderApi, settings: DepthSettings) {
    this.cameraResolution = ui
      .addBinding(settings, "cameraResolution", {
        label: "camera resolution",
        options: { "HD2K (2208×1242)": "HD2K", "HD1080": "HD1080", "HD720": "HD720", "VGA (672×376)": "VGA" },
      })
      .on("change", (e) => this.change("cameraResolution", e.value, e.last));
    ui.addBinding(settings, "mode", {
      options: {
        "Neural light (fastest)": "NEURAL_LIGHT",
        Neural: "NEURAL",
        "Neural plus (sharpest)": "NEURAL_PLUS",
      },
    }).on("change", (e) => this.change("mode", e.value, e.last));
    ui.addBinding(settings, "stabilization", { min: 0, max: 100, step: 1 })
      .on("change", (e) => this.change("stabilization", e.value, e.last));
    ui.addBinding(settings, "confidence", { min: 1, max: 100, step: 1 })
      .on("change", (e) => this.change("confidence", e.value, e.last));
    ui.addBinding(settings, "textureConfidence", { label: "texture conf.", min: 1, max: 100, step: 1 })
      .on("change", (e) => this.change("textureConfidence", e.value, e.last));
    ui.addBinding(settings, "fill", { label: "fill holes" })
      .on("change", (e) => this.change("fill", e.value, e.last));
    ui.addBinding(settings, "removeSaturated", { label: "drop saturated" })
      .on("change", (e) => this.change("removeSaturated", e.value, e.last));
    ui.addBinding(settings, "resolution", {
      options: { "640×360": "640x360", "1280×720": "1280x720" },
    }).on("change", (e) => this.change("resolution", e.value, e.last));
  }
}
