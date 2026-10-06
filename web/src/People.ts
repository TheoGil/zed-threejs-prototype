import type { BladeApi, FolderApi } from "tweakpane";
import type { Bridge } from "./Bridge";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";

// People matting in the bridge (MATTING_SETTINGS in bridge.py, plus whether it could start).
export interface MattingInfo {
  available: boolean; // false without ONNX Runtime or the model (see matting.py)
  enabled: boolean;
  input: "640x360" | "1280x720"; // the size of the image RVM gets
  ratio: number; // the share of that size RVM works at internally
}

// People, cut out of the video by the bridge's matting (Robust Video Matting): their alpha
// matte gives their shape, depth gives their order (see Occluder and Occlusion).
// Controls (the "Robust Video Matting" folder): whether the bridge computes the matte and at
// what resolution, and whether the page uses it. With matting off, or unavailable (no ONNX Runtime
// or model: the bridge's log says which), the controls that depend on it are disabled.
export class People {
  // uMatte: white = person, at video size, sampled in screen convention (uv from the bottom-left).
  readonly uniforms;
  private readonly params = {
    use: true,
    enabled: true,
    input: "640x360" as MattingInfo["input"],
    ratio: 0.5,
  };
  private ui: FolderApi | null = null;
  private enableBinding: BladeApi | null = null;
  private dependent: BladeApi[] = []; // the controls that only matter with matting on
  private bridge: Bridge | null = null;
  private applied: MattingInfo | null = null; // as last reported by the bridge

  constructor(private readonly feed: Feed) {
    this.uniforms = {
      uMatte: { value: feed.matte },
      uMatteOn: { value: false }, // the page uses the matte
      uHasMatte: feed.hasMatte, // the last frame had one, used or not
    };
  }

  // Called by App once the bridge exists, at this folder's place in the pane.
  addControls(debug: Debug, bridge: Bridge) {
    this.bridge = bridge;
    const ui = debug.folder("Robust Video Matting");
    if (!ui) return;
    this.ui = ui;
    this.enableBinding = ui.addBinding(this.params, "enabled", { label: "enable" }).on("change", (e) => {
      this.change("enabled", e.value, e.last);
      this.updateDisabled();
    });
    this.dependent = [
      ui.addBinding(this.params, "use", { label: "use matte" }),
      ui.addBinding(this.params, "input", {
        label: "resolution",
        options: { "640×360 (faster)": "640x360", "1280×720 (sharper)": "1280x720" },
      }).on("change", (e) => this.change("input", e.value, e.last)),
      ui.addBinding(this.params, "ratio", { label: "matting ratio", min: 0.1, max: 1, step: 0.05 })
        .on("change", (e) => this.change("ratio", e.value, e.last)),
    ];
  }

  // Call with each info from the bridge.
  sync(info: MattingInfo) {
    this.applied = info;
    this.params.enabled = info.enabled;
    this.params.input = info.input;
    this.params.ratio = info.ratio;
    this.ui?.refresh();
    this.updateDisabled();
  }

  private updateDisabled() {
    const available = this.applied?.available ?? true;
    if (this.enableBinding) this.enableBinding.disabled = !available;
    this.dependent.forEach((binding) => (binding.disabled = !available || !this.params.enabled));
  }

  // Call before rendering: the matte applies only when the last frame had one.
  update() {
    this.uniforms.uMatteOn.value = this.params.use && this.feed.hasMatte.value;
  }

  private change<K extends "enabled" | "input" | "ratio">(key: K, value: MattingInfo[K], last: boolean) {
    if (!last || value === this.applied?.[key]) return; // mid-drag, or the controls following the bridge
    this.bridge?.send({ type: "matting", settings: { [key]: value } });
  }
}
