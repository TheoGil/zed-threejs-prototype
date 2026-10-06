import * as THREE from "three";
import type { Frame } from "./Bridge";

// Depth beyond the ZED's range arrives as 65535 mm (see bridge.py): about 65 m,
// past the camera's far plane, so it never occludes.
const TOO_FAR = 65;

// The latest frame from the bridge, as textures: the color video, the real-world depth,
// and people's alpha matte when the bridge sends one.
export class Feed {
  readonly video = new THREE.Texture();
  // White = person, at video size. Linear data: no color space. hasMatte: whether the last frame had one.
  readonly matte = new THREE.Texture();
  readonly hasMatte = { value: false };
  // Depth in meters, 0 = unknown, 65.535 = too far. Shared as a uniform, so the materials
  // that use it follow when the texture is replaced for a new size.
  readonly depth: { value: THREE.DataTexture | null } = { value: null };
  private depthData = new Float32Array(0);
  private depthWidth = 0;
  private depthHeight = 0;

  constructor() {
    this.video.colorSpace = THREE.SRGBColorSpace;
  }

  setDepthSize(width: number, height: number) {
    this.depthWidth = width;
    this.depthHeight = height;
    this.depthData = new Float32Array(width * height);
    this.depth.value?.dispose();
    const texture = new THREE.DataTexture(
      this.depthData,
      width,
      height,
      THREE.RedFormat,
      THREE.FloatType,
    );
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    this.depth.value = texture;
  }

  // Updates color and depth together so they stay in sync.
  update({ image, depthMm, matte }: Frame) {
    // A frame decoded while the depth size changed belongs to the old size: skip it.
    if (depthMm.length !== this.depthData.length) return;
    this.video.image = image;
    this.video.needsUpdate = true;
    this.hasMatte.value = !!matte;
    if (matte) {
      this.matte.image = matte;
      this.matte.needsUpdate = true;
    }
    const depth = this.depthData;
    for (let i = 0; i < depth.length; i++) depth[i] = depthMm[i] * 0.001;
    this.depth.value!.needsUpdate = true;
  }

  // Median of the valid depths around (u, v), in meters, 0 if none. u, v are 0..1 from the top-left.
  sampleDepth(u: number, v: number, radius = 3): number {
    const w = this.depthWidth;
    const h = this.depthHeight;
    const px = Math.floor(u * w);
    const py = Math.floor(v * h);
    const values: number[] = [];
    for (let y = py - radius; y <= py + radius; y++) {
      for (let x = px - radius; x <= px + radius; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const d = this.depthData[y * w + x];
        if (d > 0 && d < TOO_FAR) values.push(d);
      }
    }
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
  }
}
