import * as THREE from "three";
import type { BladeApi, FolderApi } from "tweakpane";
import type { Bridge } from "./Bridge";
import type { Debug } from "./Debug";
import type { ZedCamera } from "./ZedCamera";

// ZED SDK object detection in the bridge (DETECTION_SETTINGS in bridge.py, plus whether it could start).
export interface DetectionInfo {
  enabled: boolean;
  model: (typeof MODELS)[number];
  confidence: number; // 1-99, objects detected with less are dropped
  masks: boolean; // each object's mask (the SDK's segmentation), sent with the frames
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
const MASK_OPACITY = 0.6;
const MAX_MASKS = 255; // object indices in the masks image are 1..255

// Draws the objects' masks over the video, each in its object's color (uPalette, by index).
const MASK_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const MASK_FRAGMENT = /* glsl */ `
  uniform sampler2D uObjectMasks;
  uniform sampler2D uPalette;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float index = floor(texture2D(uObjectMasks, vUv).r * 255.0 + 0.5);
    if (index < 0.5) discard;
    // The palette holds sRGB colors, written as is to the (sRGB) canvas.
    gl_FragColor = vec4(texture2D(uPalette, vec2((index + 0.5) / 256.0, 0.5)).rgb, uOpacity);
  }`;

// Where a 2D box is drawn: its corners' camera rays, at this distance. Any distance projects
// onto the same pixels; the boxes are drawn over everything anyway.
const BOX_2D_DEPTH = 1; // meters

// Which boxes to draw, and how to place a video pixel (x, y) in the scene for the 2D ones.
interface Show {
  box3d: boolean;
  box2d: boolean;
  pixelToPoint: (x: number, y: number, depth: number) => THREE.Vector3;
}

// One object's 3D box, 2D box and label, kept while the bridge keeps detecting it.
class Marker {
  readonly group = new THREE.Group();
  private readonly material: THREE.LineBasicMaterial;
  private readonly box3d: THREE.LineSegments;
  private readonly box2d: THREE.LineSegments;
  private readonly label: THREE.Sprite;

  constructor(object: DetectedObject) {
    const color = COLORS[object.label] ?? OTHER_COLOR;
    // Drawn over everything: they're for checking what the bridge sees, not part of the scene.
    this.material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    this.box3d = makeLines(EDGES.length, this.material);
    this.box2d = makeLines(8, this.material);
    this.label = makeLabel(`${object.sublabel.toLowerCase()} #${object.id}`, color);
    this.group.add(this.box3d, this.box2d, this.label);
  }

  update(object: DetectedObject, show: Show) {
    const has3d = object.box3d.length === 8 && !object.box3d.some((c) => c.includes(null));
    const has2d = object.box2d.length === 4 && !object.box2d.some((c) => c.includes(null));
    this.box3d.visible = show.box3d && has3d;
    this.box2d.visible = show.box2d && has2d;
    this.label.visible = this.box3d.visible || this.box2d.visible;

    if (this.box3d.visible) {
      const corners = object.box3d as number[][];
      const positions = this.box3d.geometry.attributes.position as THREE.BufferAttribute;
      EDGES.forEach((corner, i) => positions.setXYZ(i, corners[corner][0], corners[corner][1], corners[corner][2]));
      positions.needsUpdate = true;
      // The label sits above the middle of the box.
      const x = corners.reduce((sum, c) => sum + c[0], 0) / 8;
      const z = corners.reduce((sum, c) => sum + c[2], 0) / 8;
      this.label.position.set(x, Math.max(...corners.map((c) => c[1])), z);
    }
    if (this.box2d.visible) {
      const corners = (object.box2d as number[][]).map(([x, y]) => show.pixelToPoint(x, y, BOX_2D_DEPTH));
      const positions = this.box2d.geometry.attributes.position as THREE.BufferAttribute;
      corners.forEach((corner, i) => {
        positions.setXYZ(2 * i, corner.x, corner.y, corner.z);
        const next = corners[(i + 1) % 4];
        positions.setXYZ(2 * i + 1, next.x, next.y, next.z);
      });
      positions.needsUpdate = true;
      // Without the 3D box, the label sits above the middle of the 2D box's top edge.
      if (!this.box3d.visible) this.label.position.lerpVectors(corners[0], corners[1], 0.5);
    }
  }

