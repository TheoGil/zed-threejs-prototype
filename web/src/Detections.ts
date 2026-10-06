import * as THREE from "three";
import type { FolderApi } from "tweakpane";
import type { Bridge } from "./Bridge";
import type { Debug } from "./Debug";

// ZED SDK object detection in the bridge (DETECTION_SETTINGS in bridge.py, plus whether it could start).
export interface DetectionInfo {
  enabled: boolean;
  model: (typeof MODELS)[number];
  confidence: number; // 1-99, objects detected with less are dropped
  error: string | null; // why detection couldn't start, if it couldn't
}

const MODELS = [
  "MULTI_CLASS_BOX_FAST",
  "MULTI_CLASS_BOX_MEDIUM",
  "MULTI_CLASS_BOX_ACCURATE",
  "PERSON_HEAD_BOX_FAST",
  "PERSON_HEAD_BOX_ACCURATE",
] as const;

// One object detected in a frame (object_info() in bridge.py). 3D values in meters, in the
// camera's frame (the scene's); null where unknown.
export interface DetectedObject {
  id: number; // stable while the object is tracked
  label: string; // PERSON, VEHICLE, BAG, ANIMAL, ELECTRONICS, FRUIT_VEGETABLE, SPORT
  sublabel: string; // finer: CAR, BUS, BICYCLE, BACKPACK, PERSON_HEAD...
  confidence: number; // 0-100
  tracking: "OK" | "OFF" | "SEARCHING" | "TERMINATE"; // SEARCHING: lost for now, position predicted
  moving: boolean;
  position: (number | null)[]; // x, y, z
  velocity: (number | null)[]; // meters per second
  dimensions: (number | null)[]; // width, height, length
  box3d: (number | null)[][]; // 8 corners: 0-3 one horizontal face, 4-7 the other, i above or below i+4
  box2d: (number | null)[][]; // 4 corners in video pixels, clockwise from the top-left
}

const COLORS: Record<string, string> = { PERSON: "#ff4fd8", VEHICLE: "#33ccff" };
const OTHER_COLOR = "#ffd400";
// The 12 edges of a box, as pairs of corners (see DetectedObject.box3d).
const EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
const LABEL_HEIGHT = 0.04; // share of the view's height

// One object's 3D box and label, kept while the bridge keeps detecting it.
class Marker {
  readonly group = new THREE.Group();
  private readonly positions = new Float32Array(EDGES.length * 3);
  private readonly lines: THREE.LineSegments;
  private readonly label: THREE.Sprite;

  constructor(object: DetectedObject) {
    const color = COLORS[object.label] ?? OTHER_COLOR;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    // Drawn over everything: they're for checking what the bridge sees, not part of the scene.
    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1000;
    this.label = makeLabel(`${object.sublabel.toLowerCase()} #${object.id}`, color);
    this.group.add(this.lines, this.label);
  }

  // false if the object has no 3D box in this frame.
  update(object: DetectedObject): boolean {
    if (object.box3d.length !== 8 || object.box3d.some((c) => c.includes(null))) return false;
    const corners = object.box3d as number[][];
    EDGES.forEach((corner, i) => this.positions.set(corners[corner], i * 3));
    this.lines.geometry.attributes.position.needsUpdate = true;
    // The label sits above the middle of the box.
    const x = corners.reduce((sum, c) => sum + c[0], 0) / 8;
    const z = corners.reduce((sum, c) => sum + c[2], 0) / 8;
    this.label.position.set(x, Math.max(...corners.map((c) => c[1])), z);
    // Fainter while the SDK only predicts where it is.
    const opacity = object.tracking === "OK" ? 1 : 0.4;
    (this.lines.material as THREE.Material).opacity = opacity;
    this.label.material.opacity = opacity;
    return true;
  }

  dispose() {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}

// A text label that keeps its size on screen, sitting above its position.
function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const font = "bold 28px sans-serif";
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + 16;
  canvas.height = 40;
  context.font = font; // resizing the canvas resets it
  context.fillStyle = "rgba(0, 0, 0, 0.6)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(text, 8, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, sizeAttenuation: false }),
  );
  sprite.center.set(0.5, 0);
  sprite.scale.set((LABEL_HEIGHT * canvas.width) / canvas.height, LABEL_HEIGHT, 1);
  sprite.renderOrder = 1001;
  return sprite;
}

