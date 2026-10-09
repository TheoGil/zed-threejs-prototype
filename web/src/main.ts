import { App } from "./App";
import { loadDefaultPlanes } from "./Recordings";
import { loadSensors } from "./Sensor";
import { loadTimestamps } from "./Timestamps";

const [planes, timestamps, sensors] = await Promise.all([loadDefaultPlanes(), loadTimestamps(), loadSensors()]);
new App(planes, timestamps, sensors);
