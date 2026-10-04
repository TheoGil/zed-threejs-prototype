import * as THREE from "three";
import { OCCLUDER_DEPTH_GLSL, type Background } from "./Background";
import type { Debug } from "./Debug";
import type { Ground } from "./Ground";

// Per-pixel occlusion of virtual content by the real world: a fragment farther from
// the camera than the real depth at that pixel is discarded, unless that real point
// lies on the ground (see Ground.ts). The real depth comes from Background's
// occluderDepth(): the live depth, or the background's where nothing stands in front of it.
export class Occlusion {
  private readonly uniforms;

  constructor(background: Background, ground: Ground, debug: Debug) {
    this.uniforms = {
      ...background.uniforms,
      uResolution: { value: new THREE.Vector2() },
      uBias: { value: 0.05 },
      uOcclusion: { value: true },
      ...ground.uniforms,
    };

    if (debug.pane) {
      debug.pane.addBinding(this.uniforms.uOcclusion, "value", { label: "occlusion" });
      debug.pane.addBinding(this.uniforms.uBias, "value", { label: "bias (m)", min: 0, max: 0.5 });
      ground.addControls(debug.pane);
    }
  }

  // Call when the canvas size changes: the shader maps gl_FragCoord to the depth texture.
  setResolution(renderer: THREE.WebGLRenderer) {
    renderer.getDrawingBufferSize(this.uniforms.uResolution.value);
  }

  // Adds the depth test to a built-in material.
  apply<T extends THREE.Material>(material: T): T {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader =
        OCCLUDER_DEPTH_GLSL +
        `uniform vec2 uResolution;
        uniform float uBias;
        uniform bool uOcclusion;
        uniform vec4 uGround;
        uniform float uGroundMargin;
        uniform bool uGroundOn;
        ` +
        shader.fragmentShader.replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
          if (uOcclusion) {
            float realDepth = occluderDepth(gl_FragCoord.xy / uResolution);
            // vViewPosition.z is this fragment's distance along the camera axis, like the ZED depth.
            if (realDepth > 0.0 && vViewPosition.z > realDepth + uBias) {
              // The real point at this pixel, on the same camera ray as this fragment.
              // Within the margin of the ground, it never occludes: that's the road, and its noise.
              vec3 realPoint = -vViewPosition * (realDepth / vViewPosition.z);
              bool onGround = uGroundOn && dot(uGround.xyz, realPoint) + uGround.w < uGroundMargin;
              if (!onGround) discard;
            }
          }`,
        );
    };
    return material;
  }
}
