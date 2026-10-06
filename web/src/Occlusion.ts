import * as THREE from "three";
import type { Debug } from "./Debug";
import type { Occluder } from "./Occluder";
import type { People } from "./People";

// The occlusion test, in the virtual materials: a fragment farther from the camera than the
// real depth at its pixel is hidden. The real depth comes from the Occluder.
//
// Soft edges: the test runs against the 4 nearest depth pixels, and their answers are blended
// by distance (like percentage-closer filtering for shadow maps). The fragment fades by that
// coverage instead of being cut per depth pixel, so the stair-steps of the low-resolution
// depth become smooth slopes, with each depth pixel's decision unchanged.
//
// People occlude with their own depth (the Occluder's B), and with the matte's alpha as
// coverage, read at full resolution: their edges are as soft as the matte's.
export class Occlusion {
  private readonly uniforms;

  constructor(occluder: Occluder, people: People) {
    this.uniforms = {
      uOccluder: occluder.output,
      uOccluderSize: occluder.outputSize,
      uResolution: { value: new THREE.Vector2() },
      uBias: { value: 0.05 },
      uOcclusion: { value: true },
      uSoftEdges: { value: true },
      uMatte: people.uniforms.uMatte,
      uMatteOn: people.uniforms.uMatteOn,
    };
  }

  // The "Occlusion" folder. Called by App, at this folder's place in the pane.
  addControls(debug: Debug) {
    const ui = debug.folder("Occlusion");
    if (!ui) return;
    ui.addBinding(this.uniforms.uOcclusion, "value", { label: "occlusion" });
    ui.addBinding(this.uniforms.uBias, "value", { label: "bias (m)", min: 0, max: 0.5 });
    ui.addBinding(this.uniforms.uSoftEdges, "value", { label: "soft edges" });
  }

  // Call when the canvas size changes: the shader maps gl_FragCoord to the depth texture.
  setResolution(renderer: THREE.WebGLRenderer) {
    renderer.getDrawingBufferSize(this.uniforms.uResolution.value);
  }

  // Adds the occlusion test to a built-in material. A fragment partly occluded fades out, which
  // needs blending: transparent materials have it; opaque ones get alpha-to-coverage, which
  // turns alpha into the antialiasing samples' coverage (the renderer has antialias on).
  apply<T extends THREE.Material>(material: T): T {
    if (!material.transparent) material.alphaToCoverage = true;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader =
        `uniform sampler2D uOccluder;
        uniform vec2 uOccluderSize;
        uniform vec2 uResolution;
        uniform float uBias;
        uniform bool uOcclusion;
        uniform bool uSoftEdges;
        uniform sampler2D uMatte;
        uniform bool uMatteOn;

        // 1 if the real depth at occluder pixel 'texel' hides this fragment, else 0.
        // fragmentDepth: vViewPosition.z, this fragment's distance along the camera axis, like the ZED depth.
        float occludes(vec2 texel, float fragmentDepth) {
          float realDepth = texture2D(uOccluder, (texel + 0.5) / uOccluderSize).r;
          return realDepth > 0.0 && fragmentDepth > realDepth + uBias ? 1.0 : 0.0;
        }
        ` +
        shader.fragmentShader
          .replace(
            "#include <clipping_planes_fragment>",
            `#include <clipping_planes_fragment>
            float occlusionVisibility = 1.0;
            if (uOcclusion) {
              vec2 screenUv = gl_FragCoord.xy / uResolution;
              // The 4 occluder pixels around this fragment, and its position between them.
              vec2 position = screenUv * uOccluderSize - 0.5;
              vec2 base = floor(position);
              vec2 blend = position - base;
              if (!uSoftEdges) blend = step(0.5, blend); // the nearest pixel only: hard edges
              float coverage = mix(
                mix(occludes(base, vViewPosition.z), occludes(base + vec2(1.0, 0.0), vViewPosition.z), blend.x),
                mix(occludes(base + vec2(0.0, 1.0), vViewPosition.z), occludes(base + vec2(1.0, 1.0), vViewPosition.z), blend.x),
                blend.y);
              // A person here, in front of this fragment: hidden by the matte's alpha.
              float personDepth = texture2D(uOccluder, screenUv).b;
              if (uMatteOn && personDepth > 0.0 && vViewPosition.z > personDepth + uBias)
                coverage = max(coverage, texture2D(uMatte, screenUv).r);
              if (coverage > 0.999) discard;
              occlusionVisibility = 1.0 - coverage;
            }`,
          )
          .replace(
            "#include <opaque_fragment>",
            `#include <opaque_fragment>
            gl_FragColor.a *= occlusionVisibility;`,
          );
    };
    return material;
  }
}
