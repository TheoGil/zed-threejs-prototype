import type { FolderApi } from "tweakpane";
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
}

// These only apply when the bridge reopens the camera: a second or two, back at the same frame.
const REOPEN: (keyof DepthSettings)[] = ["mode", "stabilization"];

// The "ZED depth" controls, to change the bridge's depth settings live. The bridge owns
// the settings: the controls are built from the first info it sends, and follow the next ones.
// Each change is sent when a control is released; while paused, the bridge recomputes the same frame.
export class ZedSettings {
  private readonly ui: FolderApi | null;
  private settings: DepthSettings | null = null; // bound to the controls
  private applied: DepthSettings | null = null; // as last reported by the bridge

  constructor(
    private readonly bridge: Bridge,
    debug: Debug,
  ) {
    this.ui = debug.folder("ZED depth");
  }

  // Call with each info from the bridge.
  sync(depth: DepthSettings) {
    this.applied = depth;
    if (!this.ui) return;
    if (this.settings) {
      Object.assign(this.settings, depth);
      this.ui.refresh();
    } else {
      this.settings = { ...depth };
      this.addControls(this.ui, this.settings);
    }
  }

  private change<K extends keyof DepthSettings>(key: K, value: DepthSettings[K], last: boolean) {
    if (!last) return; // mid-drag
    if (value === this.applied?.[key]) return; // the controls following the bridge, not a change
    const sent = this.bridge.send({ type: "depth", settings: { [key]: value } });
    if (sent && REOPEN.includes(key)) this.bridge.setLoading("depth settings");
  }

  private addControls(ui: FolderApi, settings: DepthSettings) {
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