  dispose() {
    this.box3d.geometry.dispose();
    this.box2d.geometry.dispose();
    this.material.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}

function makeLines(vertices: number, material: THREE.LineBasicMaterial): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 1000;
  return lines;
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

// The objects the ZED SDK detects (in the bridge), with each frame: drawn as 3D or 2D boxes
// with their label and tracking id, to see what it finds and whether it lines up with the video,
// and with "show mask", their masks in the same colors.
// `objects` holds the last frame's, for content that reacts to them.
// Controls (the "Object Detection" folder): whether the bridge detects and with which model, and
// whether the page draws them. With detection off, the controls that depend on it are disabled.
// If detection can't start, the bridge's log says why.
export class Detections {
  readonly group = new THREE.Group();
  objects: DetectedObject[] = [];
  // The last frame's masks (see Frame.objectMasks), for the overlay and DepthView.
  // uObjectMasksOn: the last frame had them.
  readonly maskUniforms = {
    uObjectMasks: { value: makeMaskTexture() },
    uObjectMasksOn: { value: false },
  };
  private readonly palette = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1); // index -> sRGB color
  private readonly maskOverlay: THREE.Mesh;
  private readonly params = {
    boxes: "3d" as "none" | "3d" | "2d",
    masks: false,
    enabled: false,
    model: "MULTI_CLASS_BOX_FAST" as DetectionInfo["model"],
    confidence: 50,
    count: 0,
  };
  private readonly markers = new Map<number, Marker>();
  private ui: FolderApi | null = null;
  private dependent: BladeApi[] = []; // the controls that only matter with detection on
  private bridge: Bridge | null = null;
  private applied: DetectionInfo | null = null; // as last reported by the bridge

  constructor(private readonly camera: ZedCamera) {
    this.palette.minFilter = this.palette.magFilter = THREE.NearestFilter;
    this.maskOverlay = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { ...this.maskUniforms, uPalette: { value: this.palette }, uOpacity: { value: MASK_OPACITY } },
        vertexShader: MASK_VERTEX,
        fragmentShader: MASK_FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.maskOverlay.frustumCulled = false;
    this.maskOverlay.renderOrder = 999; // over the scene, under the boxes
    this.maskOverlay.visible = false;
    this.group.add(this.maskOverlay);
  }

  // Called by App once the bridge exists, at this folder's place in the pane.
  addControls(debug: Debug, bridge: Bridge) {
    this.bridge = bridge;
    const ui = debug.folder("Object Detection");
    if (!ui) return;
    this.ui = ui;
    ui.addBinding(this.params, "enabled", { label: "enable" }).on("change", (e) => {
      this.change("enabled", e.value, e.last);
      this.updateDisabled();
    });
    this.dependent = [
      ui.addBinding(this.params, "boxes", { options: { None: "none", "3D": "3d", "2D": "2d" } })
        .on("change", () => this.update(this.objects)),
      // Masks cost the bridge about 15 ms per frame, so it only computes them while shown.
      ui.addBinding(this.params, "masks", { label: "show mask" })
        .on("change", (e) => this.change("masks", e.value, e.last)),
      ui.addBinding(this.params, "count", { label: "objects", readonly: true, format: (v) => v.toFixed(0) }),
      ui.addBinding(this.params, "model", {
        options: {
          "Multi-class fast": "MULTI_CLASS_BOX_FAST",
          "Multi-class medium": "MULTI_CLASS_BOX_MEDIUM",
          "Multi-class accurate": "MULTI_CLASS_BOX_ACCURATE",
          "Heads fast": "PERSON_HEAD_BOX_FAST",
          "Heads accurate": "PERSON_HEAD_BOX_ACCURATE",
        },
      }).on("change", (e) => this.change("model", e.value, e.last)),
      ui.addBinding(this.params, "confidence", { label: "min confidence", min: 1, max: 99, step: 1 })
        .on("change", (e) => this.change("confidence", e.value, e.last)),
    ];
  }

