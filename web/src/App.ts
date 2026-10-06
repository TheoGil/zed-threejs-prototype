import * as THREE from "three";
import { Background } from "./Background";
import { Bridge, type StreamInfo } from "./Bridge";
import { Debug } from "./Debug";
import { DepthView } from "./DepthView";
import { Feed } from "./Feed";
import { Ground } from "./Ground";
import { Occluder } from "./Occluder";
import { Occlusion } from "./Occlusion";
import { People } from "./People";
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
  private readonly ground = new Ground();
  private readonly background = new Background(this.feed);
  private readonly people = new People(this.feed);
  private readonly occluder = new Occluder(this.background, this.people);
  private readonly occlusion: Occlusion;
  private readonly bridge: Bridge;
  private readonly zedSettings: ZedSettings;
  private readonly depthView: DepthView;
  private readonly planeTool: PlaneTool;
  private readonly recordings: Recordings;

  // The order of the addControls() calls sets the order of the folders in the debug pane:
  // the occlusion pipeline's stages, in order (see the README).
  constructor(defaultPlanes: DefaultPlanes) {
    const canvas = this.renderer.domElement;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(canvas);

    this.occlusion = new Occlusion(this.occluder, this.ground, this.people);
    this.bridge = new Bridge(
      {
        onInfo: (info) => this.onInfo(info),
        onFrame: (frame) => this.feed.update(frame),
        onBackground: (frame) => this.background.set(frame, this.bridge.info!.background!),
      },
      this.status,
      this.debug,
    );
    this.depthView = new DepthView(this.occluder, this.background, this.people, this.camera, this.ground, this.debug);
    this.zedSettings = new ZedSettings(this.bridge, this.debug);
    this.background.addControls(this.debug, this.bridge);
    this.people.addControls(this.debug, this.bridge);
    this.occluder.addControls(this.debug);
    this.ground.addControls(this.debug);
    this.occlusion.addControls(this.debug);
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

  // On connect and after each scene switch, depth settings change or background capture:
  // the intrinsics or the depth size may have changed, so the camera re-aligns and the textures resize.
  private onInfo(info: StreamInfo) {
    this.camera.setIntrinsics(info);
    this.feed.setDepthSize(info.depthWidth, info.depthHeight);
    this.occluder.setSize(info.depthWidth, info.depthHeight);
    this.resize();
    this.zedSettings.sync(info.depth);
    this.background.sync(info.background);
    this.people.sync(info.matting);
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
    this.ground.update(this.recordings.active?.groundPlane);
    this.people.update();
    this.occluder.render(this.renderer);
    if (this.depthView.active) this.depthView.render(this.renderer);
    else this.renderer.render(this.recordings.scene, this.camera);
    this.debug.end();
  }
}
