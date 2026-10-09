import * as THREE from "three";
import type { Bridge, FloorPlane } from "./Bridge";
import type { Debug } from "./Debug";
import type { Feed } from "./Feed";
import type { PlaneShape } from "./Plane";
import type { Recording } from "./Recordings";
import type { Status } from "./Status";
import type { ZedCamera } from "./ZedCamera";

// Fits a true rectangle to 4 corners clicked in order around its outline.
function fitRectangle([a, b, c, d]: THREE.Vector3[]): PlaneShape {
  const center = new THREE.Vector3().add(a).add(b).add(c).add(d).multiplyScalar(0.25);

  // The diagonals of a quad span its best plane, whatever the click order's winding.
  const normal = new THREE.Vector3().crossVectors(c.clone().sub(a), d.clone().sub(b)).normalize();
  if (normal.dot(center) > 0) normal.negate(); // face the camera

  // X follows the average of the two "a→b" edges, flattened onto the plane.
  const xAxis = b.clone().sub(a).add(c.clone().sub(d));
  xAxis.addScaledVector(normal, -xAxis.dot(normal)).normalize();
  const yAxis = new THREE.Vector3().crossVectors(normal, xAxis);

  const width = (Math.abs(b.clone().sub(a).dot(xAxis)) + Math.abs(c.clone().sub(d).dot(xAxis))) / 2;
  const height = (Math.abs(c.clone().sub(b).dot(yAxis)) + Math.abs(d.clone().sub(a).dot(yAxis))) / 2;
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(xAxis, yAxis, normal),
  );
  return { center, quaternion, width, height };
}

// The rectangle around the floor the ZED SDK found: on its plane, its sides along the camera's
// left-right and depth directions, covering the floor seen.
function fitFloor({ normal, center, bounds }: FloorPlane): PlaneShape {
  const zAxis = new THREE.Vector3().fromArray(normal);
  const xAxis = new THREE.Vector3(1, 0, 0).addScaledVector(zAxis, -zAxis.x).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
  const origin = new THREE.Vector3().fromArray(center);
  const min = new THREE.Vector2(Infinity, Infinity);
  const max = new THREE.Vector2(-Infinity, -Infinity);
  for (const point of bounds) {
    const offset = new THREE.Vector3().fromArray(point).sub(origin);
    const p = new THREE.Vector2(offset.dot(xAxis), offset.dot(yAxis));
    min.min(p);
    max.max(p);
  }
  return {
    center: origin.addScaledVector(xAxis, (min.x + max.x) / 2).addScaledVector(yAxis, (min.y + max.y) / 2),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)),
    width: max.x - min.x,
    height: max.y - min.y,
  };
}

// Places planes by clicking 4 corners of a rectangle on the video. Each click is lifted
// to 3D using the real depth at that pixel. "Detect ground plane" adds one around the floor
// the ZED SDK finds instead, and makes it the recording's ground (see Ground.ts). Also handles the keyboard shortcuts:
// Esc cancels the corners, W / E switch the edited plane's gizmo to move / rotate.
export class PlaneTool {
  private readonly params = { placePlanes: false };
  private corners: THREE.Vector3[] = [];
  private readonly markers = new THREE.Group(); // moves to the active recording's scene
  private readonly markerMaterial = new THREE.PointsMaterial({
    color: 0xffee00,
    size: 10,
    sizeAttenuation: false,
    depthTest: false,
  });
  private recording: Recording | null = null;

  constructor(
    private readonly bridge: Bridge,
    private readonly camera: ZedCamera,
    private readonly feed: Feed,
    private readonly status: Status,
    private readonly canvas: HTMLCanvasElement,
    debug: Debug,
  ) {
    const ui = debug.folder("Planes");
    if (ui) {
      ui.addBinding(this.params, "placePlanes", { label: "click to place" });
      ui.addButton({ title: "Detect ground plane" }).on("click", () => {
        if (this.bridge.send({ type: "floor" })) this.status.set("detecting the floor…");
      });
      ui.addButton({ title: "Clear planes" }).on("click", () => {
        this.recording?.clear();
        this.clearCorners();
      });
    }

    canvas.addEventListener("click", (e) => this.onClick(e));
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  // Call when the bridge switches recordings.
  setRecording(recording: Recording) {
    this.clearCorners();
    this.recording = recording;
    recording.scene.add(this.markers);
  }

  // Call with the bridge's reply to "Detect ground plane".
  addFloor(plane: FloorPlane | null, error: string | null) {
    if (!plane || plane.bounds.length < 3) {
      this.status.set(`no floor found: ${error ?? "no outline"}`);
      return;
    }
    this.recording?.addPlane(fitFloor(plane), {}, true, true);
    this.status.set("floor plane added, as the ground");
  }

  private clearCorners() {
    this.corners = [];
    this.markers.children.forEach((m) => (m as THREE.Points).geometry.dispose());
    this.markers.clear();
  }

  private onClick(event: MouseEvent) {
    if (!this.params.placePlanes || !this.recording) return;
    if (this.recording.editedPlane?.gizmoBusy) return;
    const point = this.pointUnderMouse(event);
    if (!point) {
      this.status.set("no depth at this pixel, try again");
      return;
    }
    this.corners.push(point);
    this.markers.add(
      new THREE.Points(new THREE.BufferGeometry().setFromPoints([point]), this.markerMaterial),
    );

    if (this.corners.length === 4) {
      this.recording.addPlane(fitRectangle(this.corners));
      this.clearCorners();
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return; // typing in a Tweakpane field
    if (e.key === "Escape") this.clearCorners();
    const plane = this.recording?.editedPlane;
    if (plane && e.key.toLowerCase() === "w") plane.setMode("translate");
    if (plane && e.key.toLowerCase() === "e") plane.setMode("rotate");
  }

  // The real-world point under the mouse, or null where the ZED has no depth.
  private pointUnderMouse(event: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    const depth = this.feed.sampleDepth(u, v);
    return depth ? this.camera.pixelToPoint(u, v, depth) : null;
  }
}