  // Call with each info from the bridge.
  sync(info: DetectionInfo) {
    this.applied = info;
    this.params.enabled = info.enabled;
    this.params.model = info.model;
    this.params.confidence = info.confidence;
    this.params.masks = info.masks;
    this.ui?.refresh();
    this.updateDisabled();
  }

  // Call with each frame's objects (null when detection is off).
  update(objects: DetectedObject[] | null) {
    this.objects = objects ?? [];
    const info = this.bridge?.info;
    const show: Show = {
      box3d: this.params.boxes === "3d",
      box2d: this.params.boxes === "2d" && !!info,
      // box2d is in video pixels; pixelToPoint takes 0..1 from the top-left.
      pixelToPoint: (x, y, depth) => this.camera.pixelToPoint(x / info!.width, y / info!.height, depth),
    };
    const seen = new Set<number>();
    for (const object of this.objects) {
      let marker = this.markers.get(object.id);
      if (!marker) {
        marker = new Marker(object);
        this.markers.set(object.id, marker);
        this.group.add(marker.group);
      }
      marker.update(object, show);
      seen.add(object.id);
    }
    for (const [id, marker] of this.markers) {
      if (seen.has(id)) continue;
      this.group.remove(marker.group);
      marker.dispose();
      this.markers.delete(id);
    }
    this.params.count = this.objects.length;
    this.updatePalette();
  }

  // Call with each frame's masks (null when masks are off).
  setMasks(image: HTMLImageElement | null) {
    const on = !!image;
    this.maskUniforms.uObjectMasksOn.value = on;
    this.maskOverlay.visible = on;
    if (!image) return;
    this.maskUniforms.uObjectMasks.value.image = image;
    this.maskUniforms.uObjectMasks.value.needsUpdate = true;
  }

  // Each object's color at its index in the masks (1 + its index in `objects`).
  private updatePalette() {
    const data = this.palette.image.data as Uint8Array;
    this.objects.slice(0, MAX_MASKS).forEach((object, i) => {
      const hex = parseInt((COLORS[object.label] ?? OTHER_COLOR).slice(1), 16);
      data.set([hex >> 16, (hex >> 8) & 255, hex & 255, 255], (i + 1) * 4);
    });
    this.palette.needsUpdate = true;
  }

  // The boxes are drawn in the scene being rendered (each recording has its own).
  placeIn(scene: THREE.Scene) {
    if (this.group.parent !== scene) scene.add(this.group);
  }

  private updateDisabled() {
    this.dependent.forEach((control) => (control.disabled = !this.params.enabled));
  }

  private change<K extends "enabled" | "model" | "confidence" | "masks">(key: K, value: DetectionInfo[K], last: boolean) {
    if (!last || value === this.applied?.[key]) return; // mid-drag, or the controls following the bridge
    const sent = this.bridge?.send({ type: "detection", settings: { [key]: value } });
    // A new model (or masks on or off) takes a second, but the first time a model is used the SDK
    // optimizes it for the GPU: up to half an hour (heads fast: 33 min), during which the bridge
    // sends nothing (see its log).
    if (sent && key !== "confidence")
      this.bridge!.waitForInfo("loading object detection (a model's first use: up to 30 min, see the bridge log)…");
  }
}

// The masks image holds object indices, not colors: read exactly, never blended or color-converted.
function makeMaskTexture(): THREE.Texture {
  const texture = new THREE.Texture();
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
