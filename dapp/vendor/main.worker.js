import {
  BarretenbergWasmMain
} from "./chunk-UUUCYCRK.js";
import {
  Ready,
  expose
} from "./chunk-CMCK5M44.js";
import "./chunk-7DQDWJI5.js";

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_main/factory/browser/main.worker.js
expose(new BarretenbergWasmMain());
postMessage(Ready);
