import * as THREE from "three";
import type { Debug } from "./Debug";
import type { Ground } from "./Ground";
import type { Occluder } from "./Occluder";
import type { People } from "./People";

// The occlusion test, in the virtual materials: a fragment farther from the camera than the
// real depth at its pixel is hidden, unless that real point lies on the ground (see Ground.ts).
// The real depth comes from the Occluder.
//
// Edges: the depth is lower resolution than the screen, so testing only the nearest depth pixel
// cuts along its pixels (stair-steps). Instead, the test's answers (1 = hidden, 0 = not) at the
// depth pixels around the fragment are blended into a smooth field, and the fragment is hidden
// where that field is above one half: the outline follows the field's half-way line, a smooth
// curve through the stair-steps (like rendering crisp text from a low-resolution distance field).
// The cut is antialiased over `edge softness` screen pixels, so it stays crisp.
// - Pixels: the nearest depth pixel only (the stair-steps).
// - Linear: the 4 nearest, blended by distance (chamfered corners).
// - Smooth: the 16 nearest, with cubic B-spline weights (smooth curves; very thin parts and
//   sharp corners get slightly rounder).
//
// People occlude with their own depth (the Occluder's B), and with the matte's alpha as
// coverage, read at full resolution: their edges are as soft as the matte's.
const EDGE_SHAPES = { Pixels: 0, Linear: 1, Smooth: 2 };

export class Occlusion {
  private readonly uniforms;

  constructor(occluder: Occluder, ground: Ground, people: People) {
    this.uniforms = {
      uOccluder: occluder.output,
      uOccluderSize: occluder.outputSize,
      uResolution: { value: new THREE.Vector2() },
      uBias: { value: 0.3 },
      uOcclusion: { value: true },
      uEdgeShape: { value: EDGE_SHAPES.Smooth },
      uEdgeSoftness: { value: 1 }, // screen pixels the edges are antialiased over, 0 = aliased
      ...ground.uniforms,
      uMatte: people.uniforms.uMatte,
      uMatteOn: people.uniforms.uMatteOn,
    };
  }

  // The "Occlusion" folder. Called by App, at this folder's place in the pane.
  addControls(debug: Debug) {
    const ui = debug.folder("Occlusion");
    if (!ui) return;
    ui.addBinding(this.uniforms.uOcclusion, "value", { label: "occlusion" });
    ui.addBinding(this.uniforms.uBias, "value", {
      label: "bias (m)",
      min: 0,
      max: 0.5,
    });
    ui.addBinding(this.uniforms.uEdgeShape, "value", { label: "edge shape", options: EDGE_SHAPES });
    ui.addBinding(this.uniforms.uEdgeSoftness, "value", {
      label: "edge softness (px)",
      min: 0,
      max: 4,
      step: 0.1,
    });
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
      // The lit materials have the fragment's view-space position; the others (basic meshes,
      // lines, points) get it here.
      if (!shader.vertexShader.includes("vViewPosition")) {
        shader.vertexShader =
          "varying vec3 vViewPosition;\n" +
          shader.vertexShader.replace(
            "#include <project_vertex>",
            "#include <project_vertex>\n  vViewPosition = - mvPosition.xyz;",
          );
        shader.fragmentShader = "varying vec3 vViewPosition;\n" + shader.fragmentShader;
      }
      shader.fragmentShader =
        `uniform sampler2D uOccluder;
        uniform vec2 uOccluderSize;
        uniform vec2 uResolution;
        uniform float uBias;
        uniform bool uOcclusion;
        uniform int uEdgeShape; // EDGE_SHAPES
        uniform float uEdgeSoftness;
        uniform vec4 uGround;
        uniform float uGroundMargin;
        uniform bool uGroundOn;
        uniform sampler2D uMatte;
        uniform bool uMatteOn;

        // 1 if the real depth at occluder pixel 'texel' hides this fragment, else 0.
        // viewPosition: vViewPosition, minus this fragment's view-space position.
        float occludes(vec2 texel, vec3 viewPosition) {
          float realDepth = texture2D(uOccluder, (texel + 0.5) / uOccluderSize).r;
          // viewPosition.z is this fragment's distance along the camera axis, like the ZED depth.
          if (realDepth <= 0.0 || viewPosition.z <= realDepth + uBias) return 0.0;
          // The real point there, on this fragment's camera ray. Within the margin of the
          // ground, it never occludes: that's the floor, and its noise.
          vec3 realPoint = -viewPosition * (realDepth / viewPosition.z);
          bool onGround = uGroundOn && dot(uGround.xyz, realPoint) + uGround.w < uGroundMargin;
          return onGround ? 0.0 : 1.0;
        }

        // Cubic B-spline weights of the 4 pixels around a point 'f' (0..1) past the second one.
        vec4 bspline(float f) {
          float g = 1.0 - f;
          return vec4(g * g * g, 3.0 * f * f * f - 6.0 * f * f + 4.0, 3.0 * g * g * g - 6.0 * g * g + 4.0, f * f * f) / 6.0;
        }

        // The test's answers around 'position' (in occluder pixels, pixel centers on whole
        // numbers), blended into a smooth field (see EDGE_SHAPES): hidden where above 0.5.
        float occlusionField(vec2 position, vec3 viewPosition) {
          if (uEdgeShape == 0) return occludes(floor(position + 0.5), viewPosition);
          vec2 base = floor(position);
          vec2 f = position - base;
          if (uEdgeShape == 1) {
            return mix(
              mix(occludes(base, viewPosition), occludes(base + vec2(1.0, 0.0), viewPosition), f.x),
              mix(occludes(base + vec2(0.0, 1.0), viewPosition), occludes(base + vec2(1.0, 1.0), viewPosition), f.x),
              f.y);
          }
          vec4 wx = bspline(f.x);
          vec4 wy = bspline(f.y);
          float field = 0.0;
          for (int y = 0; y < 4; y++) {
            float row = 0.0;
            for (int x = 0; x < 4; x++) row += wx[x] * occludes(base + vec2(x - 1, y - 1), viewPosition);
            field += wy[y] * row;
          }
          return field;
        }
        ` +
        shader.fragmentShader
          .replace(
            "#include <clipping_planes_fragment>",
            `#include <clipping_planes_fragment>
            float occlusionVisibility = 1.0;
            if (uOcclusion) {
              vec2 screenUv = gl_FragCoord.xy / uResolution;
              // This fragment's position among the occluder pixels.
              vec2 position = screenUv * uOccluderSize - 0.5;
              float field = occlusionField(position, vViewPosition);
              // Cut at one half, antialiased over 'uEdgeSoftness' screen pixels: fwidth is how
              // much the field changes from one screen pixel to the next.
              float halfWidth = 0.5 * uEdgeSoftness * fwidth(field);
              float coverage = halfWidth > 0.0 ? smoothstep(0.5 - halfWidth, 0.5 + halfWidth, field) : step(0.5, field);
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
