import {
  BarretenbergWasmBase,
  getNumCpu,
  getRemoteBarretenbergWasm,
  getSharedMemoryAvailable,
  readinessListener
} from "./chunk-CMCK5M44.js";

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_thread/factory/browser/index.js
async function createThreadWorker() {
  const worker = new Worker(new URL("./thread.worker.js", import.meta.url), { type: "module" });
  await new Promise((resolve) => readinessListener(worker, resolve));
  return worker;
}

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_main/heap_allocator.js
var HeapAllocator = class {
  wasm;
  allocs = [];
  inScratchPtr = 0;
  // Next input starts here, grows UP
  outScratchPtr = 1024;
  // Next output ends here, grows DOWN
  constructor(wasm) {
    this.wasm = wasm;
  }
  getInputs(buffers) {
    return buffers.map((bufOrNum) => {
      if (typeof bufOrNum === "object") {
        const size = bufOrNum.length;
        if (this.inScratchPtr + size <= this.outScratchPtr) {
          const ptr = this.inScratchPtr;
          this.inScratchPtr += size;
          this.wasm.writeMemory(ptr, bufOrNum);
          return ptr;
        } else {
          const ptr = this.wasm.call("bbmalloc", size);
          this.wasm.writeMemory(ptr, bufOrNum);
          this.allocs.push(ptr);
          return ptr;
        }
      } else {
        return bufOrNum;
      }
    });
  }
  getOutputPtrs(outLens) {
    return outLens.map((len) => {
      const size = len || 4;
      if (this.inScratchPtr + size <= this.outScratchPtr) {
        this.outScratchPtr -= size;
        return this.outScratchPtr;
      } else {
        const ptr = this.wasm.call("bbmalloc", size);
        this.allocs.push(ptr);
        return ptr;
      }
    });
  }
  addOutputPtr(ptr) {
    if (ptr >= 1024) {
      this.allocs.push(ptr);
    }
  }
  freeAll() {
    for (const ptr of this.allocs) {
      this.wasm.call("bbfree", ptr);
    }
  }
};

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_main/index.js
var BarretenbergWasmMain = class _BarretenbergWasmMain extends BarretenbergWasmBase {
  static MAX_THREADS = 32;
  workers = [];
  remoteWasms = [];
  nextWorker = 0;
  nextThreadId = 1;
  useCustomLogger = false;
  // Pre-allocated scratch buffers for msgpack I/O to avoid malloc/free overhead
  msgpackInputScratch = 0;
  // 8MB input buffer
  msgpackOutputScratch = 0;
  // 8MB output buffer
  MSGPACK_SCRATCH_SIZE = 1024 * 1024 * 8;
  // 8MB
  getNumThreads() {
    return this.workers.length + 1;
  }
  /**
   * Init as main thread. Spawn child threads.
   */
  async init(module, threads = Math.min(getNumCpu(), _BarretenbergWasmMain.MAX_THREADS), logger, initial = 35, maximum = this.getDefaultMaximumMemoryPages()) {
    this.useCustomLogger = logger !== void 0;
    this.logger = logger ?? (() => {
    });
    const initialMb = initial * 2 ** 16 / (1024 * 1024);
    const maxMb = maximum * 2 ** 16 / (1024 * 1024);
    const shared = getSharedMemoryAvailable();
    this.logger(`Initializing bb wasm: initial memory ${initial} pages ${initialMb}MiB; max memory: ${maximum} pages, ${maxMb}MiB; threads: ${threads}; shared memory: ${shared}`);
    this.memory = new WebAssembly.Memory({ initial, maximum, shared });
    const instance = await WebAssembly.instantiate(module, this.getImportObj(this.memory));
    this.instance = instance;
    this.call("_initialize");
    this.msgpackInputScratch = this.call("bbmalloc", this.MSGPACK_SCRATCH_SIZE);
    this.msgpackOutputScratch = this.call("bbmalloc", this.MSGPACK_SCRATCH_SIZE);
    this.logger(`Allocated msgpack scratch buffers: input @ ${this.msgpackInputScratch}, output @ ${this.msgpackOutputScratch} (${this.MSGPACK_SCRATCH_SIZE} bytes each)`);
    if (threads > 1) {
      this.logger(`Creating ${threads} worker threads`);
      this.workers = await Promise.all(Array.from({ length: threads - 1 }).map(createThreadWorker));
      if (this.useCustomLogger) {
        this.workers.forEach((worker) => this.setupWorkerLogForwarding(worker));
      }
      this.remoteWasms = await Promise.all(this.workers.map(getRemoteBarretenbergWasm));
      await Promise.all(this.remoteWasms.map((w) => w.initThread(module, this.memory, this.useCustomLogger)));
    }
  }
  getDefaultMaximumMemoryPages() {
    if (typeof self !== "undefined" && typeof self.navigator !== "undefined" && /iPad|iPhone/.test(self.navigator.userAgent)) {
      return 2 ** 14;
    }
    return 2 ** 16;
  }
  /**
   * Set up forwarding of log messages from worker threads to our logger.
   * Workers post messages with { type: 'log', msg: string } which we intercept here.
   */
  setupWorkerLogForwarding(worker) {
    const handler = (data) => {
      if (data && typeof data === "object" && "type" in data && data.type === "log" && "msg" in data) {
        this.logger(data.msg);
      }
    };
    if ("on" in worker && typeof worker.on === "function") {
      worker.on("message", handler);
    } else if ("addEventListener" in worker) {
      worker.addEventListener("message", (event) => {
        handler(event.data);
      });
    }
  }
  /**
   * Called on main thread. Signals child threads to gracefully exit.
   */
  async destroy() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
  getImportObj(memory) {
    const baseImports = super.getImportObj(memory);
    return {
      ...baseImports,
      wasi: {
        "thread-spawn": (arg) => {
          arg = arg >>> 0;
          const id = this.nextThreadId++;
          const worker = this.nextWorker++ % this.remoteWasms.length;
          this.remoteWasms[worker].call("wasi_thread_start", id, arg).catch(this.logger);
          return id;
        }
      },
      env: {
        ...baseImports.env,
        env_hardware_concurrency: () => {
          return this.remoteWasms.length + 1;
        }
      }
    };
  }
  callWasmExport(funcName, inArgs, outLens) {
    const alloc = new HeapAllocator(this);
    const inPtrs = alloc.getInputs(inArgs);
    const outPtrs = alloc.getOutputPtrs(outLens);
    this.call(funcName, ...inPtrs, ...outPtrs);
    const outArgs = this.getOutputArgs(outLens, outPtrs, alloc);
    alloc.freeAll();
    return outArgs;
  }
  getOutputArgs(outLens, outPtrs, alloc) {
    return outLens.map((len, i) => {
      if (len) {
        return this.getMemorySlice(outPtrs[i], outPtrs[i] + len);
      }
      const slice = this.getMemorySlice(outPtrs[i], outPtrs[i] + 4);
      const ptr = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getUint32(0, true);
      alloc.addOutputPtr(ptr);
      const lslice = this.getMemorySlice(ptr, ptr + 4);
      const length = new DataView(lslice.buffer, lslice.byteOffset, lslice.byteLength).getUint32(0, false);
      return this.getMemorySlice(ptr + 4, ptr + 4 + length);
    });
  }
  cbindCall(cbind, inputBuffer) {
    const needsCustomInputBuffer = inputBuffer.length > this.MSGPACK_SCRATCH_SIZE;
    let inputPtr;
    if (needsCustomInputBuffer) {
      inputPtr = this.call("bbmalloc", inputBuffer.length);
    } else {
      inputPtr = this.msgpackInputScratch;
    }
    this.writeMemory(inputPtr, inputBuffer);
    const METADATA_SIZE = 8;
    const outputPtrLocation = this.msgpackOutputScratch;
    const outputSizeLocation = this.msgpackOutputScratch + 4;
    const scratchDataPtr = this.msgpackOutputScratch + METADATA_SIZE;
    const scratchDataSize = this.MSGPACK_SCRATCH_SIZE - METADATA_SIZE;
    let mem = this.getMemory();
    let view = new DataView(mem.buffer);
    view.setUint32(outputPtrLocation, scratchDataPtr, true);
    view.setUint32(outputSizeLocation, scratchDataSize, true);
    this.call(cbind, inputPtr, inputBuffer.length, outputPtrLocation, outputSizeLocation);
    if (needsCustomInputBuffer) {
      this.call("bbfree", inputPtr);
    }
    mem = this.getMemory();
    view = new DataView(mem.buffer);
    const outputDataPtr = view.getUint32(outputPtrLocation, true);
    const outputSize = view.getUint32(outputSizeLocation, true);
    const usedScratch = outputDataPtr === scratchDataPtr;
    const encodedResult = this.getMemorySlice(outputDataPtr, outputDataPtr + outputSize);
    if (!usedScratch) {
      this.call("bbfree", outputDataPtr);
    }
    return encodedResult;
  }
};

export {
  BarretenbergWasmMain
};