// The objects the ZED SDK detects (in the bridge), with each frame: drawn as 3D boxes with
// their label and tracking id, to see what it finds and whether it lines up with the video.
// `objects` holds the last frame's, for content that reacts to them.
// Controls: whether the bridge detects and with which model, and whether the page draws them.
export class Detections {
  readonly group = new THREE.Group();
  objects: DetectedObject[] = [];
  private readonly params = {
    show: true,
    enabled: true,
    model: "MULTI_CLASS_BOX_FAST" as DetectionInfo["model"],
    confidence: 50,
    status: "waiting for the bridge",
    count: 0,
  };
  private readonly markers = new Map<number, Marker>();
  private ui: FolderApi | null = null;
  private bridge: Bridge | null = null;
  private applied: DetectionInfo | null = null; // as last reported by the bridge

  // Called by App once the bridge exists, at this folder's place in the pane.
  addControls(debug: Debug, bridge: Bridge) {
    this.bridge = bridge;
    const ui = debug.folder("Objects");
    if (!ui) return;
    this.ui = ui;
    ui.addBinding(this.params, "show", { label: "show boxes" }).on("change", () => this.updateVisible());
    ui.addBinding(this.params, "status", { readonly: true });
    ui.addBinding(this.params, "count", { label: "objects", readonly: true, format: (v) => v.toFixed(0) });
    ui.addBinding(this.params, "enabled", { label: "detection (bridge)" })
      .on("change", (e) => this.change("enabled", e.value, e.last));
    ui.addBinding(this.params, "model", {
      options: {
        "Multi-class fast": "MULTI_CLASS_BOX_FAST",
        "Multi-class medium": "MULTI_CLASS_BOX_MEDIUM",
        "Multi-class accurate": "MULTI_CLASS_BOX_ACCURATE",
        "Heads fast": "PERSON_HEAD_BOX_FAST",
        "Heads accurate": "PERSON_HEAD_BOX_ACCURATE",
      },
    }).on("change", (e) => this.change("model", e.value, e.last));
    ui.addBinding(this.params, "confidence", { label: "min confidence", min: 1, max: 99, step: 1 })
      .on("change", (e) => this.change("confidence", e.value, e.last));
  }

  // Call with each info from the bridge.
  sync(info: DetectionInfo) {
    this.applied = info;
    this.params.enabled = info.enabled;
    this.params.model = info.model;
    this.params.confidence = info.confidence;
    this.params.status = info.error ? `unavailable: ${info.error}` : info.enabled ? "on" : "off";
    this.ui?.refresh();
  }

  // Call with each frame's objects (null when detection is off).
  update(objects: DetectedObject[] | null) {
    this.objects = objects ?? [];
    const seen = new Set<number>();
    for (const object of this.objects) {
      let marker = this.markers.get(object.id);
      if (!marker) {
        marker = new Marker(object);
        this.markers.set(object.id, marker);
        this.group.add(marker.group);
      }
      marker.group.visible = marker.update(object);
      seen.add(object.id);
    }
    for (const [id, marker] of this.markers) {
      if (seen.has(id)) continue;
      this.group.remove(marker.group);
      marker.dispose();
      this.markers.delete(id);
    }
    this.params.count = this.objects.length;
  }

  // The boxes are drawn in the scene being rendered (each recording has its own).
  placeIn(scene: THREE.Scene) {
    if (this.group.parent !== scene) scene.add(this.group);
    this.updateVisible();
  }

  private updateVisible() {
    this.group.visible = this.params.show;
  }

  private change<K extends "enabled" | "model" | "confidence">(key: K, value: DetectionInfo[K], last: boolean) {
    if (!last || value === this.applied?.[key]) return; // mid-drag, or the controls following the bridge
    const sent = this.bridge?.send({ type: "detection", settings: { [key]: value } });
    // A new model takes a second, but the first time it's used the SDK optimizes it for the GPU:
    // up to half an hour (heads fast: 33 min), during which the bridge sends nothing (see its log).
    if (sent && key !== "confidence")
      this.bridge!.waitForInfo("loading object detection (a model's first use: up to 30 min, see the bridge log)…");
  }
}
