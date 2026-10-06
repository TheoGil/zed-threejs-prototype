import Stats from "three/addons/libs/stats.module.js";
import { Pane, type FolderApi } from "tweakpane";

// Shows the Tweakpane controls and the Stats panel. Each module adds its own
// controls, only when this is true.
export const SHOW_DEBUG = true;

export class Debug {
  readonly pane = SHOW_DEBUG ? new Pane({ title: "Controls" }) : null;
  // Render-loop stats (top-left; click to cycle FPS / ms / memory). The status line
  // at the bottom-left counts video frames received, which is a different number.
  private readonly stats = SHOW_DEBUG ? new Stats() : null;
  private readonly folders = new Map<string, FolderApi>();

  constructor() {
    if (this.stats) document.body.appendChild(this.stats.dom);
  }

  // A top-level folder that several modules can add to, created on first use.
  // null when debug is off.
  folder(title: string): FolderApi | null {
    if (!this.pane) return null;
    let folder = this.folders.get(title);
    if (!folder) {
      folder = this.pane.addFolder({ title, expanded: false });
      this.folders.set(title, folder);
    }
    return folder;
  }

  begin() {
    this.stats?.begin();
  }

  end() {
    this.stats?.end();
  }
}
