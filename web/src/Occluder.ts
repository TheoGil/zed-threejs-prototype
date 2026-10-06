import * as THREE from "three";
import { BACKGROUND_GLSL, type Background } from "./Background";
import type { Debug } from "./Debug";
import type { People } from "./People";

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// GLSL: whether the matte says this pixel is a person. uv in screen convention.
const PEOPLE_GLSL = /* glsl */ `
  uniform sampler2D uMatte;
  uniform bool uMatteOn;
  bool isPerson(vec2 uv) {
    return uMatteOn && texture2D(uMatte, uv).r > 0.5;
  }`;

// Pass 1: whether the live depth wins over the background's at each pixel (see Background.ts).
// Output: (live depth, wins).
const CLASSIFY = /* glsl */ `
  ${BACKGROUND_GLSL}
  varying vec2 vUv;
  void main() {
    vec2 depthUv = vec2(vUv.x, 1.0 - vUv.y); // depth rows are stored top first
    float live = texture2D(uRealDepth, depthUv).r;
    float bg = uBgOn ? texture2D(uBgDepth, depthUv).r : 0.0;
    // Without a background (or where it's unknown), every known live depth wins.
    float wins = live > 0.0 && (bg <= 0.0 || liveDiffers(live, bg, vUv)) ? 1.0 : 0.0;
    gl_FragColor = vec4(live, wins, 0.0, 1.0);
  }`;

// Pass 2: the occluder, from pass 1 and its neighborhood.
// - People (from the matte) are taken out: their pixels get what's behind them (the background),
//   and a person depth (B), from the person pixels around them that have one.
// - Next to a person, a pixel where the live depth wins at about that person's depth is their
//   halo (stereo depth spreads foreground outward): it gets the background too.
// - Holes: a pixel more than half surrounded by foreground (unknown live depth, or a color too
//   close to the background's) takes its neighbors' depth.
const RESOLVE = /* glsl */ `
  ${BACKGROUND_GLSL}
  ${PEOPLE_GLSL}
  uniform sampler2D uClassified;
  uniform vec2 uTexel;
  uniform bool uHolesOn;
  uniform float uRadius;
  varying vec2 vUv;
  const int MAX_REACH = 6;
  const float TOO_FAR = 65.0;
  void main() {
    vec2 here = texture2D(uClassified, vUv).rg;
    float live = here.r;
    bool wins = here.g > 0.5;
    float bg = uBgOn ? texture2D(uBgDepth, vec2(vUv.x, 1.0 - vUv.y)).r : 0.0;
    float holeRadius = uHolesOn ? uRadius : 0.0;
    float reach = max(holeRadius, 2.0); // people's depth reaches a little past the matte's edge
    float taps = 0.0;
    float foreground = 0.0;
    float foregroundSum = 0.0;
    float people = 0.0;
    float peopleSum = 0.0;
    for (int y = -MAX_REACH; y <= MAX_REACH; y++) {
      for (int x = -MAX_REACH; x <= MAX_REACH; x++) {
        if (abs(float(x)) > reach || abs(float(y)) > reach) continue;
        vec2 uv = vUv + vec2(x, y) * uTexel;
        vec2 q = texture2D(uClassified, uv).rg;
        bool known = q.g > 0.5 && q.r > 0.0 && q.r < TOO_FAR; // a live depth that wins, in range
        if (known && isPerson(uv)) {
          people += 1.0;
          peopleSum += q.r;
        }
        if (abs(float(x)) > holeRadius || abs(float(y)) > holeRadius) continue;
        taps += 1.0;
        if (known) {
          foreground += 1.0;
          foregroundSum += q.r;
        }
      }
    }
    float personDepth = people > 0.0 ? peopleSum / people : 0.0;
    if (isPerson(vUv) || (wins && personDepth > 0.0 && abs(live - personDepth) < bgMargin(personDepth))) {
      gl_FragColor = vec4(bg, 0.0, personDepth, 1.0);
    } else if (wins) {
      gl_FragColor = vec4(live, 1.0, personDepth, 1.0);
    } else if (holeRadius > 0.0 && foreground > 0.5 * taps) {
      gl_FragColor = vec4(foregroundSum / foreground, 0.5, personDepth, 1.0);
    } else {
      gl_FragColor = vec4(bg, 0.0, personDepth, 1.0);
    }
  }`;

// The real depth that occludes, per pixel: the live depth where it wins over the background
// (see Background.ts), the background's elsewhere, with people taken out and holes filled.
// Two GPU passes at depth resolution, on every render, so every control applies live, even
// while paused.
export class Occluder {
  // At depth resolution, sampled in screen convention (uv from the bottom-left).
  // R: occluder depth other than people (meters, 0 = unknown). G: 1 = live depth, 0.5 = filled
  // hole, 0 = background. B: the depth of the person here or nearby (0 = none).
  readonly output: { value: THREE.Texture | null } = { value: null };
  readonly outputSize = { value: new THREE.Vector2(1, 1) }; // in pixels
  private readonly holes = {
    on: { value: true },
    radius: { value: 2 }, // depth pixels
  };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly classify: THREE.ShaderMaterial;
  private readonly resolve: THREE.ShaderMaterial;
  private targets: { classified: THREE.WebGLRenderTarget; out: THREE.WebGLRenderTarget } | null = null;

  constructor(background: Background, people: People) {
    this.classify = new THREE.ShaderMaterial({
      uniforms: { ...background.uniforms },
      vertexShader: VERTEX,
      fragmentShader: CLASSIFY,
      depthTest: false,
      depthWrite: false,
    });
    this.resolve = new THREE.ShaderMaterial({
      uniforms: {
        ...background.uniforms,
        ...people.uniforms,
        uClassified: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uHolesOn: this.holes.on,
        uRadius: this.holes.radius,
      },
      vertexShader: VERTEX,
      fragmentShader: RESOLVE,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.classify);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  // The "Holes" folder. Called by App, at this folder's place in the pane.
  addControls(debug: Debug) {
    const ui = debug.folder("Holes");
    if (!ui) return;
    ui.addBinding(this.holes.on, "value", { label: "fill holes" });
    ui.addBinding(this.holes.radius, "value", { label: "hole fill (px)", min: 1, max: 6, step: 1 });
  }

  // The live depth size.
  setSize(width: number, height: number) {
    if (this.targets) Object.values(this.targets).forEach((target) => target.dispose());
    const make = () =>
      new THREE.WebGLRenderTarget(width, height, {
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
      });
    this.targets = { classified: make(), out: make() };
    this.output.value = this.targets.out.texture;
    this.outputSize.value.set(width, height);
    this.resolve.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(renderer: THREE.WebGLRenderer) {
    const targets = this.targets;
    if (!targets) return;
    this.quad.material = this.classify;
    renderer.setRenderTarget(targets.classified);
    renderer.render(this.scene, this.camera);

    this.resolve.uniforms.uClassified.value = targets.classified.texture;
    this.quad.material = this.resolve;
    renderer.setRenderTarget(targets.out);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);
  }
}
