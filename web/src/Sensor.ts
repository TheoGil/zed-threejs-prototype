import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { BladeApi, FolderApi } from "tweakpane";
import type { Debug } from "./Debug";
import type { Occlusion } from "./Occlusion";
import type { ZedCamera } from "./ZedCamera";

// A sensor as stored in sensors.json, per recording, in the camera's frame (the scene's):
// position in meters, rotation in degrees (XYZ Euler angles), sizes in meters.
export interface SensorDefinition {
  position: number[];
  rotation: number[];
  width: number; // the long side, which the lasers span
  height: number;
  depth: number;
  lasers: number; // how many
  length: number; // of each laser, in meters
  color: string; // of the lasers
}

// Recording name (the .svo file name without extension) -> its sensor.
export type DefaultSensors = Record<string, SensorDefinition>;

// Where the sensor starts in a recording that has none in sensors.json: 3 m in front of the
// camera, half a meter above it, its lasers pointing down.
const DEFAULT: SensorDefinition = {
  position: [0, 0.5, -3],
  rotation: [0, 0, 0],
  width: 1,
  height: 0.1,
  depth: 0.1,
  lasers: 16,
  length: 5,
  color: "#ff2020",
};

// The sensors live in public/sensors.json. Each change is logged to the browser console:
// paste it under its recording in that file to keep it.
export async function loadSensors(): Promise<DefaultSensors> {
  try {
    const response = await fetch("sensors.json");
    return await response.json();
  } catch (error) {
    console.warn("Could not load sensors.json:", error);
    return {};
  }
}

type Mode = "translate" | "rotate";

// A stand-in for the real sensor: a box with a curtain of evenly spaced lasers out of its
// bottom face (its local -Y), across its whole width (its local X), like a door sensor
// mounted above a doorway. Both go through the occlusion test, so real people and objects
// cut the lasers where they stand. It's placed with a gizmo or with exact values, to try
// lining up a sensor with the camera (its calibration).
export class Sensor {
  private readonly group = new THREE.Group();
  private readonly body: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly lasers: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly control: TransformControls;
  private readonly params = {
    show: true,
    edit: false,
    mode: "translate" as Mode,
    rotation: { x: 0, y: 0, z: 0 }, // degrees, bound to the controls
    width: DEFAULT.width,
    height: DEFAULT.height,
    depth: DEFAULT.depth,
    lasers: DEFAULT.lasers,
    length: DEFAULT.length,
    color: DEFAULT.color,
  };
  private ui: FolderApi | null = null;
  private dependent: BladeApi[] = []; // the controls that only matter while shown
  private recording: string | null = null;
  private readonly edited = new Map<string, SensorDefinition>(); // this session's changes, per recording

  constructor(
    camera: ZedCamera,
    canvas: HTMLCanvasElement,
    occlusion: Occlusion,
    debug: Debug,
    private readonly defaults: DefaultSensors,
  ) {
    this.body = new THREE.Mesh(
      new THREE.BoxGeometry(),
      occlusion.apply(new THREE.MeshStandardMaterial({ color: "#3a3a3a", roughness: 0.6 })),
    );
    this.lasers = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      occlusion.apply(new THREE.LineBasicMaterial({ color: this.params.color })),
    );
    this.lasers.frustumCulled = false; // its bounds change with every edit
    this.group.add(this.body, this.lasers);

    // Translate arrows and rotation rings follow the sensor's own axes.
    this.control = new TransformControls(camera, canvas);
    this.control.setSpace("local");
    this.control.setSize(0.8);
    this.control.attach(this.group);
    this.control.addEventListener("objectChange", () => this.followGizmo());
    this.control.addEventListener("dragging-changed", (e) => !e.value && this.log());

