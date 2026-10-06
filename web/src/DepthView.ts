import * as THREE from "three";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";
import type { Occluder } from "./Occluder";
import type { Ground } from "./Ground";
import type { People } from "./People";
import type { ZedCamera } from "./ZedCamera";

const DEPTH_VIEW_MAX = 20; // meters mapped to the far end of the colormap

type View = "composite" | "depth" | "ground" | "fill" | "matte";
const VIEW_INDEX = { depth: 0, ground: 1, fill: 2, matte: 3 };

// Full-screen debug views of the real-world depth, instead of the composite. All show
// the depth occlusion uses: the Occluder's output.
// - "Depth only": that depth as a colormap (red is near, blue is far, black has no depth).
// - "Ground": the video, tinted green where the real point is within the ground margin
//   (it never occludes), darkened where there's no depth.
// - "Holes & people": the video, yellow where a hole was filled, magenta where the matte has a
//   person (taken out of the depth). Darkened where there's no depth.
// - "People matte": the matte the bridge sends (white = person), whether the page uses it or
//   not. Black when matting is off or unavailable.
export class DepthView {
  readonly params = { view: "composite" as View };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly uView = { value: 0 };

  constructor(
    occluder: Occluder,
    feed: Feed,
    people: People,
    zedCamera: ZedCamera,
    ground: Ground,
    debug: Debug,
  ) {
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          ...ground.uniforms,
          uVideo: { value: feed.video },
          uMatte: people.uniforms.uMatte,
          uMatteOn: people.uniforms.uMatteOn,
          uHasMatte: people.uniforms.uHasMatte,
          uOccluder: occluder.output,
          uView: this.uView,
          uMax: { value: DEPTH_VIEW_MAX },
          // The same object setIntrinsics() updates, so this follows the calibration.
          uProjectionInverse: { value: zedCamera.projectionMatrixInverse },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
          uniform sampler2D uOccluder;
          uniform sampler2D uVideo;
          uniform sampler2D uMatte;
          uniform bool uMatteOn;
          uniform bool uHasMatte;
          uniform int uView; // VIEW_INDEX
          uniform float uMax;
          uniform mat4 uProjectionInverse;
          uniform vec4 uGround;
          uniform float uGroundMargin;
          uniform bool uGroundOn;
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
            if (uView == 3) {
              float alpha = uHasMatte ? texture2D(uMatte, vUv).r : 0.0;
              gl_FragColor = vec4(vec3(alpha), 1.0);
              return;
            }
            vec4 occluder4 = texture2D(uOccluder, vUv);
            vec2 occluder = occluder4.rg;
            float d = occluder.r;
            if (uView == 0) {
              gl_FragColor = d > 0.0 ? vec4(turbo(1.0 - clamp(d / uMax, 0.0, 1.0)), 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
              return;
            }
            vec3 color = texture2D(uVideo, vUv).rgb; // linear: the texture is sRGB
            if (d <= 0.0) {
              color *= 0.2;
            } else if (uView == 1 && uGroundOn) {
              // The real point at this pixel: along its camera ray, d meters away.
              vec4 p = uProjectionInverse * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
              vec3 ray = p.xyz / p.w;
              vec3 point = ray * (d / -ray.z);
              if (dot(uGround.xyz, point) + uGround.w < uGroundMargin) color = mix(color, vec3(0.0, 1.0, 0.0), 0.5);
            } else if (uView == 2 && occluder.g > 0.25 && occluder.g < 0.75) {
              color = mix(color, vec3(1.0, 0.9, 0.0), 0.5); // filled hole
            }
            // People, from the matte: magenta, as strong as their alpha. People are taken out of
            // the depth above, so they'd be darkened as unknown.
            if (uView == 2 && uMatteOn) color = mix(color, vec3(1.0, 0.0, 1.0), 0.6 * texture2D(uMatte, vUv).r);
            gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
          }`,
      }),
    );
    quad.frustumCulled = false;
    this.scene.add(quad);

    debug.folder("Video")?.addBinding(this.params, "view", {
      options: {
        Composite: "composite",
        "Depth only": "depth",
        Ground: "ground",
        "Holes & people": "fill",
        "People matte": "matte",
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
