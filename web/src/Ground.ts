import * as THREE from "three";
import type { Pane } from "tweakpane";
import type { Plane } from "./Plane";

// The active recording's ground plane, as shader uniforms. A real point within `margin`
// of the ground never occludes: road noise can't hide a plane lying on the road.
// The ground is the plane marked "ground" in the recording, read every frame so it
// follows the gizmo.
export class Ground {
  readonly uniforms = {
    uGround: { value: new THREE.Vector4() }, // camera frame: height(P) = dot(xyz, P) + w
    uGroundMargin: { value: 0.15 }, // meters
    uGroundOn: { value: false },
  };
  private readonly params = { enabled: true };

  // Called by Occlusion, so these controls sit next to its own.
  addControls(pane: Pane) {
    pane.addBinding(this.params, "enabled", { label: "ground test" });
    pane.addBinding(this.uniforms.uGroundMargin, "value", {
      label: "ground margin (m)",
      min: 0,
      max: 0.5,
    });
  }

  update(plane: Plane | undefined) {
    this.uniforms.uGroundOn.value = this.params.enabled && !!plane;
    plane?.surface(this.uniforms.uGround.value);
  }
}
