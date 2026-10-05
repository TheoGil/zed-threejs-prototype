import * as THREE from "three";
import type { Debug } from "./Debug";
import type { DepthFilter } from "./DepthFilter";
import type { Ground } from "./Ground";

// Per-pixel occlusion of virtual content by the real world: a fragment farther from
// the camera than the real depth at that pixel is hidden, unless that real point
// lies on the ground (see Ground.ts). The real depth comes from DepthFilter: the live
// depth, or the background's where nothing stands in front of it, filtered.
//
// Soft edges: the test runs against the 4 nearest depth pixels, and their answers are
// blended by distance (like percentage-closer filtering for shadow maps). The fragment
// fades by that coverage instead of being cut per depth pixel, so the stair-steps of the
// low-resolution depth become smooth slopes, with each depth pixel's decision unchanged.
export class Occlusion {
  private readonly uniforms;

  constructor(filter: DepthFilter, ground: Ground, debug: Debug) {
    this.uniforms = {
      uOccluder: filter.output,
      uOccluderSize: filter.outputSize,
      uResolution: { value: new THREE.Vector2() },
      uBias: { value: 0.05 },
      uOcclusion: { value: true },
      uSoftEdges: { value: true },
      ...ground.uniforms,
    };

    if (debug.pane) {
      debug.pane.addBinding(this.uniforms.uOcclusion, "value", { label: "occlusion" });
      debug.pane.addBinding(this.uniforms.uSoftEdges, "value", { label: "soft edges" });
      debug.pane.addBinding(this.uniforms.uBias, "value", { label: "bias (m)", min: 0, max: 0.5 });
      ground.addControls(debug.pane);
    }
  }

  // Call when the canvas size changes: the shader maps gl_FragCoord to the depth texture.
  setResolution(renderer: THREE.WebGLRenderer) {
    renderer.getDrawingBufferSize(this.uniforms.uResolution.value);
  }

  // Adds the depth test to a built-in material. A fragment partly occluded fades out, which
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
        uniform vec4 uGround;
        uniform float uGroundMargin;
        uniform bool uGroundOn;

        // 1 if the real depth at occluder pixel 'texel' hides this fragment, else 0.
        // viewPosition: vViewPosition, minus this fragment's view-space position.
        float occludes(vec2 texel, vec3 viewPosition) {
          float realDepth = texture2D(uOccluder, (texel + 0.5) / uOccluderSize).r;
          // viewPosition.z is this fragment's distance along the camera axis, like the ZED depth.
          if (realDepth <= 0.0 || viewPosition.z <= realDepth + uBias) return 0.0;
          // The real point there, on this fragment's camera ray. Within the margin of the
          // ground, it never occludes: that's the road, and its noise.
          vec3 realPoint = -viewPosition * (realDepth / viewPosition.z);
          bool onGround = uGroundOn && dot(uGround.xyz, realPoint) + uGround.w < uGroundMargin;
          return onGround ? 0.0 : 1.0;
        }
        ` +
        shader.fragmentShader
          .replace(
            "#include <clipping_planes_fragment>",
            `#include <clipping_planes_fragment>
            float occlusionVisibility = 1.0;
            if (uOcclusion) {
              // The 4 occluder pixels around this fragment, and its position between them.
              vec2 position = gl_FragCoord.xy / uResolution * uOccluderSize - 0.5;
              vec2 base = floor(position);
              vec2 blend = position - base;
              if (!uSoftEdges) blend = step(0.5, blend); // the nearest pixel only: hard edges
              float coverage = mix(
                mix(occludes(base, vViewPosition), occludes(base + vec2(1.0, 0.0), vViewPosition), blend.x),
                mix(occludes(base + vec2(0.0, 1.0), vViewPosition), occludes(base + vec2(1.0, 1.0), vViewPosition), blend.x),
                blend.y);
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
