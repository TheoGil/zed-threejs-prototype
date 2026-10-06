import * as THREE from "three";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";
import type { People } from "./People";

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The occluder, from the live depth and its neighborhood.
// - People (from the matte) are taken out of the depth: they occlude with the matte instead,
//   at a person depth (B) taken from the person pixels around them.
// - Next to a person, a pixel at about that person's depth is their halo (stereo depth spreads
//   foreground outward): it's taken out too.
// - Holes: an unknown pixel more than half surrounded by known depth takes their mean.
const FRAGMENT = /* glsl */ `
  uniform sampler2D uRealDepth;
  uniform sampler2D uMatte;
  uniform bool uMatteOn;
  uniform vec2 uTexel;
  uniform bool uHolesOn;
  uniform float uRadius;
  varying vec2 vUv;
  const int MAX_REACH = 6;
  const float TOO_FAR = 65.0;
  // How close to a person's depth a pixel next to them must be to be their halo:
  // stereo noise grows with distance, so the margin does too.
  const float HALO_MIN = 0.15; // meters
  const float HALO_RATIO = 0.03; // of the person's depth

  // Whether the matte says this pixel is a person. uv in screen convention.
  bool isPerson(vec2 uv) {
    return uMatteOn && texture2D(uMatte, uv).r > 0.5;
  }

  // The live depth, in meters (0 = unknown, about 65 = too far). Its rows are stored top first.
  float depthAt(vec2 uv) {
    return texture2D(uRealDepth, vec2(uv.x, 1.0 - uv.y)).r;
  }

  void main() {
    float live = depthAt(vUv);
    float holeRadius = uHolesOn ? uRadius : 0.0;
    float reach = max(holeRadius, 2.0); // people's depth reaches a little past the matte's edge
    float taps = 0.0;
    float known = 0.0;
    float knownSum = 0.0;
    float people = 0.0;
    float peopleSum = 0.0;
    for (int y = -MAX_REACH; y <= MAX_REACH; y++) {
      for (int x = -MAX_REACH; x <= MAX_REACH; x++) {
        if (abs(float(x)) > reach || abs(float(y)) > reach) continue;
        vec2 uv = vUv + vec2(x, y) * uTexel;
        float d = depthAt(uv);
        bool inRange = d > 0.0 && d < TOO_FAR;
        if (inRange && isPerson(uv)) {
          people += 1.0;
          peopleSum += d;
        }
        if (abs(float(x)) > holeRadius || abs(float(y)) > holeRadius) continue;
        taps += 1.0;
        if (inRange) {
          known += 1.0;
          knownSum += d;
        }
      }
    }
    float personDepth = people > 0.0 ? peopleSum / people : 0.0;
    bool halo = personDepth > 0.0 && live > 0.0
      && abs(live - personDepth) < max(HALO_MIN, HALO_RATIO * personDepth);
    if (isPerson(vUv) || halo) {
      gl_FragColor = vec4(0.0, 0.0, personDepth, 1.0);
    } else if (live > 0.0) {
      gl_FragColor = vec4(live, 1.0, personDepth, 1.0);
    } else if (holeRadius > 0.0 && known > 0.5 * taps) {
      gl_FragColor = vec4(knownSum / known, 0.5, personDepth, 1.0);
    } else {
      gl_FragColor = vec4(0.0, 0.0, personDepth, 1.0);
    }
  }`;

// The real depth that occludes, per pixel: the live depth, with people taken out and holes
// filled. One GPU pass at depth resolution, on every render, so every control applies live,
// even while paused.
export class Occluder {
  // At depth resolution, sampled in screen convention (uv from the bottom-left).
  // R: occluder depth other than people (meters, 0 = unknown). G: 1 = live depth, 0.5 = filled
  // hole, 0 = none. B: the depth of the person here or nearby (0 = none).
  readonly output: { value: THREE.Texture | null } = { value: null };
  readonly outputSize = { value: new THREE.Vector2(1, 1) }; // in pixels
  private readonly holes = {
    on: { value: true },
    radius: { value: 2 }, // depth pixels
  };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private target: THREE.WebGLRenderTarget | null = null;

  constructor(feed: Feed, people: People) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uRealDepth: feed.depth,
        uMatte: people.uniforms.uMatte,
        uMatteOn: people.uniforms.uMatteOn,
        uTexel: { value: new THREE.Vector2() },
        uHolesOn: this.holes.on,
        uRadius: this.holes.radius,
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
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
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.output.value = this.target.texture;
    this.outputSize.value.set(width, height);
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(renderer: THREE.WebGLRenderer) {
    if (!this.target) return;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);
  }
}