    this.addControls(debug);
    this.apply(DEFAULT);
    this.setEditing(false);
  }

  // Call with each info from the bridge: the sensor follows the scene playing, and keeps this
  // session's changes per recording.
  setRecording(name: string) {
    if (name === this.recording) return;
    if (this.recording) this.edited.set(this.recording, this.definition());
    this.recording = name;
    this.apply(this.edited.get(name) ?? this.defaults[name] ?? DEFAULT);
  }

  // The sensor and its gizmo are drawn in the scene being rendered (each recording has its own).
  placeIn(scene: THREE.Scene) {
    if (this.group.parent === scene) return;
    scene.add(this.group, this.control.getHelper());
  }

  private addControls(debug: Debug) {
    const ui = debug.folder("Sensor");
    if (!ui) return;
    this.ui = ui;
    const { params } = this;
    ui.addBinding(params, "show").on("change", () => this.updateVisible());
    this.dependent = [
      ui.addBinding(params, "edit").on("change", (e) => this.setEditing(e.value)),
      ui.addBinding(params, "mode", { options: { Move: "translate", Rotate: "rotate" } })
        .on("change", (e) => this.control.setMode(e.value)),
      ui.addBinding(this.group, "position", { label: "position (m)", step: 0.01 })
        .on("change", (e) => e.last && this.log()),
      ui.addBinding(params, "rotation", { label: "rotation (°)", step: 0.5 }).on("change", (e) => {
        this.updateRotation();
        if (e.last) this.log();
      }),
      ui.addBinding(params, "width", { label: "width (m)", min: 0.05, max: 5, step: 0.01 })
        .on("change", (e) => this.rebuild(e.last)),
      ui.addBinding(params, "height", { label: "height (m)", min: 0.01, max: 1, step: 0.01 })
        .on("change", (e) => this.rebuild(e.last)),
      ui.addBinding(params, "depth", { label: "depth (m)", min: 0.01, max: 1, step: 0.01 })
        .on("change", (e) => this.rebuild(e.last)),
      ui.addBinding(params, "lasers", { min: 1, max: 128, step: 1 }).on("change", (e) => this.rebuild(e.last)),
      ui.addBinding(params, "length", { label: "laser length (m)", min: 0.1, max: 20, step: 0.1 })
        .on("change", (e) => this.rebuild(e.last)),
      ui.addBinding(params, "color", { label: "laser color" }).on("change", (e) => {
        this.lasers.material.color.set(e.value);
        if (e.last) this.log();
      }),
    ];
  }

  private apply(definition: SensorDefinition) {
    const { position, rotation, ...rest } = definition;
    Object.assign(this.params, structuredClone(rest));
    [this.params.rotation.x, this.params.rotation.y, this.params.rotation.z] = rotation;
    this.group.position.fromArray(position);
    this.updateRotation();
    this.lasers.material.color.set(this.params.color);
    this.rebuild(false);
    this.ui?.refresh();
  }

  // The box and the lasers, from the sizes and the laser settings.
  private rebuild(log: boolean) {
    const { width, height, depth, lasers, length } = this.params;
    this.body.geometry.dispose();
    this.body.geometry = new THREE.BoxGeometry(width, height, depth);
    // Evenly spaced across the whole width, ends included (a single laser sits in the middle),
    // from the bottom face straight down.
    const positions: number[] = [];
    for (let i = 0; i < lasers; i++) {
      const x = lasers === 1 ? 0 : -width / 2 + (width * i) / (lasers - 1);
      positions.push(x, -height / 2, 0, x, -height / 2 - length, 0);
    }
    this.lasers.geometry.dispose();
    this.lasers.geometry = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    if (log) this.log();
  }

  private updateRotation() {
    const { x, y, z } = this.params.rotation;
    const toRad = THREE.MathUtils.degToRad;
    this.group.rotation.set(toRad(x), toRad(y), toRad(z));
  }

  // While dragging the gizmo: the rotation controls follow it.
  private followGizmo() {
    const toDeg = THREE.MathUtils.radToDeg;
    const { x, y, z } = this.group.rotation;
    this.params.rotation = { x: toDeg(x), y: toDeg(y), z: toDeg(z) };
    this.ui?.refresh();
  }

  private setEditing(on: boolean) {
    this.params.edit = on;
    this.control.enabled = on && this.params.show;
    this.control.getHelper().visible = on && this.params.show;
    this.ui?.refresh();
  }

  private updateVisible() {
    this.group.visible = this.params.show;
    this.dependent.forEach((control) => (control.disabled = !this.params.show));
    this.setEditing(this.params.edit);
  }

  private definition(): SensorDefinition {
    const round = (n: number) => Math.round(n * 1e4) / 1e4;
    const { width, height, depth, lasers, length, color, rotation } = this.params;
    return {
      position: this.group.position.toArray().map(round),
      rotation: [rotation.x, rotation.y, rotation.z].map(round),
      width,
      height,
      depth,
      lasers,
      length,
      color,
    };
  }

  // Logs the sensor's definition, to paste into sensors.json under its recording.
  private log() {
    console.log(`${this.recording} › sensor (paste into web/public/sensors.json):`, JSON.stringify(this.definition()));
  }
}
