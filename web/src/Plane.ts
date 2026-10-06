import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { FolderApi } from "tweakpane";
import type { Recording } from "./Recordings";

// Where a plane is and how big: a rectangle centered on `center`, its normal (+Z) facing the camera.
export interface PlaneShape {
  center: THREE.Vector3;
  quaternion: THREE.Quaternion;
  width: number;
  height: number;
}

export interface PlaneStyle {
  color?: string;
  alpha?: number;
  thickness?: number;
}

// A plane as stored in default-planes.json. `matrix` is Matrix4.elements (column-major),
// for Matrix4.fromArray().
export interface PlaneDefinition extends PlaneStyle {
  matrix: number[];
  width: number;
  height: number;
}

type Mode = "translate" | "rotate";

export function shapeFromDefinition({ matrix, width, height }: PlaneDefinition): PlaneShape {
  const center = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  new THREE.Matrix4().fromArray(matrix).decompose(center, quaternion, new THREE.Vector3());
  return { center, quaternion, width, height };
}

// A slab that sits on the fitted surface and grows toward the camera (+Z is the normal).
function slabGeometry(width: number, height: number, thickness: number) {
  return new THREE.BoxGeometry(width, height, thickness).translate(0, 0, thickness / 2);
}

// A see-through, occludable slab in a recording, with a TransformControls gizmo to move it.
// The gizmo moves the whole plane, so it always stays a rectangle.
export class Plane {
  readonly settings: {
    edit: boolean;
    mode: Mode;
    color: string;
    alpha: number;
    thickness: number;
  };
  private readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly control: TransformControls;
  private readonly folder: FolderApi | null;
  private lastDragEnd = 0;

  constructor(
    private readonly recording: Recording,
    private readonly shape: PlaneShape,
    style: PlaneStyle,
    private readonly title: string,
  ) {
    const { camera, canvas, occlusion } = recording.context;
    this.settings = {
      edit: false,
      mode: "translate",
      color: style.color ?? "#" + new THREE.Color().setHSL(Math.random(), 0.7, 0.55).getHexString(),
      alpha: style.alpha ?? 0.75,
      thickness: style.thickness ?? 0.02,
    };
    const material = occlusion.apply(
      new THREE.MeshStandardMaterial({
        color: this.settings.color,
        transparent: true,
        opacity: this.settings.alpha,
      }),
    );
    this.mesh = new THREE.Mesh(slabGeometry(shape.width, shape.height, this.settings.thickness), material);
    this.mesh.quaternion.copy(shape.quaternion);
    this.mesh.position.copy(shape.center);
    recording.scene.add(this.mesh);

    // Translate arrows and rotation rings follow the plane's own axes. Rotate mode also has
    // the free "trackball" rotation: drag inside the rings, away from any axis.
    this.control = new TransformControls(camera, canvas);
    this.control.setSpace("local");
    this.control.setSize(0.8);
    this.control.attach(this.mesh);
    this.control.addEventListener("dragging-changed", (e) => {
      if (e.value) return;
      this.lastDragEnd = performance.now();
      this.log();
    });
    recording.scene.add(this.control.getHelper());

    this.folder = recording.folder?.addFolder({ title }) ?? null;
    if (this.folder) this.addControls(this.folder);
    this.setEditing(false);
  }

  get editing() {
    return this.settings.edit;
  }

  // True while the pointer is on the gizmo or a drag just ended: that click isn't for placing corners.
  get gizmoBusy() {
    return performance.now() - this.lastDragEnd < 200 || this.control.axis !== null;
  }

  // Use Recording.setEditing() instead, which keeps a single gizmo visible.
  setEditing(on: boolean) {
    this.settings.edit = on;
    this.control.enabled = on;
    this.control.getHelper().visible = on;
    this.folder?.refresh();
  }

  setMode(mode: Mode) {
    this.settings.mode = mode;
    this.control.setMode(mode);
    this.folder?.refresh();
  }

  // Logs this plane's definition, to paste into default-planes.json under its recording.
  log() {
    this.mesh.updateMatrix();
    const round = (n: number) => Math.round(n * 1e5) / 1e5;
    const { thickness, color, alpha } = this.settings;
    const definition: PlaneDefinition = {
      matrix: this.mesh.matrix.elements.map(round),
      width: round(this.shape.width),
      height: round(this.shape.height),
      thickness,
      color,
      alpha,
    };
    console.log(`${this.recording.name} › ${this.title}:`, definition);
  }

  dispose() {
    this.recording.scene.remove(this.mesh, this.control.getHelper());
    this.control.detach();
    this.control.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.folder) this.recording.folder?.remove(this.folder);
  }

  // e.last: log once when a slider is released, not on every step of the drag.
  private addControls(folder: FolderApi) {
    const { settings, mesh, shape } = this;
    // Compare with the gizmo itself: Tweakpane has already written e.value into settings.edit.
    folder
      .addBinding(settings, "edit")
      .on("change", (e) => e.value !== this.control.enabled && this.recording.setEditing(this, e.value));
    folder
      .addBinding(settings, "mode", { options: { "Move (W)": "translate", "Rotate (E)": "rotate" } })
      .on("change", (e) => this.control.setMode(e.value));
    folder.addButton({ title: "Reset position" }).on("click", () => {
      mesh.position.copy(shape.center);
      mesh.quaternion.copy(shape.quaternion);
      this.log();
    });
    folder.addBinding(settings, "color").on("change", (e) => {
      mesh.material.color.set(e.value);
      if (e.last) this.log();
    });
    folder.addBinding(settings, "alpha", { min: 0, max: 1 }).on("change", (e) => {
      mesh.material.opacity = e.value;
      if (e.last) this.log();
    });
    folder
      .addBinding(settings, "thickness", { label: "thickness (m)", min: 0.001, max: 1 })
      .on("change", (e) => {
        mesh.geometry.dispose();
        mesh.geometry = slabGeometry(shape.width, shape.height, e.value);
        if (e.last) this.log();
      });
    folder.addButton({ title: "Remove" }).on("click", () => this.recording.removePlane(this));
  }
}
