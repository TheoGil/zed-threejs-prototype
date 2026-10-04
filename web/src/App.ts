import * as THREE from "three";
import { Bridge, type StreamInfo } from "./Bridge";
import { Debug } from "./Debug";
import { DepthView } from "./DepthView";
import { Feed } from "./Feed";
import { Occlusion } from "./Occlusion";
import { PlaneTool } from "./PlaneTool";
import { Recordings, type DefaultPlanes } from "./Recordings";
import { Status } from "./Status";
import { ZedCamera } from "./ZedCamera";
import { ZedSettings } from "./ZedSettings";

// Owns the renderer and every module, wires them together, and runs the render loop:
// the ZED video as the background, with occludable 3D content on top.
export class App {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly camera = new ZedCamera();
  private readonly debug = new Debug();
  private readonly status = new Status();
  private readonly feed = new Feed();
  private readonly occlusion: Occlusion;
  private readonly bridge: Bridge;
  private readonly zedSettings: ZedSettings;
  private readonly depthView: DepthView;
  private readonly planeTool: PlaneTool;
  private readonly recordings: Recordings;

  // The order sets the order of the controls in the debug pane.
  constructor(defaultPlanes: DefaultPlanes) {
    const canvas = this.renderer.domElement;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(canvas);

    this.occlusion = new Occlusion(this.feed, this.debug);
    this.bridge = new Bridge(
      { onInfo: (info) => this.onInfo(info), onFrame: (frame) => this.feed.update(frame) },
      this.status,
      this.debug,
    );
    this.depthView = new DepthView(this.feed, this.debug);
    this.zedSettings = new ZedSettings(this.bridge, this.debug);
    this.planeTool = new PlaneTool(this.camera, this.feed, this.status, canvas, this.debug);
    this.recordings = new Recordings(
      { camera: this.camera, canvas, occlusion: this.occlusion },
      this.feed,
      this.debug,
      defaultPlanes,
    );

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  // On connect and after each scene switch or depth settings change: the intrinsics
  // or the depth size may have changed, so the camera re-aligns and the textures resize.
  private onInfo(info: StreamInfo) {
    this.camera.setIntrinsics(info);
    this.feed.setDepthSize(info.depthWidth, info.depthHeight);
    this.resize();
    this.zedSettings.sync(info.depth);
    this.planeTool.setRecording(this.recordings.activate(info.scene));
  }

  // Fits the canvas to the window while keeping the video's aspect ratio.
  private resize() {
    const info = this.bridge.info;
    const aspect = info ? info.width / info.height : 16 / 9;
    const width = Math.min(window.innerWidth, window.innerHeight * aspect);
    this.renderer.setSize(Math.floor(width), Math.floor(width / aspect));
    this.occlusion.setResolution(this.renderer);
  }

  private render() {
    this.debug.begin();
    if (this.depthView.active) this.depthView.render(this.renderer);
    else this.renderer.render(this.recordings.scene, this.camera);
    this.debug.end();
  }
}
