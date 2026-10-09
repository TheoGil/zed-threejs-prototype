import * as THREE from "three";
import type { BladeApi, FolderApi } from "tweakpane";
import type { Debug } from "./Debug";
import type { Occlusion } from "./Occlusion";
import type { Plane } from "./Plane";

// Where the grid sits in a recording without a ground plane, in the camera's frame.
const DEFAULT_POSITION = new THREE.Vector3(0, -1.5, -4);

type Pattern = "ripple" | "wave";

// A grid of spheres on the floor, evenly spaced along its X and Z, bobbing up and down in
// waves: a test of occlusion against moving 3D content. One instanced mesh (a single draw).
// The grid lies on the active recording's ground plane, centered on it (plus an offset), its Y
// along the floor's normal; without a ground plane, in front of and below the camera.
export class Spheres {
  private readonly group = new THREE.Group();
  private readonly material: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh | null = null;
  private readonly params = {
    show: false,
    count: 10, // per side
    spacing: 0.5, // meters between neighbors
    radius: 0.08, // meters
    height: 0.4, // meters above the floor, at rest
    offset: { x: 0, y: 0 }, // meters along the floor's X and Z, from the ground plane's center
    pattern: "ripple" as Pattern,
    amplitude: 0.25, // meters up and down
    wavelength: 2, // meters
    speed: 0.5, // waves per second
    color: "#4fc3ff",
  };
  private dependent: BladeApi[] = []; // the controls that only matter while shown
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor(occlusion: Occlusion, debug: Debug) {
    this.material = occlusion.apply(new THREE.MeshStandardMaterial({ color: this.params.color, roughness: 0.4 }));
    this.rebuild();
    this.addControls(debug);
  }

  // Call before rendering: places the grid on the ground plane and moves the spheres.
  update(seconds: number, ground: Plane | undefined) {
    this.group.visible = this.params.show;
    if (!this.params.show || !this.mesh) return;
    if (ground) {
      ground.floorFrame(this.group);
    } else {
      this.group.position.copy(DEFAULT_POSITION);
      this.group.quaternion.identity();
    }

    const { count, spacing, radius, height, offset, pattern, amplitude, wavelength, speed } = this.params;
    const middle = (count - 1) / 2;
    this.scale.setScalar(radius);
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const x = (i - middle) * spacing;
        const z = (j - middle) * spacing;
        // Ripple: rings spreading from the middle. Wave: straight crests moving along X.
        const distance = pattern === "ripple" ? Math.hypot(x, z) : x;
        const y = height + amplitude * Math.sin(2 * Math.PI * (distance / wavelength - speed * seconds));
        this.position.set(x + offset.x, y, z + offset.y);
        this.mesh.setMatrixAt(i * count + j, this.matrix.compose(this.position, this.rotation, this.scale));
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // The grid is drawn in the scene being rendered (each recording has its own).
  placeIn(scene: THREE.Scene) {
    if (this.group.parent !== scene) scene.add(this.group);
  }

  private rebuild() {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
    }
    const count = this.params.count;
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 24, 16), this.material, count * count);
    this.mesh.frustumCulled = false; // the spheres move every frame
    this.group.add(this.mesh);
  }

  private addControls(debug: Debug) {
    const ui: FolderApi | null = debug.folder("Spheres");
    if (!ui) return;
    const { params } = this;
    const updateDisabled = () => this.dependent.forEach((control) => (control.disabled = !params.show));
    ui.addBinding(params, "show").on("change", updateDisabled);
    this.dependent = [
      ui.addBinding(params, "count", { label: "per side", min: 1, max: 40, step: 1 }).on("change", () => this.rebuild()),
      ui.addBinding(params, "spacing", { label: "spacing (m)", min: 0.05, max: 2 }),
      ui.addBinding(params, "radius", { label: "radius (m)", min: 0.01, max: 0.5 }),
      ui.addBinding(params, "height", { label: "height (m)", min: 0, max: 3 }),
      ui.addBinding(params, "offset", { label: "offset (m)", step: 0.05 }),
      ui.addBinding(params, "pattern", { options: { Ripple: "ripple", Wave: "wave" } }),
      ui.addBinding(params, "amplitude", { label: "amplitude (m)", min: 0, max: 2 }),
      ui.addBinding(params, "wavelength", { label: "wavelength (m)", min: 0.2, max: 10 }),
      ui.addBinding(params, "speed", { label: "speed (Hz)", min: 0, max: 3 }),
      ui.addBinding(params, "color").on("change", (e) => this.material.color.set(e.value)),
    ];
    updateDisabled();
  }
}
