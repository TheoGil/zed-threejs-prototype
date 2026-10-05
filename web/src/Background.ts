import * as THREE from "three";
import type { BackgroundInfo, Bridge, Frame } from "./Bridge";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";

// GLSL for comparing the live depth with the background, used by DepthFilter (which
// decides, per pixel, which depth occludes) and DepthView. Needs Background.uniforms
// (which include the live depth and video). Depths in meters, 0 = unknown, about 65 = too far.
export const BACKGROUND_GLSL = /* glsl */ `
  uniform sampler2D uRealDepth;
  uniform sampler2D uVideo;
  uniform sampler2D uBgDepth;
  uniform sampler2D uBgColor;
  uniform bool uBgOn;
  uniform float uFgMin;
  uniform float uFgRatio;
  uniform bool uColorTest;
  uniform float uColorTolerance;

  // Whether the live color differs from the background's, other than by a shadow:
  // a different hue, brighter, or much darker than a shadow makes it.
  bool colorDiffers(vec2 screenUv) {
    vec3 live = texture2D(uVideo, screenUv).rgb;
    vec3 bg = texture2D(uBgColor, screenUv).rgb;
    const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
    float liveLuma = dot(live, luma) + 1e-3;
    float bgLuma = dot(bg, luma) + 1e-3;
    float hueDiff = length(live / liveLuma - bg / bgLuma) / 3.0;
    float ratio = liveLuma / bgLuma;
    return hueDiff > uColorTolerance || ratio > 1.0 + 2.0 * uColorTolerance || ratio < 0.25;
  }

  // How far the live depth must be from the background's to differ from it.
  // Stereo noise grows with distance, so the margin does too.
  float bgMargin(float bg) {
    return max(uFgMin, uFgRatio * bg);
  }

  // Whether something stands in front of the background at this pixel. Depths in meters, live > 0.
  bool isForeground(float live, float bg, vec2 screenUv) {
    return live < bg - bgMargin(bg) && (!uColorTest || colorDiffers(screenUv));
  }

  // Whether the live depth should be used rather than the background's: something stands
  // in front of it, or the live depth is clearly farther, so what the background saw there
  // has left (e.g. a car that drove off). Both known (> 0).
  bool liveDiffers(float live, float bg, vec2 screenUv) {
    return isForeground(live, bg, screenUv) || live > bg + bgMargin(bg);
  }
`;

// The scene's background: its empty set, captured by the bridge from a few seconds of
// frames (the per-pixel median, so people passing through drop out) and saved there.
// Its depth replaces the live depth wherever nothing stands in front of it (see DepthFilter).
export class Background {
  readonly uniforms;
  private readonly params = { use: true, seconds: 5, captured: "none" };
  private bridge: Bridge | null = null;

  constructor(feed: Feed) {
    this.uniforms = {
      uRealDepth: feed.depth,
      uVideo: { value: feed.video },
      uBgDepth: { value: null as THREE.DataTexture | null },
      uBgColor: { value: null as THREE.Texture | null },
      uBgOn: { value: false },
      uFgMin: { value: 0.15 }, // meters
      uFgRatio: { value: 0.03 }, // of the background's depth
      uColorTest: { value: false },
      uColorTolerance: { value: 0.1 },
    };
  }

  // Called by App once the bridge exists, at this folder's place in the pane.
  addControls(debug: Debug, bridge: Bridge) {
    this.bridge = bridge;
    const ui = debug.folder("Background");
    if (!ui) return;
    ui.addBinding(this.params, "seconds", { label: "capture (s)", min: 1, max: 15, step: 1 });
    ui.addButton({ title: "Capture background" }).on("click", () => this.capture());
    ui.addBinding(this.params, "captured", { readonly: true });
    ui.addBinding(this.params, "use", { label: "use background" }).on("change", () => this.updateOn());
    ui.addBinding(this.uniforms.uFgMin, "value", { label: "fg margin (m)", min: 0, max: 1 });
    ui.addBinding(this.uniforms.uFgRatio, "value", { label: "fg margin (%)", min: 0, max: 0.2 });
    ui.addBinding(this.uniforms.uColorTest, "value", { label: "color test" });
    ui.addBinding(this.uniforms.uColorTolerance, "value", { label: "color tolerance", min: 0, max: 0.5 });
  }

  // Call with each info from the bridge. The background itself arrives right after, in set().
  sync(info: BackgroundInfo | null) {
    this.params.captured = info ? `${info.capturedAt.replace("T", " ")} (${info.frames} frames)` : "none";
    if (!info) this.clear();
  }

  set({ image, depthMm }: Frame, { depthWidth, depthHeight }: BackgroundInfo) {
    this.clear();
    const depth = new THREE.DataTexture(
      Float32Array.from(depthMm, (mm) => mm * 0.001),
      depthWidth,
      depthHeight,
      THREE.RedFormat,
      THREE.FloatType,
    );
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    depth.needsUpdate = true;
    const color = new THREE.Texture(image);
    color.colorSpace = THREE.SRGBColorSpace;
    color.needsUpdate = true;
    this.uniforms.uBgDepth.value = depth;
    this.uniforms.uBgColor.value = color;
    this.updateOn();
  }

  private clear() {
    this.uniforms.uBgDepth.value?.dispose();
    this.uniforms.uBgColor.value?.dispose();
    this.uniforms.uBgDepth.value = null;
    this.uniforms.uBgColor.value = null;
    this.updateOn();
  }

  private updateOn() {
    this.uniforms.uBgOn.value = this.params.use && !!this.uniforms.uBgDepth.value;
  }

  // The bridge keeps the next frames (it plays even when paused), then sends the new background.
  private capture() {
    const { seconds } = this.params;
    if (this.bridge?.send({ type: "capture", seconds }))
      this.bridge.waitForInfo(`capturing the background (${seconds} s)…`);
  }
}
