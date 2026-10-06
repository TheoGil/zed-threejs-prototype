import { App } from "./App";
import { loadDefaultPlanes } from "./Recordings";
import { loadTimestamps } from "./Timestamps";

const [planes, timestamps] = await Promise.all([loadDefaultPlanes(), loadTimestamps()]);
new App(planes, timestamps);
