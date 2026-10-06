import * as THREE from "three";
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
const FRAGMENT = /* glsl */ `
  uniform sampler2D uRealDepth;
  uniform sampler2D uMatte;
  uniform bool uMatteOn;
  uniform vec2 uTexel;
  varying vec2 vUv;
  const int REACH = 2; // people's depth reaches a little past the matte's edge, in depth pixels
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
    float people = 0.0;
    float peopleSum = 0.0;
    for (int y = -REACH; y <= REACH; y++) {
      for (int x = -REACH; x <= REACH; x++) {
        vec2 uv = vUv + vec2(x, y) * uTexel;
        float d = depthAt(uv);
        if (d > 0.0 && d < TOO_FAR && isPerson(uv)) {
          people += 1.0;
          peopleSum += d;
        }
      }
    }
    float personDepth = people > 0.0 ? peopleSum / people : 0.0;
    bool halo = personDepth > 0.0 && live > 0.0
      && abs(live - personDepth) < max(HALO_MIN, HALO_RATIO * personDepth);
    gl_FragColor = vec4(isPerson(vUv) || halo ? 0.0 : live, 0.0, personDepth, 1.0);
  }`;

// The real depth that occludes, per pixel: the live depth, with people taken out. One GPU pass
// at depth resolution, on every render, so every control applies live, even while paused.
export class Occluder {
  // At depth resolution, sampled in screen convention (uv from the bottom-left).
  // R: occluder depth other than people (meters, 0 = unknown). G: unused. B: the depth of the
  // person here or nearby (0 = none).
  readonly output: { value: THREE.Texture | null } = { value: null };
  readonly outputSize = { value: new THREE.Vector2(1, 1) }; // in pixels
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
