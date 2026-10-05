import * as THREE from "three";
import { BACKGROUND_GLSL, type Background } from "./Background";
import type { Debug } from "./Debug";

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Pass 1, over time: whether the live depth wins at each pixel (someone in front of the
// background, or the background is stale), steadied over frames. State: (depth, stable, count).
const TEMPORAL = /* glsl */ `
  ${BACKGROUND_GLSL}
  uniform sampler2D uPrev; // the state after the previous frame
  uniform bool uReset;
  uniform bool uFilterOn;
  uniform float uDelay;
  uniform float uInstant;
  uniform float uSmoothing;
  varying vec2 vUv;
  void main() {
    vec2 depthUv = vec2(vUv.x, 1.0 - vUv.y); // depth rows are stored top first
    float live = texture2D(uRealDepth, depthUv).r;
    float bg = uBgOn ? texture2D(uBgDepth, depthUv).r : 0.0;
    // Without a background (or where it's unknown), every known live depth wins.
    float raw = live > 0.0 && (bg <= 0.0 || liveDiffers(live, bg, vUv)) ? 1.0 : 0.0;
    if (uReset || !uFilterOn) {
      gl_FragColor = vec4(live, raw, 0.0, 1.0);
      return;
    }
    vec3 prev = texture2D(uPrev, vUv).rgb;
    float depth = prev.r;
    float stable = prev.g;
    float count = prev.b; // frames in a row where raw differed from stable
    // Differing from the background by far more than the margin isn't noise: switch at once,
    // or the leading edge of anyone moving would lag a frame behind.
    bool clear = raw > 0.5 && bg > 0.0 && abs(live - bg) > uInstant * bgMargin(bg);
    if (raw == stable || clear) {
      stable = raw;
      count = 0.0;
    } else {
      count += 1.0;
      if (count >= uDelay) {
        stable = raw;
        count = 0.0;
      }
    }
    // Smooth the depth, but follow a jump (someone walking past) at once. Hold it where unknown.
    if (live > 0.0) depth = depth <= 0.0 || abs(live - depth) > bgMargin(live) ? live : mix(live, depth, uSmoothing);
    gl_FragColor = vec4(depth, stable, count, 1.0);
  }`;

// Pass 2, in space, at depth resolution: the occluder depth. A pixel surrounded by foreground
// is a hole in it (unknown live depth, or a color too close to the background's) and takes its
// neighbors' depth. Foreground pixels near the background are its rim (B = 1): stereo depth
// spreads foreground outward, so the rim may be background that got the foreground's depth.
const HOLES = /* glsl */ `
  ${BACKGROUND_GLSL}
  uniform sampler2D uState;
  uniform vec2 uTexel;
  uniform float uRadius;
  uniform float uRim;
  uniform bool uFilterOn;
  varying vec2 vUv;
  const int MAX_RADIUS = 6;
  const float TOO_FAR = 65.0;
  void main() {
    vec3 state = texture2D(uState, vUv).rgb;
    bool foreground = state.g > 0.5;
    // How far to look: for the rim around foreground, for holes elsewhere.
    float reach = foreground ? uRim : (uFilterOn ? uRadius : 0.0);
    float taps = 0.0;
    float found = 0.0;
    float sum = 0.0;
    bool nearBackground = false;
    for (int y = -MAX_RADIUS; y <= MAX_RADIUS; y++) {
      for (int x = -MAX_RADIUS; x <= MAX_RADIUS; x++) {
        if (abs(float(x)) > reach || abs(float(y)) > reach) continue;
        vec3 q = texture2D(uState, vUv + vec2(x, y) * uTexel).rgb;
        taps += 1.0;
        if (q.g > 0.5 && q.r > 0.0 && q.r < TOO_FAR) {
          found += 1.0;
          sum += q.r;
        }
        if (q.g <= 0.5) nearBackground = true;
      }
    }
    if (foreground) {
      gl_FragColor = vec4(state.r, 1.0, nearBackground ? 1.0 : 0.0, 1.0);
      return;
    }
    if (reach > 0.0 && found > 0.5 * taps) {
      gl_FragColor = vec4(sum / found, 0.5, 0.0, 1.0);
      return;
    }
    float bg = uBgOn ? texture2D(uBgDepth, vec2(vUv.x, 1.0 - vUv.y)).r : 0.0;
    gl_FragColor = vec4(bg, 0.0, 0.0, 1.0);
  }`;

// Pass 3, at video resolution: snaps the occluder's edges to the video's. Each video pixel takes
// the depth of the nearby depth pixel that matches it best, by distance and by color (joint
// bilateral upsampling, keeping the best match rather than averaging, which would invent depths
// between a car and the road). Rim pixels count for less, so a road pixel next to a car matches
// the road behind the rim, not the rim that got the car's depth.
const SNAP = /* glsl */ `
  ${BACKGROUND_GLSL}
  uniform sampler2D uLow; // pass 2's output
  uniform vec2 uLowSize;
  uniform bool uSnapOn;
  uniform float uSnapRadius;
  uniform float uColorSigma;
  varying vec2 vUv;
  const int MAX_SNAP = 3;
  const float RIM_TRUST = 0.25;
  void main() {
    vec2 position = vUv * uLowSize - 0.5; // this pixel, in depth pixels
    vec2 nearest = floor(position + 0.5);
    if (!uSnapOn) {
      gl_FragColor = texture2D(uLow, (nearest + 0.5) / uLowSize);
      return;
    }
    vec3 color = texture2D(uVideo, vUv).rgb;
    float best = -1.0;
    vec4 match = vec4(0.0);
    for (int y = -MAX_SNAP; y <= MAX_SNAP; y++) {
      for (int x = -MAX_SNAP; x <= MAX_SNAP; x++) {
        if (abs(float(x)) > uSnapRadius || abs(float(y)) > uSnapRadius) continue;
        vec2 texel = nearest + vec2(x, y);
        vec2 uv = (texel + 0.5) / uLowSize;
        vec4 low = texture2D(uLow, uv);
        vec2 offset = texel - position;
        vec3 colorDiff = texture2D(uVideo, uv).rgb - color;
        float weight = exp(-0.5 * dot(offset, offset)) // 1 depth pixel spatial sigma
          * exp(-dot(colorDiff, colorDiff) / (2.0 * uColorSigma * uColorSigma))
          * (low.b > 0.5 ? RIM_TRUST : 1.0);
        if (weight > best) {
          best = weight;
          match = low;
        }
      }
    }
    gl_FragColor = match;
  }`;

// Decides, per pixel, which real depth occludes: the live depth where it wins over the
// background (see Background.ts), the background's elsewhere. It filters that decision on
// the GPU, at depth resolution: over time (a pixel switches only after a few frames in a
// row, unless it differs from the background by far more than the margin, and its depth
// is smoothed), and in space (holes inside foreground shapes are filled). Then it upsamples
// the result to the video's resolution, snapping its edges to the video's (pass 3).
//
// Runs on every render: the temporal pass reads the state after the previous frame and
// writes the current one, so rerunning it until the next frame gives the same result, and
// every control applies live, even while paused.
export class DepthFilter {
  // At video resolution. R: occluder depth (meters, 0 = unknown). G: 1 = live depth,
  // 0.5 = filled hole, 0 = background. Sampled in screen convention (uv from the bottom-left).
  readonly output: { value: THREE.Texture | null } = { value: null };
  readonly outputSize = { value: new THREE.Vector2(1, 1) }; // in pixels
  private readonly params = {
    filterOn: { value: true },
    delay: { value: 2 }, // frames
    instant: { value: 2 }, // margins
    smoothing: { value: 0.5 },
    radius: { value: 2 }, // depth pixels
    rim: { value: 1 }, // depth pixels
    snapOn: { value: true },
    snapRadius: { value: 2 }, // depth pixels
    colorSigma: { value: 0.1 },
  };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly temporal: THREE.ShaderMaterial;
  private readonly holes: THREE.ShaderMaterial;
  private readonly snap: THREE.ShaderMaterial;
  private targets: {
    prev: THREE.WebGLRenderTarget; // depth resolution: the state after the previous frame
    cur: THREE.WebGLRenderTarget; // depth resolution: the state after this frame
    low: THREE.WebGLRenderTarget; // depth resolution: the occluder, before snapping
    out: THREE.WebGLRenderTarget; // video resolution: the snapped occluder
  } | null = null;
  private newFrame = false;
  private resetting = true; // until a frame has been computed since the last reset
  private computedSinceReset = false;

  constructor(background: Background) {
    const { filterOn, delay, instant, smoothing, radius, rim, snapOn, snapRadius, colorSigma } = this.params;
    this.temporal = new THREE.ShaderMaterial({
      uniforms: {
        ...background.uniforms,
        uPrev: { value: null },
        uReset: { value: true },
        uFilterOn: filterOn,
        uDelay: delay,
        uInstant: instant,
        uSmoothing: smoothing,
      },
      vertexShader: VERTEX,
      fragmentShader: TEMPORAL,
      depthTest: false,
      depthWrite: false,
    });
    this.holes = new THREE.ShaderMaterial({
      uniforms: {
        ...background.uniforms,
        uState: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: radius,
        uRim: rim,
        uFilterOn: filterOn,
      },
      vertexShader: VERTEX,
      fragmentShader: HOLES,
      depthTest: false,
      depthWrite: false,
    });
    this.snap = new THREE.ShaderMaterial({
      uniforms: {
        ...background.uniforms,
        uLow: { value: null },
        uLowSize: { value: new THREE.Vector2(1, 1) },
        uSnapOn: snapOn,
        uSnapRadius: snapRadius,
        uColorSigma: colorSigma,
      },
      vertexShader: VERTEX,
      fragmentShader: SNAP,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.temporal);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  // Called by App, at this folder's place in the pane.
  addControls(debug: Debug) {
    const ui = debug.folder("Depth filter");
    if (!ui) return;
    const { filterOn, delay, instant, smoothing, radius, rim, snapOn, snapRadius, colorSigma } = this.params;
    ui.addBinding(filterOn, "value", { label: "filter" });
    ui.addBinding(delay, "value", { label: "fg delay (frames)", min: 1, max: 5, step: 1 });
    ui.addBinding(instant, "value", { label: "instant beyond (× margin)", min: 1, max: 10 });
    ui.addBinding(smoothing, "value", { label: "depth smoothing", min: 0, max: 0.95 });
    ui.addBinding(radius, "value", { label: "hole fill (px)", min: 0, max: 6, step: 1 });
    ui.addBinding(snapOn, "value", { label: "edge snap" });
    ui.addBinding(rim, "value", { label: "fattening (px)", min: 0, max: 3, step: 1 });
    ui.addBinding(snapRadius, "value", { label: "snap radius (px)", min: 1, max: 3, step: 1 });
    ui.addBinding(colorSigma, "value", { label: "snap color sigma", min: 0.02, max: 0.5 });
  }

  // The live depth size and the video size. Starts over, without memory.
  setSize(width: number, height: number, videoWidth: number, videoHeight: number) {
    if (this.targets) Object.values(this.targets).forEach((target) => target.dispose());
    const make = (width: number, height: number) =>
      new THREE.WebGLRenderTarget(width, height, {
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
      });
    this.targets = {
      prev: make(width, height),
      cur: make(width, height),
      low: make(width, height),
      out: make(videoWidth, videoHeight),
    };
    this.output.value = this.targets.out.texture;
    this.holes.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.snap.uniforms.uLowSize.value.set(width, height);
    this.outputSize.value.set(videoWidth, videoHeight);
    this.reset();
  }

  // Forget the past: e.g. after a new background, the old decisions no longer apply.
  reset() {
    this.resetting = true;
    this.computedSinceReset = false;
  }

  // Call when a new frame arrives: the next render steps the filter forward.
  onFrame() {
    this.newFrame = true;
  }

  render(renderer: THREE.WebGLRenderer) {
    const targets = this.targets;
    if (!targets) return;
    if (this.newFrame) {
      this.newFrame = false;
      [targets.prev, targets.cur] = [targets.cur, targets.prev];
      if (this.computedSinceReset) this.resetting = false;
    }

    this.temporal.uniforms.uPrev.value = targets.prev.texture;
    this.temporal.uniforms.uReset.value = this.resetting;
    this.quad.material = this.temporal;
    renderer.setRenderTarget(targets.cur);
    renderer.render(this.scene, this.camera);
    this.computedSinceReset = true;

    this.holes.uniforms.uState.value = targets.cur.texture;
    this.quad.material = this.holes;
    renderer.setRenderTarget(targets.low);
    renderer.render(this.scene, this.camera);

    this.snap.uniforms.uLow.value = targets.low.texture;
    this.quad.material = this.snap;
    renderer.setRenderTarget(targets.out);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);
  }
}
