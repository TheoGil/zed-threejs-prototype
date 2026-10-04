import { App } from "./App";
import { loadDefaultPlanes } from "./Recordings";

new App(await loadDefaultPlanes());
