import * as THREE from "three";
import type { StreamInfo } from "./Bridge";

const NEAR = 0.05;
const FAR = 50;

// The ZED's left lens: at the origin, looking down -Z. The bridge uses a right-handed,
// Y-up frame in meters, same as three.js. All recordings share this camera.
export class ZedCamera extends THREE.PerspectiveCamera {
  private info: StreamInfo | null = null;

  // Pinhole projection matching the rectified ZED image (OpenGL convention).
  setIntrinsics(info: StreamInfo) {
    this.info = info;
    const { width: w, height: h, fx, fy, cx, cy } = info;
    // prettier-ignore
    this.projectionMatrix.set(
      (2 * fx) / w, 0,            1 - (2 * cx) / w,             0,
      0,            (2 * fy) / h, (2 * cy) / h - 1,             0,
      0,            0,            -(FAR + NEAR) / (FAR - NEAR), (-2 * FAR * NEAR) / (FAR - NEAR),
      0,            0,            -1,                           0,
    );
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    // Not used for projection (the matrix above is), but TransformControls sizes its gizmo from it.
    this.fov = THREE.MathUtils.radToDeg(2 * Math.atan(h / (2 * fy)));
  }

  // The point in the camera frame seen at (u, v) (0..1 from the top-left), `depth` meters away.
  pixelToPoint(u: number, v: number, depth: number): THREE.Vector3 {
    const { width, height, fx, fy, cx, cy } = this.info!;
    const x = ((u * width - cx) * depth) / fx;
    const y = (-(v * height - cy) * depth) / fy;
    return new THREE.Vector3(x, y, -depth);
  }
}
