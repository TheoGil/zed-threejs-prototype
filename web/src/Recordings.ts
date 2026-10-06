import * as THREE from "three";
import type { FolderApi } from "tweakpane";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";
import type { Occlusion } from "./Occlusion";
import { Plane, shapeFromDefinition, type PlaneDefinition, type PlaneShape, type PlaneStyle } from "./Plane";
import type { ZedCamera } from "./ZedCamera";

// What planes need from the app.
export interface PlaneContext {
  camera: ZedCamera;
  canvas: HTMLCanvasElement;
  occlusion: Occlusion;
}

// Recording name (the .svo file name without extension) -> its planes.
export type DefaultPlanes = Record<string, PlaneDefinition[]>;

// The planes created on page load live in public/default-planes.json, which the Unity
// prototype reads too. Each plane's definition is logged to the browser console whenever
// it's created or edited: paste it under its recording in that file to keep the plane.
export async function loadDefaultPlanes(): Promise<DefaultPlanes> {
  try {
    const response = await fetch("default-planes.json");
    return await response.json();
  } catch (error) {
    console.warn("Could not load default-planes.json:", error);
    return {};
  }
}

// One recording (or the live camera): its own THREE.Scene with lights and planes,
// and its own folder under "Planes".
export class Recording {
  readonly scene = new THREE.Scene();
  readonly planes: Plane[] = [];
  readonly folder: FolderApi | null;
  private count = 0;

  constructor(
    readonly name: string,
    readonly context: PlaneContext,
    feed: Feed,
    debug: Debug,
    definitions: PlaneDefinition[],
  ) {
    this.scene.background = feed.video;
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(1, 2, 1);
    this.scene.add(sun);

    this.folder = debug.folder("Planes")?.addFolder({ title: name, hidden: true, expanded: false }) ?? null;
    definitions.forEach((definition) =>
      this.addPlane(shapeFromDefinition(definition), definition, false),
    );
  }

  get editedPlane() {
    return this.planes.find((plane) => plane.editing);
  }

  // `style` overrides the default look; `startEditing` shows the gizmo.
  addPlane(shape: PlaneShape, style: PlaneStyle = {}, startEditing = true) {
    const plane = new Plane(this, shape, style, `Plane ${++this.count}`);
    this.planes.push(plane);
    this.setEditing(plane, startEditing);
    plane.log();
  }

  removePlane(plane: Plane) {
    plane.dispose();
    this.planes.splice(this.planes.indexOf(plane), 1);
  }

  clear() {
    [...this.planes].forEach((plane) => this.removePlane(plane));
  }

  // Shows or hides the gizmo of `plane`. Only one plane shows its gizmo at a time.
  setEditing(plane: Plane, on: boolean) {
    if (on) this.planes.forEach((other) => other !== plane && other.editing && other.setEditing(false));
    plane.setEditing(on);
  }

  setActive(active: boolean) {
    // Hide the gizmo so it doesn't catch clicks on the next recording.
    if (!active) this.editedPlane?.setEditing(false);
    if (this.folder) this.folder.hidden = !active;
  }
}

// One Recording per scene the bridge plays. Only the active one is rendered,
// and only its folder is shown.
export class Recordings {
  active: Recording | null = null;
  private readonly all = new Map<string, Recording>();
  private readonly empty = new THREE.Scene(); // rendered until the bridge says what's playing

  constructor(
    private readonly context: PlaneContext,
    private readonly feed: Feed,
    private readonly debug: Debug,
    private readonly defaults: DefaultPlanes,
  ) {
    this.empty.background = feed.video;
  }

  get scene() {
    return this.active?.scene ?? this.empty;
  }

  activate(name: string): Recording {
    let next = this.all.get(name);
    if (!next) {
      next = new Recording(name, this.context, this.feed, this.debug, this.defaults[name] ?? []);
      this.all.set(name, next);
    }
    if (next !== this.active) {
      this.active?.setActive(false);
      next.setActive(true);
      this.active = next;
    }
    return next;
  }
}
