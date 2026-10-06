import * as THREE from "three";
import type { Debug } from "./Debug";
import type { Occluder } from "./Occluder";
import type { People } from "./People";

const DEPTH_VIEW_MAX = 20; // meters mapped to the far end of the colormap

type View = "composite" | "depth" | "matte";
const VIEW_INDEX = { depth: 0, matte: 1 };

// Full-screen debug views, instead of the composite.
// - "Depth only": the depth occlusion uses (the Occluder's output) as a colormap (red is near,
//   blue is far, black has no depth).
// - "Robust Video Matting": the matte the bridge sends (white = person), whether the page uses it or
//   not. Black when matting is off or unavailable.
export class DepthView {
  readonly params = { view: "composite" as View };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly uView = { value: 0 };

  constructor(
    occluder: Occluder,
    people: People,
    debug: Debug,
  ) {
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          uMatte: people.uniforms.uMatte,
          uHasMatte: people.uniforms.uHasMatte,
          uOccluder: occluder.output,
          uView: this.uView,
          uMax: { value: DEPTH_VIEW_MAX },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
          uniform sampler2D uOccluder;
          uniform sampler2D uMatte;
          uniform bool uHasMatte;
          uniform int uView; // VIEW_INDEX
          uniform float uMax;
          varying vec2 vUv;
          // Polynomial approximation of the Turbo colormap (near = red, far = blue).
          vec3 turbo(float x) {
            const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
            const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
            const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
            const vec2 kR2 = vec2(-152.94239396, 59.28637943);
            const vec2 kG2 = vec2(4.27729857, 2.82956604);
            const vec2 kB2 = vec2(-89.90310912, 27.34824973);
            vec4 v4 = vec4(1.0, x, x * x, x * x * x);
            vec2 v2 = v4.zw * v4.z;
            return vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2));
          }
          void main() {
            if (uView == 1) {
              float alpha = uHasMatte ? texture2D(uMatte, vUv).r : 0.0;
              gl_FragColor = vec4(vec3(alpha), 1.0);
              return;
            }
            float d = texture2D(uOccluder, vUv).r;
            gl_FragColor = d > 0.0 ? vec4(turbo(1.0 - clamp(d / uMax, 0.0, 1.0)), 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
          }`,
      }),
    );
    quad.frustumCulled = false;
    this.scene.add(quad);

    debug.folder("Video")?.addBinding(this.params, "view", {
      options: {
        Composite: "composite",
        "Depth only": "depth",
        "Robust Video Matting": "matte",
      },
    });
  }

  get active() {
    return this.params.view !== "composite";
  }

  render(renderer: THREE.WebGLRenderer) {
    if (this.params.view !== "composite") this.uView.value = VIEW_INDEX[this.params.view];
    renderer.render(this.scene, this.camera);
  }
}
