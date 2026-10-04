import * as THREE from "three";
import type { BackgroundInfo, Bridge, Frame } from "./Bridge";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";

// GLSL shared by Occlusion and DepthView: the real depth that occludes at a pixel.
// With a background, a pixel uses the live depth where something stands clearly in front
// of the background (and, with the color test, looks different from it): people, bikes.
// It also does where the live depth is clearly farther: what the background saw has left.
// Everywhere else, the live depth agrees with the background or is unknown, and the
// background's depth is used: clean, stable, without holes.
// Needs Background.uniforms (which include the live depth and video).
export const OCCLUDER_DEPTH_GLSL = /* glsl */ `
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

  // screenUv: 0..1 from the bottom-left, like gl_FragCoord.xy / resolution.
  // Meters, 0 = unknown, about 65 = too far (beyond the ZED's range).
  float occluderDepth(vec2 screenUv) {
    vec2 depthUv = vec2(screenUv.x, 1.0 - screenUv.y); // depth rows are stored top first
    float live = texture2D(uRealDepth, depthUv).r;
    if (!uBgOn) return live;
    float bg = texture2D(uBgDepth, depthUv).r;
    if (bg <= 0.0) return live; // the background is unknown here
    if (live <= 0.0) return bg; // the live depth is unknown: the background fills the hole
    // Farther than the background: what it saw there has left (e.g. a car that drove off).
    if (live > bg + bgMargin(bg)) return live;
    return isForeground(live, bg, screenUv) ? live : bg;
  }
`;

// The scene's background: its empty set, captured by the bridge from a few seconds of
// frames (the per-pixel median, so people passing through drop out) and saved there.
// Its depth replaces the live depth wherever nothing stands in front of it.
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
