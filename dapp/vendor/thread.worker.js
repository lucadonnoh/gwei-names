import {
  BarretenbergWasmBase,
  Ready,
  expose,
  killSelf,
  threadLogger
} from "./chunk-CMCK5M44.js";
import "./chunk-7DQDWJI5.js";

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_thread/index.js
var BarretenbergWasmThread = class extends BarretenbergWasmBase {
  /**
   * Init as worker thread.
   * @param useCustomLogger - If true, logs will be posted back to main thread for custom logger routing
   */
  async initThread(module, memory, useCustomLogger = false) {
    this.logger = threadLogger(useCustomLogger) || this.logger;
    this.memory = memory;
    this.instance = await WebAssembly.instantiate(module, this.getImportObj(this.memory));
  }
  destroy() {
    killSelf();
  }
  getImportObj(memory) {
    const baseImports = super.getImportObj(memory);
    return {
      ...baseImports,
      wasi: {
        "thread-spawn": () => {
          this.logger("PANIC: threads cannot spawn threads!");
          this.logger(new Error().stack);
          killSelf();
        }
      },
      // These are functions implementations for imports we've defined are needed.
      // The native C++ build defines these in a module called "env". We must implement TypeScript versions here.
      env: {
        ...baseImports.env,
        env_hardware_concurrency: () => {
          return 1;
        }
      }
    };
  }
};

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_thread/factory/browser/thread.worker.js
expose(new BarretenbergWasmThread());
postMessage(Ready);
