import * as THREE from "three";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";

// Per-pixel occlusion of virtual content by the real world: a fragment farther from
// the camera than the real depth at that pixel is discarded.
export class Occlusion {
  private readonly uniforms;

  constructor(feed: Feed, debug: Debug) {
    this.uniforms = {
      uRealDepth: feed.depth,
      uResolution: { value: new THREE.Vector2() },
      uBias: { value: 0.05 },
      uOcclusion: { value: true },
    };

    if (debug.pane) {
      debug.pane.addBinding(this.uniforms.uOcclusion, "value", { label: "occlusion" });
      debug.pane.addBinding(this.uniforms.uBias, "value", { label: "bias (m)", min: 0, max: 0.5 });
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
        "uniform sampler2D uRealDepth;\nuniform vec2 uResolution;\nuniform float uBias;\nuniform bool uOcclusion;\n" +
        shader.fragmentShader.replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
          if (uOcclusion) {
            vec2 depthUv = vec2(gl_FragCoord.x / uResolution.x, 1.0 - gl_FragCoord.y / uResolution.y);
            float realDepth = texture2D(uRealDepth, depthUv).r;
            // vViewPosition.z is this fragment's distance along the camera axis, like the ZED depth.
            if (realDepth > 0.0 && vViewPosition.z > realDepth + uBias) discard;
          }`,
        );
    };
    return material;
  }
}
