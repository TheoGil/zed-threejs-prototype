import type { BladeApi, FolderApi } from "tweakpane";
import type { Bridge } from "./Bridge";
import type { Debug } from "./Debug";

// Recording name (the .svo file name without extension) -> its timestamps, as SVO frame numbers.
export type DefaultTimestamps = Record<string, number[]>;

// The timestamps live in public/timestamps.json. Pausing logs the frame shown to the browser
// console: paste its number under its recording in that file to list it.
export async function loadTimestamps(): Promise<DefaultTimestamps> {
  try {
    const response = await fetch("timestamps.json");
    return await response.json();
  } catch (error) {
    console.warn("Could not load timestamps.json:", error);
    return {};
  }
}

// Moments of a recording to come back to: one button each, under Play in the Video folder,
// that pauses on that frame.
export class Timestamps {
  private readonly ui: FolderApi | null;
  private buttons: BladeApi[] = [];
  private scene: string | null = null;

  constructor(
    private readonly bridge: Bridge,
    debug: Debug,
    private readonly timestamps: DefaultTimestamps,
  ) {
    this.ui = debug.folder("Video");
  }

  // Call with each info from the bridge: the buttons follow the scene playing.
  sync(scene: string, fps: number | null) {
    if (scene === this.scene) return;
    this.scene = scene;
    this.buttons.forEach((button) => button.dispose());
    this.buttons = [];
    const ui = this.ui;
    const playButton = this.bridge.playButton;
    if (!ui || !playButton) return;
    const positions = [...(this.timestamps[scene] ?? [])].sort((a, b) => a - b);
    this.buttons = positions.map((position, i) =>
      ui
        .addButton({ title: formatPosition(position, fps), index: ui.children.indexOf(playButton) + 1 + i })
        .on("click", () => this.bridge.pause(position)),
    );
  }

  // Call when pausing, with the frame shown (null for a live camera).
  log(position: number | null) {
    const scene = this.scene ?? "";
    if (position === null) {
      console.log(`${scene}: a live camera has no timestamps.`);
      return;
    }
    console.log(
      `${scene} › paused at ${formatPosition(position, this.bridge.info?.fps ?? null)}. ` +
        `To list it under Play, add ${position} to "${scene}" in web/public/timestamps.json.`,
    );
  }
}

// "1:08.4 · frame 1026": the time from the recording's frame rate, and the exact frame.
function formatPosition(position: number, fps: number | null): string {
  if (!fps) return `frame ${position}`;
  const seconds = position / fps;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")} · frame ${position}`;
}
