import {
  pako,
  ungzip_1
} from "./chunk-NM5D2K6H.js";
import {
  BarretenbergWasmMain
} from "./chunk-UUUCYCRK.js";
import {
  getAvailableThreads,
  getRemoteBarretenbergWasm,
  getSharedMemoryAvailable,
  proxy,
  randomBytes,
  readinessListener
} from "./chunk-CMCK5M44.js";
import "./chunk-7DQDWJI5.js";

// node_modules/@aztec/bb.js/dest/browser/retry/index.js
function* backoffGenerator() {
  const v = [1, 1, 1, 2, 4, 8, 16, 32, 64];
  let i = 0;
  while (true) {
    yield v[Math.min(i++, v.length - 1)];
  }
}
function* makeBackoff(retries) {
  for (const retry2 of retries) {
    yield retry2;
  }
}
async function retry(fn, backoff = backoffGenerator()) {
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const s = backoff.next().value;
      if (s === void 0) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, s * 1e3));
      continue;
    }
  }
}

// node_modules/@aztec/bb.js/dest/browser/crs/net_crs.js
var CRS_PRIMARY_HOST = "https://crs.aztec-cdn.foundation";
var CRS_FALLBACK_HOST = "https://crs.aztec-labs.com";
async function fetchWithFallback(primaryUrl, fallbackUrl, options) {
  try {
    const response = await fetch(primaryUrl, options);
    if (response.ok || response.status === 206) {
      return response;
    }
    throw new Error(`HTTP ${response.status}`);
  } catch {
    return await fetch(fallbackUrl, options);
  }
}
var NetCrs = class {
  numPoints;
  data;
  g2Data;
  constructor(numPoints) {
    this.numPoints = numPoints;
  }
  /**
   * Download the data.
   */
  async init() {
    await this.downloadG1Data();
    await this.downloadG2Data();
  }
  /**
   * Opens up a ReadableStream to the points data
   */
  async streamG1Data() {
    const response = await this.fetchG1Data();
    return response.body;
  }
  /**
   * Opens up a ReadableStream to the points data
   */
  async streamG2Data() {
    const response = await this.fetchG2Data();
    return response.body;
  }
  async downloadG1Data() {
    const response = await this.fetchG1Data();
    return this.data = new Uint8Array(await response.arrayBuffer());
  }
  /**
   * Download the G2 points data.
   */
  async downloadG2Data() {
    const response2 = await this.fetchG2Data();
    return this.g2Data = new Uint8Array(await response2.arrayBuffer());
  }
  /**
   * G1 points data for prover key.
   * @returns The points data.
   */
  getG1Data() {
    return this.data;
  }
  /**
   * G2 points data for verification key.
   * @returns The points data.
   */
  getG2Data() {
    return this.g2Data;
  }
  /**
   * Fetches the appropriate range of points from a remote source
   */
  async fetchG1Data() {
    if (this.numPoints === 0) {
      return new Response(new Uint8Array([]));
    }
    const g1End = this.numPoints * 64 - 1;
    const options = {
      headers: {
        Range: `bytes=0-${g1End}`
      },
      cache: "force-cache"
    };
    return await retry(() => fetchWithFallback(`${CRS_PRIMARY_HOST}/g1.dat`, `${CRS_FALLBACK_HOST}/g1.dat`, options), makeBackoff([5, 5, 5]));
  }
  /**
   * Fetches the appropriate range of points from a remote source
   */
  async fetchG2Data() {
    const options = {
      cache: "force-cache"
    };
    return await retry(() => fetchWithFallback(`${CRS_PRIMARY_HOST}/g2.dat`, `${CRS_FALLBACK_HOST}/g2.dat`, options), makeBackoff([5, 5, 5]));
  }
};
var NetGrumpkinCrs = class {
  numPoints;
  data;
  constructor(numPoints) {
    this.numPoints = numPoints;
  }
  /**
   * Download the data.
   */
  async init() {
    await this.downloadG1Data();
  }
  async downloadG1Data() {
    const response = await this.fetchG1Data();
    return this.data = new Uint8Array(await response.arrayBuffer());
  }
  /**
   * Opens up a ReadableStream to the points data
   */
  async streamG1Data() {
    const response = await this.fetchG1Data();
    return response.body;
  }
  /**
   * G1 points data for prover key.
   * @returns The points data.
   */
  getG1Data() {
    return this.data;
  }
  /**
   * Fetches the appropriate range of points from a remote source
   */
  async fetchG1Data() {
    if (this.numPoints === 0) {
      return new Response(new Uint8Array([]));
    }
    const g1End = this.numPoints * 64 - 1;
    const options = {
      headers: {
        Range: `bytes=0-${g1End}`
      },
      cache: "force-cache"
    };
    return await fetchWithFallback(`${CRS_PRIMARY_HOST}/grumpkin_g1.dat`, `${CRS_FALLBACK_HOST}/grumpkin_g1.dat`, options);
  }
};

// node_modules/idb-keyval/dist/index.js
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.oncomplete = request.onsuccess = () => resolve(request.result);
    request.onabort = request.onerror = () => reject(request.error);
  });
}
function createStore(dbName, storeName) {
  let dbp;
  const getDB = () => {
    if (dbp)
      return dbp;
    const request = indexedDB.open(dbName);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    dbp = promisifyRequest(request);
    dbp.then((db) => {
      db.onclose = () => dbp = void 0;
    }, () => {
    });
    return dbp;
  };
  return (txMode, callback) => getDB().then((db) => callback(db.transaction(storeName, txMode).objectStore(storeName)));
}
var defaultGetStoreFunc;
function defaultGetStore() {
  if (!defaultGetStoreFunc) {
    defaultGetStoreFunc = createStore("keyval-store", "keyval");
  }
  return defaultGetStoreFunc;
}
function get(key, customStore = defaultGetStore()) {
  return customStore("readonly", (store) => promisifyRequest(store.get(key)));
}
function set(key, value, customStore = defaultGetStore()) {
  return customStore("readwrite", (store) => {
    store.put(value, key);
    return promisifyRequest(store.transaction);
  });
}

// node_modules/@aztec/bb.js/dest/browser/crs/browser/cached_net_crs.js
var CachedNetCrs = class _CachedNetCrs {
  numPoints;
  g1Data;
  g2Data;
  constructor(numPoints) {
    this.numPoints = numPoints;
  }
  static async new(numPoints) {
    const crs = new _CachedNetCrs(numPoints);
    await crs.init();
    return crs;
  }
  /**
   * Download the data.
   */
  async init() {
    const g1Data = await get("g1Data");
    const g2Data = await get("g2Data");
    const netCrs = new NetCrs(this.numPoints);
    const g1DataLength = this.numPoints * 64;
    if (!g1Data || g1Data.length < g1DataLength) {
      this.g1Data = await netCrs.downloadG1Data();
      await set("g1Data", this.g1Data);
    } else {
      this.g1Data = g1Data;
    }
    if (!g2Data) {
      this.g2Data = await netCrs.downloadG2Data();
      await set("g2Data", this.g2Data);
    } else {
      this.g2Data = g2Data;
    }
  }
  /**
   * G1 points data for prover key.
   * @returns The points data.
   */
  getG1Data() {
    return this.g1Data;
  }
  /**
   * G2 points data for verification key.
   * @returns The points data.
   */
  getG2Data() {
    return this.g2Data;
  }
};
var CachedNetGrumpkinCrs = class _CachedNetGrumpkinCrs {
  numPoints;
  g1Data;
  constructor(numPoints) {
    this.numPoints = numPoints;
  }
  static async new(numPoints) {
    const crs = new _CachedNetGrumpkinCrs(numPoints);
    await crs.init();
    return crs;
  }
  /**
   * Download the data.
   */
  async init() {
    const g1Data = await get("grumpkinG1Data");
    const netGrumpkinCrs = new NetGrumpkinCrs(this.numPoints);
    const g1DataLength = this.numPoints * 64;
    if (!g1Data || g1Data.length < g1DataLength) {
      this.g1Data = await netGrumpkinCrs.downloadG1Data();
      await set("grumpkinG1Data", this.g1Data);
    } else {
      this.g1Data = g1Data;
    }
  }
  /**
   * G1 points data for prover key.
   * @returns The points data.
   */
  getG1Data() {
    return this.g1Data;
  }
};

// node_modules/msgpackr/unpack.js
var decoder;
try {
  decoder = new TextDecoder();
} catch (error) {
}
var src;
var srcEnd;
var position = 0;
var EMPTY_ARRAY = [];
var strings = EMPTY_ARRAY;
var stringPosition = 0;
var currentUnpackr = {};
var currentStructures;
var srcString;
var srcStringStart = 0;
var srcStringEnd = 0;
var bundledStrings;
var referenceMap;
var currentExtensions = [];
var dataView;
var defaultOptions = {
  useRecords: false,
  mapsAsObjects: true
};
var C1Type = class {
};
var C1 = new C1Type();
C1.name = "MessagePack 0xC1";
var sequentialMode = false;
var inlineObjectReadThreshold = 2;
var readStruct;
var onLoadedStructures;
var onSaveState;
var Unpackr = class _Unpackr {
  constructor(options) {
    if (options) {
      if (options.useRecords === false && options.mapsAsObjects === void 0)
        options.mapsAsObjects = true;
      if (options.sequential && options.trusted !== false) {
        options.trusted = true;
        if (!options.structures && options.useRecords != false) {
          options.structures = [];
          if (!options.maxSharedStructures)
            options.maxSharedStructures = 0;
        }
      }
      if (options.structures)
        options.structures.sharedLength = options.structures.length;
      else if (options.getStructures) {
        (options.structures = []).uninitialized = true;
        options.structures.sharedLength = 0;
      }
      if (options.int64AsNumber) {
        options.int64AsType = "number";
      }
    }
    Object.assign(this, options);
  }
  unpack(source, options) {
    if (src) {
      return saveState(() => {
        clearSource();
        return this ? this.unpack(source, options) : _Unpackr.prototype.unpack.call(defaultOptions, source, options);
      });
    }
    if (!source.buffer && source.constructor === ArrayBuffer)
      source = typeof Buffer !== "undefined" ? Buffer.from(source) : new Uint8Array(source);
    if (typeof options === "object") {
      srcEnd = options.end || source.length;
      position = options.start || 0;
    } else {
      position = 0;
      srcEnd = options > -1 ? options : source.length;
    }
    stringPosition = 0;
    srcStringEnd = 0;
    srcString = null;
    strings = EMPTY_ARRAY;
    bundledStrings = null;
    src = source;
    try {
      dataView = source.dataView || (source.dataView = new DataView(source.buffer, source.byteOffset, source.byteLength));
    } catch (error) {
      src = null;
      if (source instanceof Uint8Array)
        throw error;
      throw new Error("Source must be a Uint8Array or Buffer but was a " + (source && typeof source == "object" ? source.constructor.name : typeof source));
    }
    if (this instanceof _Unpackr) {
      currentUnpackr = this;
      if (this.structures) {
        currentStructures = this.structures;
        return checkedRead(options);
      } else if (!currentStructures || currentStructures.length > 0) {
        currentStructures = [];
      }
    } else {
      currentUnpackr = defaultOptions;
      if (!currentStructures || currentStructures.length > 0)
        currentStructures = [];
    }
    return checkedRead(options);
  }
  unpackMultiple(source, forEach) {
    let values, lastPosition = 0;
    try {
      sequentialMode = true;
      let size = source.length;
      let value = this ? this.unpack(source, size) : defaultUnpackr.unpack(source, size);
      if (forEach) {
        if (forEach(value, lastPosition, position) === false) return;
        while (position < size) {
          lastPosition = position;
          if (forEach(checkedRead(), lastPosition, position) === false) {
            return;
          }
        }
      } else {
        values = [value];
        while (position < size) {
          lastPosition = position;
          values.push(checkedRead());
        }
        return values;
      }
    } catch (error) {
      error.lastPosition = lastPosition;
      error.values = values;
      throw error;
    } finally {
      sequentialMode = false;
      clearSource();
    }
  }
  _mergeStructures(loadedStructures, existingStructures) {
    if (onLoadedStructures)
      loadedStructures = onLoadedStructures.call(this, loadedStructures);
    loadedStructures = loadedStructures || [];
    if (Object.isFrozen(loadedStructures))
      loadedStructures = loadedStructures.map((structure) => structure.slice(0));
    for (let i = 0, l = loadedStructures.length; i < l; i++) {
      let structure = loadedStructures[i];
      if (structure) {
        structure.isShared = true;
        if (i >= 32)
          structure.highByte = i - 32 >> 5;
      }
    }
    loadedStructures.sharedLength = loadedStructures.length;
    for (let id in existingStructures || []) {
      if (id >= 0) {
        let structure = loadedStructures[id];
        let existing = existingStructures[id];
        if (existing) {
          if (structure)
            (loadedStructures.restoreStructures || (loadedStructures.restoreStructures = []))[id] = structure;
          loadedStructures[id] = existing;
        }
      }
    }
    return this.structures = loadedStructures;
  }
  decode(source, options) {
    return this.unpack(source, options);
  }
};
function checkedRead(options) {
  try {
    if (!currentUnpackr.trusted && !sequentialMode) {
      let sharedLength = currentStructures.sharedLength || 0;
      if (sharedLength < currentStructures.length)
        currentStructures.length = sharedLength;
    }
    let result;
    if (currentUnpackr.randomAccessStructure && src[position] < 64 && src[position] >= 32 && readStruct) {
      result = readStruct(src, position, srcEnd, currentUnpackr);
      src = null;
      if (!(options && options.lazy) && result)
        result = result.toJSON();
      position = srcEnd;
    } else
      result = read();
    if (bundledStrings) {
      position = bundledStrings.postBundlePosition;
      bundledStrings = null;
    }
    if (sequentialMode)
      currentStructures.restoreStructures = null;
    if (position == srcEnd) {
      if (currentStructures && currentStructures.restoreStructures)
        restoreStructures();
      currentStructures = null;
      src = null;
      if (referenceMap)
        referenceMap = null;
    } else if (position > srcEnd) {
      throw new Error("Unexpected end of MessagePack data");
    } else if (!sequentialMode) {
      let jsonView;
      try {
        jsonView = JSON.stringify(result, (_, value) => typeof value === "bigint" ? `${value}n` : value).slice(0, 100);
      } catch (error) {
        jsonView = "(JSON view not available " + error + ")";
      }
      throw new Error("Data read, but end of buffer not reached " + jsonView);
    }
    return result;
  } catch (error) {
    if (currentStructures && currentStructures.restoreStructures)
      restoreStructures();
    clearSource();
    if (error instanceof RangeError || error.message.startsWith("Unexpected end of buffer") || position > srcEnd) {
      error.incomplete = true;
    }
    throw error;
  }
}
function restoreStructures() {
  for (let id in currentStructures.restoreStructures) {
    currentStructures[id] = currentStructures.restoreStructures[id];
  }
  currentStructures.restoreStructures = null;
}
function read() {
  let token = src[position++];
  if (token < 160) {
    if (token < 128) {
      if (token < 64)
        return token;
      else {
        let structure = currentStructures[token & 63] || currentUnpackr.getStructures && loadStructures()[token & 63];
        if (structure) {
          if (!structure.read) {
            structure.read = createStructureReader(structure, token & 63);
          }
          return structure.read();
        } else
          return token;
      }
    } else if (token < 144) {
      token -= 128;
      if (currentUnpackr.mapsAsObjects) {
        let object = {};
        for (let i = 0; i < token; i++) {
          let key = readKey();
          if (key === "__proto__")
            key = "__proto_";
          object[key] = read();
        }
        return object;
      } else {
        let map = /* @__PURE__ */ new Map();
        for (let i = 0; i < token; i++) {
          map.set(read(), read());
        }
        return map;
      }
    } else {
      token -= 144;
      let array = new Array(token);
      for (let i = 0; i < token; i++) {
        array[i] = read();
      }
      if (currentUnpackr.freezeData)
        return Object.freeze(array);
      return array;
    }
  } else if (token < 192) {
    let length = token - 160;
    if (srcStringEnd >= position) {
      return srcString.slice(position - srcStringStart, (position += length) - srcStringStart);
    }
    if (srcStringEnd == 0 && srcEnd < 140) {
      let string = length < 16 ? shortStringInJS(length) : longStringInJS(length);
      if (string != null)
        return string;
    }
    return readFixedString(length);
  } else {
    let value;
    switch (token) {
      case 192:
        return null;
      case 193:
        if (bundledStrings) {
          value = read();
          if (value > 0)
            return bundledStrings[1].slice(bundledStrings.position1, bundledStrings.position1 += value);
          else
            return bundledStrings[0].slice(bundledStrings.position0, bundledStrings.position0 -= value);
        }
        return C1;
      // "never-used", return special object to denote that
      case 194:
        return false;
      case 195:
        return true;
      case 196:
        value = src[position++];
        if (value === void 0)
          throw new Error("Unexpected end of buffer");
        return readBin(value);
      case 197:
        value = dataView.getUint16(position);
        position += 2;
        return readBin(value);
      case 198:
        value = dataView.getUint32(position);
        position += 4;
        return readBin(value);
      case 199:
        return readExt(src[position++]);
      case 200:
        value = dataView.getUint16(position);
        position += 2;
        return readExt(value);
      case 201:
        value = dataView.getUint32(position);
        position += 4;
        return readExt(value);
      case 202:
        value = dataView.getFloat32(position);
        if (currentUnpackr.useFloat32 > 2) {
          let multiplier = mult10[(src[position] & 127) << 1 | src[position + 1] >> 7];
          position += 4;
          return (multiplier * value + (value > 0 ? 0.5 : -0.5) >> 0) / multiplier;
        }
        position += 4;
        return value;
      case 203:
        value = dataView.getFloat64(position);
        position += 8;
        return value;
      // uint handlers
      case 204:
        return src[position++];
      case 205:
        value = dataView.getUint16(position);
        position += 2;
        return value;
      case 206:
        value = dataView.getUint32(position);
        position += 4;
        return value;
      case 207:
        if (currentUnpackr.int64AsType === "number") {
          value = dataView.getUint32(position) * 4294967296;
          value += dataView.getUint32(position + 4);
        } else if (currentUnpackr.int64AsType === "string") {
          value = dataView.getBigUint64(position).toString();
        } else if (currentUnpackr.int64AsType === "auto") {
          value = dataView.getBigUint64(position);
          if (value <= BigInt(2) << BigInt(52)) value = Number(value);
        } else
          value = dataView.getBigUint64(position);
        position += 8;
        return value;
      // int handlers
      case 208:
        return dataView.getInt8(position++);
      case 209:
        value = dataView.getInt16(position);
        position += 2;
        return value;
      case 210:
        value = dataView.getInt32(position);
        position += 4;
        return value;
      case 211:
        if (currentUnpackr.int64AsType === "number") {
          value = dataView.getInt32(position) * 4294967296;
          value += dataView.getUint32(position + 4);
        } else if (currentUnpackr.int64AsType === "string") {
          value = dataView.getBigInt64(position).toString();
        } else if (currentUnpackr.int64AsType === "auto") {
          value = dataView.getBigInt64(position);
          if (value >= BigInt(-2) << BigInt(52) && value <= BigInt(2) << BigInt(52)) value = Number(value);
        } else
          value = dataView.getBigInt64(position);
        position += 8;
        return value;
      case 212:
        value = src[position++];
        if (value == 114) {
          return recordDefinition(src[position++] & 63);
        } else {
          let extension = currentExtensions[value];
          if (extension) {
            if (extension.read) {
              position++;
              return extension.read(read());
            } else if (extension.noBuffer) {
              position++;
              return extension();
            } else
              return extension(src.subarray(position, ++position));
          } else
            throw new Error("Unknown extension " + value);
        }
      case 213:
        value = src[position];
        if (value == 114) {
          position++;
          return recordDefinition(src[position++] & 63, src[position++]);
        } else
          return readExt(2);
      case 214:
        return readExt(4);
      case 215:
        return readExt(8);
      case 216:
        return readExt(16);
      case 217:
        value = src[position++];
        if (srcStringEnd >= position) {
          return srcString.slice(position - srcStringStart, (position += value) - srcStringStart);
        }
        return readString8(value);
      case 218:
        value = dataView.getUint16(position);
        position += 2;
        if (srcStringEnd >= position) {
          return srcString.slice(position - srcStringStart, (position += value) - srcStringStart);
        }
        return readString16(value);
      case 219:
        value = dataView.getUint32(position);
        position += 4;
        if (srcStringEnd >= position) {
          return srcString.slice(position - srcStringStart, (position += value) - srcStringStart);
        }
        return readString32(value);
      case 220:
        value = dataView.getUint16(position);
        position += 2;
        return readArray(value);
      case 221:
        value = dataView.getUint32(position);
        position += 4;
        return readArray(value);
      case 222:
        value = dataView.getUint16(position);
        position += 2;
        return readMap(value);
      case 223:
        value = dataView.getUint32(position);
        position += 4;
        return readMap(value);
      default:
        if (token >= 224)
          return token - 256;
        if (token === void 0) {
          let error = new Error("Unexpected end of MessagePack data");
          error.incomplete = true;
          throw error;
        }
        throw new Error("Unknown MessagePack token " + token);
    }
  }
}
var validName = /^[a-zA-Z_$][a-zA-Z\d_$]*$/;
function createStructureReader(structure, firstId) {
  function readObject() {
    if (readObject.count++ > inlineObjectReadThreshold) {
      let optimizedReadObject;
      try {
        optimizedReadObject = structure.read = new Function("r", "return function(){return " + (currentUnpackr.freezeData ? "Object.freeze" : "") + "({" + structure.map((key) => key === "__proto__" ? "__proto_:r()" : validName.test(key) ? key + ":r()" : "[" + JSON.stringify(key) + "]:r()").join(",") + "})}")(read);
      } catch (error) {
        inlineObjectReadThreshold = Infinity;
        return readObject();
      }
      if (structure.highByte === 0)
        structure.read = createSecondByteReader(firstId, structure.read);
      return optimizedReadObject();
    }
    let object = {};
    for (let i = 0, l = structure.length; i < l; i++) {
      let key = structure[i];
      if (key === "__proto__")
        key = "__proto_";
      object[key] = read();
    }
    if (currentUnpackr.freezeData)
      return Object.freeze(object);
    return object;
  }
  readObject.count = 0;
  if (structure.highByte === 0) {
    return createSecondByteReader(firstId, readObject);
  }
  return readObject;
}
var createSecondByteReader = (firstId, read0) => {
  return function() {
    let highByte = src[position++];
    if (highByte === 0)
      return read0();
    let id = firstId < 32 ? -(firstId + (highByte << 5)) : firstId + (highByte << 5);
    let structure = currentStructures[id] || loadStructures()[id];
    if (!structure) {
      throw new Error("Record id is not defined for " + id);
    }
    if (!structure.read)
      structure.read = createStructureReader(structure, firstId);
    return structure.read();
  };
};
function loadStructures() {
  let loadedStructures = saveState(() => {
    src = null;
    return currentUnpackr.getStructures();
  });
  return currentStructures = currentUnpackr._mergeStructures(loadedStructures, currentStructures);
}
var readFixedString = readStringJS;
var readString8 = readStringJS;
var readString16 = readStringJS;
var readString32 = readStringJS;
function readStringJS(length) {
  let result;
  if (length < 16) {
    if (result = shortStringInJS(length))
      return result;
  }
  if (length > 64 && decoder)
    return decoder.decode(src.subarray(position, position += length));
  const end = position + length;
  const units = [];
  result = "";
  while (position < end) {
    const byte1 = src[position++];
    if ((byte1 & 128) === 0) {
      units.push(byte1);
    } else if ((byte1 & 224) === 192) {
      const byte2 = src[position++] & 63;
      const codePoint = (byte1 & 31) << 6 | byte2;
      if (codePoint < 128) {
        units.push(65533);
      } else {
        units.push(codePoint);
      }
    } else if ((byte1 & 240) === 224) {
      const byte2 = src[position++] & 63;
      const byte3 = src[position++] & 63;
      const codePoint = (byte1 & 31) << 12 | byte2 << 6 | byte3;
      if (codePoint < 2048 || codePoint >= 55296 && codePoint <= 57343) {
        units.push(65533);
      } else {
        units.push(codePoint);
      }
    } else if ((byte1 & 248) === 240) {
      const byte2 = src[position++] & 63;
      const byte3 = src[position++] & 63;
      const byte4 = src[position++] & 63;
      let unit = (byte1 & 7) << 18 | byte2 << 12 | byte3 << 6 | byte4;
      if (unit < 65536 || unit > 1114111) {
        units.push(65533);
      } else if (unit > 65535) {
        unit -= 65536;
        units.push(unit >>> 10 & 1023 | 55296);
        unit = 56320 | unit & 1023;
        units.push(unit);
      } else {
        units.push(unit);
      }
    } else {
      units.push(65533);
    }
    if (units.length >= 4096) {
      result += fromCharCode.apply(String, units);
      units.length = 0;
    }
  }
  if (units.length > 0) {
    result += fromCharCode.apply(String, units);
  }
  return result;
}
function readArray(length) {
  let array = new Array(length);
  for (let i = 0; i < length; i++) {
    array[i] = read();
  }
  if (currentUnpackr.freezeData)
    return Object.freeze(array);
  return array;
}
function readMap(length) {
  if (currentUnpackr.mapsAsObjects) {
    let object = {};
    for (let i = 0; i < length; i++) {
      let key = readKey();
      if (key === "__proto__")
        key = "__proto_";
      object[key] = read();
    }
    return object;
  } else {
    let map = /* @__PURE__ */ new Map();
    for (let i = 0; i < length; i++) {
      map.set(read(), read());
    }
    return map;
  }
}
var fromCharCode = String.fromCharCode;
function longStringInJS(length) {
  let start = position;
  let bytes = new Array(length);
  for (let i = 0; i < length; i++) {
    const byte = src[position++];
    if ((byte & 128) > 0) {
      position = start;
      return;
    }
    bytes[i] = byte;
  }
  return fromCharCode.apply(String, bytes);
}
function shortStringInJS(length) {
  if (length < 4) {
    if (length < 2) {
      if (length === 0)
        return "";
      else {
        let a = src[position++];
        if ((a & 128) > 1) {
          position -= 1;
          return;
        }
        return fromCharCode(a);
      }
    } else {
      let a = src[position++];
      let b = src[position++];
      if ((a & 128) > 0 || (b & 128) > 0) {
        position -= 2;
        return;
      }
      if (length < 3)
        return fromCharCode(a, b);
      let c = src[position++];
      if ((c & 128) > 0) {
        position -= 3;
        return;
      }
      return fromCharCode(a, b, c);
    }
  } else {
    let a = src[position++];
    let b = src[position++];
    let c = src[position++];
    let d = src[position++];
    if ((a & 128) > 0 || (b & 128) > 0 || (c & 128) > 0 || (d & 128) > 0) {
      position -= 4;
      return;
    }
    if (length < 6) {
      if (length === 4)
        return fromCharCode(a, b, c, d);
      else {
        let e = src[position++];
        if ((e & 128) > 0) {
          position -= 5;
          return;
        }
        return fromCharCode(a, b, c, d, e);
      }
    } else if (length < 8) {
      let e = src[position++];
      let f = src[position++];
      if ((e & 128) > 0 || (f & 128) > 0) {
        position -= 6;
        return;
      }
      if (length < 7)
        return fromCharCode(a, b, c, d, e, f);
      let g = src[position++];
      if ((g & 128) > 0) {
        position -= 7;
        return;
      }
      return fromCharCode(a, b, c, d, e, f, g);
    } else {
      let e = src[position++];
      let f = src[position++];
      let g = src[position++];
      let h = src[position++];
      if ((e & 128) > 0 || (f & 128) > 0 || (g & 128) > 0 || (h & 128) > 0) {
        position -= 8;
        return;
      }
      if (length < 10) {
        if (length === 8)
          return fromCharCode(a, b, c, d, e, f, g, h);
        else {
          let i = src[position++];
          if ((i & 128) > 0) {
            position -= 9;
            return;
          }
          return fromCharCode(a, b, c, d, e, f, g, h, i);
        }
      } else if (length < 12) {
        let i = src[position++];
        let j = src[position++];
        if ((i & 128) > 0 || (j & 128) > 0) {
          position -= 10;
          return;
        }
        if (length < 11)
          return fromCharCode(a, b, c, d, e, f, g, h, i, j);
        let k = src[position++];
        if ((k & 128) > 0) {
          position -= 11;
          return;
        }
        return fromCharCode(a, b, c, d, e, f, g, h, i, j, k);
      } else {
        let i = src[position++];
        let j = src[position++];
        let k = src[position++];
        let l = src[position++];
        if ((i & 128) > 0 || (j & 128) > 0 || (k & 128) > 0 || (l & 128) > 0) {
          position -= 12;
          return;
        }
        if (length < 14) {
          if (length === 12)
            return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l);
          else {
            let m = src[position++];
            if ((m & 128) > 0) {
              position -= 13;
              return;
            }
            return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l, m);
          }
        } else {
          let m = src[position++];
          let n = src[position++];
          if ((m & 128) > 0 || (n & 128) > 0) {
            position -= 14;
            return;
          }
          if (length < 15)
            return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l, m, n);
          let o = src[position++];
          if ((o & 128) > 0) {
            position -= 15;
            return;
          }
          return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l, m, n, o);
        }
      }
    }
  }
}
function readOnlyJSString() {
  let token = src[position++];
  let length;
  if (token < 192) {
    length = token - 160;
  } else {
    switch (token) {
      case 217:
        length = src[position++];
        break;
      case 218:
        length = dataView.getUint16(position);
        position += 2;
        break;
      case 219:
        length = dataView.getUint32(position);
        position += 4;
        break;
      default:
        throw new Error("Expected string");
    }
  }
  return readStringJS(length);
}
function readBin(length) {
  return currentUnpackr.copyBuffers ? (
    // specifically use the copying slice (not the node one)
    Uint8Array.prototype.slice.call(src, position, position += length)
  ) : src.subarray(position, position += length);
}
function readExt(length) {
  let type = src[position++];
  if (currentExtensions[type]) {
    let end;
    return currentExtensions[type](src.subarray(position, end = position += length), (readPosition) => {
      position = readPosition;
      try {
        return read();
      } finally {
        position = end;
      }
    });
  } else
    throw new Error("Unknown extension type " + type);
}
var keyCache = new Array(4096);
function readKey() {
  let length = src[position++];
  if (length >= 160 && length < 192) {
    length = length - 160;
    if (srcStringEnd >= position)
      return srcString.slice(position - srcStringStart, (position += length) - srcStringStart);
    else if (!(srcStringEnd == 0 && srcEnd < 180))
      return readFixedString(length);
  } else {
    position--;
    return asSafeString(read());
  }
  let key = (length << 5 ^ (length > 1 ? dataView.getUint16(position) : length > 0 ? src[position] : 0)) & 4095;
  let entry = keyCache[key];
  let checkPosition = position;
  let end = position + length - 3;
  let chunk;
  let i = 0;
  if (entry && entry.bytes == length) {
    while (checkPosition < end) {
      chunk = dataView.getUint32(checkPosition);
      if (chunk != entry[i++]) {
        checkPosition = 1879048192;
        break;
      }
      checkPosition += 4;
    }
    end += 3;
    while (checkPosition < end) {
      chunk = src[checkPosition++];
      if (chunk != entry[i++]) {
        checkPosition = 1879048192;
        break;
      }
    }
    if (checkPosition === end) {
      position = checkPosition;
      return entry.string;
    }
    end -= 3;
    checkPosition = position;
  }
  entry = [];
  keyCache[key] = entry;
  entry.bytes = length;
  while (checkPosition < end) {
    chunk = dataView.getUint32(checkPosition);
    entry.push(chunk);
    checkPosition += 4;
  }
  end += 3;
  while (checkPosition < end) {
    chunk = src[checkPosition++];
    entry.push(chunk);
  }
  let string = length < 16 ? shortStringInJS(length) : longStringInJS(length);
  if (string != null)
    return entry.string = string;
  return entry.string = readFixedString(length);
}
function asSafeString(property) {
  if (typeof property === "string") return property;
  if (typeof property === "number" || typeof property === "boolean" || typeof property === "bigint") return property.toString();
  if (property == null) return property + "";
  if (currentUnpackr.allowArraysInMapKeys && Array.isArray(property) && property.flat().every((item) => ["string", "number", "boolean", "bigint"].includes(typeof item))) {
    return property.flat().toString();
  }
  throw new Error(`Invalid property type for record: ${typeof property}`);
}
var recordDefinition = (id, highByte) => {
  let structure = read().map(asSafeString);
  let firstByte = id;
  if (highByte !== void 0) {
    id = id < 32 ? -((highByte << 5) + id) : (highByte << 5) + id;
    structure.highByte = highByte;
  }
  let existingStructure = currentStructures[id];
  if (existingStructure && (existingStructure.isShared || sequentialMode)) {
    (currentStructures.restoreStructures || (currentStructures.restoreStructures = []))[id] = existingStructure;
  }
  currentStructures[id] = structure;
  structure.read = createStructureReader(structure, firstByte);
  return structure.read();
};
currentExtensions[0] = () => {
};
currentExtensions[0].noBuffer = true;
currentExtensions[66] = (data) => {
  let headLength = data.byteLength % 8 || 8;
  let head = BigInt(data[0] & 128 ? data[0] - 256 : data[0]);
  for (let i = 1; i < headLength; i++) {
    head <<= BigInt(8);
    head += BigInt(data[i]);
  }
  if (data.byteLength !== headLength) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let decode2 = (start, end) => {
      let length = end - start;
      if (length <= 40) {
        let out = view.getBigUint64(start);
        for (let i = start + 8; i < end; i += 8) {
          out <<= BigInt(64);
          out |= view.getBigUint64(i);
        }
        return out;
      }
      let middle = start + (length >> 4 << 3);
      let left = decode2(start, middle);
      let right = decode2(middle, end);
      return left << BigInt((end - middle) * 8) | right;
    };
    head = head << BigInt((view.byteLength - headLength) * 8) | decode2(headLength, view.byteLength);
  }
  return head;
};
var errors = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
  AggregateError: typeof AggregateError === "function" ? AggregateError : null
};
currentExtensions[101] = () => {
  let data = read();
  if (!errors[data[0]]) {
    let error = Error(data[1], { cause: data[2] });
    error.name = data[0];
    return error;
  }
  return errors[data[0]](data[1], { cause: data[2] });
};
currentExtensions[105] = (data) => {
  if (currentUnpackr.structuredClone === false) throw new Error("Structured clone extension is disabled");
  let id = dataView.getUint32(position - 4);
  if (!referenceMap)
    referenceMap = /* @__PURE__ */ new Map();
  let token = src[position];
  let target2;
  if (token >= 144 && token < 160 || token == 220 || token == 221)
    target2 = [];
  else if (token >= 128 && token < 144 || token == 222 || token == 223)
    target2 = /* @__PURE__ */ new Map();
  else if ((token >= 199 && token <= 201 || token >= 212 && token <= 216) && src[position + 1] === 115)
    target2 = /* @__PURE__ */ new Set();
  else
    target2 = {};
  let refEntry = { target: target2 };
  referenceMap.set(id, refEntry);
  let targetProperties = read();
  if (!refEntry.used) {
    return refEntry.target = targetProperties;
  } else {
    Object.assign(target2, targetProperties);
  }
  if (target2 instanceof Map)
    for (let [k, v] of targetProperties.entries()) target2.set(k, v);
  if (target2 instanceof Set)
    for (let i of Array.from(targetProperties)) target2.add(i);
  return target2;
};
currentExtensions[112] = (data) => {
  if (currentUnpackr.structuredClone === false) throw new Error("Structured clone extension is disabled");
  let id = dataView.getUint32(position - 4);
  let refEntry = referenceMap.get(id);
  refEntry.used = true;
  return refEntry.target;
};
currentExtensions[115] = () => new Set(read());
var typedArrays = ["Int8", "Uint8", "Uint8Clamped", "Int16", "Uint16", "Int32", "Uint32", "Float32", "Float64", "BigInt64", "BigUint64"].map((type) => type + "Array");
var glbl = typeof globalThis === "object" ? globalThis : window;
currentExtensions[116] = (data) => {
  let typeCode = data[0];
  let buffer = Uint8Array.prototype.slice.call(data, 1).buffer;
  let typedArrayName = typedArrays[typeCode];
  if (!typedArrayName) {
    if (typeCode === 16) return buffer;
    if (typeCode === 17) return new DataView(buffer);
    throw new Error("Could not find typed array for code " + typeCode);
  }
  return new glbl[typedArrayName](buffer);
};
currentExtensions[120] = () => {
  let data = read();
  return new RegExp(data[0], data[1]);
};
var TEMP_BUNDLE = [];
currentExtensions[98] = (data) => {
  let dataSize = (data[0] << 24) + (data[1] << 16) + (data[2] << 8) + data[3];
  let dataPosition = position;
  position += dataSize - data.length;
  bundledStrings = TEMP_BUNDLE;
  bundledStrings = [readOnlyJSString(), readOnlyJSString()];
  bundledStrings.position0 = 0;
  bundledStrings.position1 = 0;
  bundledStrings.postBundlePosition = position;
  position = dataPosition;
  return read();
};
currentExtensions[255] = (data) => {
  if (data.length == 4)
    return new Date((data[0] * 16777216 + (data[1] << 16) + (data[2] << 8) + data[3]) * 1e3);
  else if (data.length == 8)
    return new Date(
      ((data[0] << 22) + (data[1] << 14) + (data[2] << 6) + (data[3] >> 2)) / 1e6 + ((data[3] & 3) * 4294967296 + data[4] * 16777216 + (data[5] << 16) + (data[6] << 8) + data[7]) * 1e3
    );
  else if (data.length == 12)
    return new Date(
      ((data[0] << 24) + (data[1] << 16) + (data[2] << 8) + data[3]) / 1e6 + ((data[4] & 128 ? -281474976710656 : 0) + data[6] * 1099511627776 + data[7] * 4294967296 + data[8] * 16777216 + (data[9] << 16) + (data[10] << 8) + data[11]) * 1e3
    );
  else
    return /* @__PURE__ */ new Date("invalid");
};
function saveState(callback) {
  if (onSaveState)
    onSaveState();
  let savedSrcEnd = srcEnd;
  let savedPosition = position;
  let savedStringPosition = stringPosition;
  let savedSrcStringStart = srcStringStart;
  let savedSrcStringEnd = srcStringEnd;
  let savedSrcString = srcString;
  let savedStrings = strings;
  let savedReferenceMap = referenceMap;
  let savedBundledStrings = bundledStrings;
  let savedSrc = new Uint8Array(src.slice(0, srcEnd));
  let savedStructures = currentStructures;
  let savedStructuresContents = currentStructures.slice(0, currentStructures.length);
  let savedPackr = currentUnpackr;
  let savedSequentialMode = sequentialMode;
  let value = callback();
  srcEnd = savedSrcEnd;
  position = savedPosition;
  stringPosition = savedStringPosition;
  srcStringStart = savedSrcStringStart;
  srcStringEnd = savedSrcStringEnd;
  srcString = savedSrcString;
  strings = savedStrings;
  referenceMap = savedReferenceMap;
  bundledStrings = savedBundledStrings;
  src = savedSrc;
  sequentialMode = savedSequentialMode;
  currentStructures = savedStructures;
  currentStructures.splice(0, currentStructures.length, ...savedStructuresContents);
  currentUnpackr = savedPackr;
  dataView = new DataView(src.buffer, src.byteOffset, src.byteLength);
  return value;
}
function clearSource() {
  src = null;
  referenceMap = null;
  currentStructures = null;
}
var mult10 = new Array(147);
for (let i = 0; i < 256; i++) {
  mult10[i] = +("1e" + Math.floor(45.15 - i * 0.30103));
}
var Decoder = Unpackr;
var defaultUnpackr = new Unpackr({ useRecords: false });
var unpack = defaultUnpackr.unpack;
var unpackMultiple = defaultUnpackr.unpackMultiple;
var decode = defaultUnpackr.unpack;
var FLOAT32_OPTIONS = {
  NEVER: 0,
  ALWAYS: 1,
  DECIMAL_ROUND: 3,
  DECIMAL_FIT: 4
};
var f32Array = new Float32Array(1);
var u8Array = new Uint8Array(f32Array.buffer, 0, 4);

// node_modules/msgpackr/pack.js
var textEncoder;
try {
  textEncoder = new TextEncoder();
} catch (error) {
}
var extensions;
var extensionClasses;
var hasNodeBuffer = typeof Buffer !== "undefined";
var ByteArrayAllocate = hasNodeBuffer ? function(length) {
  return Buffer.allocUnsafeSlow(length);
} : Uint8Array;
var ByteArray = hasNodeBuffer ? Buffer : Uint8Array;
var MAX_BUFFER_SIZE = hasNodeBuffer ? 4294967296 : 2144337920;
var target;
var keysTarget;
var targetView;
var position2 = 0;
var safeEnd;
var bundledStrings2 = null;
var writeStructSlots;
var MAX_BUNDLE_SIZE = 21760;
var hasNonLatin = /[\u0080-\uFFFF]/;
var RECORD_SYMBOL = /* @__PURE__ */ Symbol("record-id");
var Packr = class extends Unpackr {
  constructor(options) {
    super(options);
    this.offset = 0;
    let typeBuffer;
    let start;
    let hasSharedUpdate;
    let structures;
    let referenceMap2;
    let encodeUtf8 = ByteArray.prototype.utf8Write ? function(string, position3) {
      return target.utf8Write(string, position3, target.byteLength - position3);
    } : textEncoder && textEncoder.encodeInto ? function(string, position3) {
      return textEncoder.encodeInto(string, target.subarray(position3)).written;
    } : false;
    let packr = this;
    if (!options)
      options = {};
    let isSequential = options && options.sequential;
    let hasSharedStructures = options.structures || options.saveStructures;
    let maxSharedStructures = options.maxSharedStructures;
    if (maxSharedStructures == null)
      maxSharedStructures = hasSharedStructures ? 32 : 0;
    if (maxSharedStructures > 8160)
      throw new Error("Maximum maxSharedStructure is 8160");
    if (options.structuredClone && options.moreTypes == void 0) {
      this.moreTypes = true;
    }
    let maxOwnStructures = options.maxOwnStructures;
    if (maxOwnStructures == null)
      maxOwnStructures = hasSharedStructures ? 32 : 64;
    if (!this.structures && options.useRecords != false)
      this.structures = [];
    let useTwoByteRecords = maxSharedStructures > 32 || maxOwnStructures + maxSharedStructures > 64;
    let sharedLimitId = maxSharedStructures + 64;
    let maxStructureId = maxSharedStructures + maxOwnStructures + 64;
    if (maxStructureId > 8256) {
      throw new Error("Maximum maxSharedStructure + maxOwnStructure is 8192");
    }
    let recordIdsToRemove = [];
    let transitionsCount = 0;
    let serializationsSinceTransitionRebuild = 0;
    this.pack = this.encode = function(value, encodeOptions) {
      if (!target) {
        target = new ByteArrayAllocate(8192);
        targetView = target.dataView || (target.dataView = new DataView(target.buffer, 0, 8192));
        position2 = 0;
      }
      safeEnd = target.length - 10;
      if (safeEnd - position2 < 2048) {
        target = new ByteArrayAllocate(target.length);
        targetView = target.dataView || (target.dataView = new DataView(target.buffer, 0, target.length));
        safeEnd = target.length - 10;
        position2 = 0;
      } else
        position2 = position2 + 7 & 2147483640;
      start = position2;
      if (encodeOptions & RESERVE_START_SPACE) position2 += encodeOptions & 255;
      referenceMap2 = packr.structuredClone ? /* @__PURE__ */ new Map() : null;
      if (packr.bundleStrings && typeof value !== "string") {
        bundledStrings2 = [];
        bundledStrings2.size = Infinity;
      } else
        bundledStrings2 = null;
      structures = packr.structures;
      if (structures) {
        if (structures.uninitialized)
          structures = packr._mergeStructures(packr.getStructures());
        let sharedLength = structures.sharedLength || 0;
        if (sharedLength > maxSharedStructures) {
          throw new Error("Shared structures is larger than maximum shared structures, try increasing maxSharedStructures to " + structures.sharedLength);
        }
        if (!structures.transitions) {
          structures.transitions = /* @__PURE__ */ Object.create(null);
          for (let i = 0; i < sharedLength; i++) {
            let keys = structures[i];
            if (!keys)
              continue;
            let nextTransition, transition = structures.transitions;
            for (let j = 0, l = keys.length; j < l; j++) {
              let key = keys[j];
              nextTransition = transition[key];
              if (!nextTransition) {
                nextTransition = transition[key] = /* @__PURE__ */ Object.create(null);
              }
              transition = nextTransition;
            }
            transition[RECORD_SYMBOL] = i + 64;
          }
          this.lastNamedStructuresLength = sharedLength;
        }
        if (!isSequential) {
          structures.nextId = sharedLength + 64;
        }
      }
      if (hasSharedUpdate)
        hasSharedUpdate = false;
      let encodingError;
      try {
        if (packr.randomAccessStructure && value && typeof value === "object") {
          if (value.constructor === Object) writeStruct(value);
          else if (value.constructor !== Map && !Array.isArray(value) && !extensionClasses.some((extClass) => value instanceof extClass)) {
            writeStruct(value.toJSON ? value.toJSON() : value);
          } else pack2(value);
        } else
          pack2(value);
        let lastBundle = bundledStrings2;
        if (bundledStrings2)
          writeBundles(start, pack2, 0);
        if (referenceMap2 && referenceMap2.idsToInsert) {
          let idsToInsert = referenceMap2.idsToInsert.sort((a, b) => a.offset > b.offset ? 1 : -1);
          let i = idsToInsert.length;
          let incrementPosition = -1;
          while (lastBundle && i > 0) {
            let insertionPoint = idsToInsert[--i].offset + start;
            if (insertionPoint < lastBundle.stringsPosition + start && incrementPosition === -1)
              incrementPosition = 0;
            if (insertionPoint > lastBundle.position + start) {
              if (incrementPosition >= 0)
                incrementPosition += 6;
            } else {
              if (incrementPosition >= 0) {
                targetView.setUint32(
                  lastBundle.position + start,
                  targetView.getUint32(lastBundle.position + start) + incrementPosition
                );
                incrementPosition = -1;
              }
              lastBundle = lastBundle.previous;
              i++;
            }
          }
          if (incrementPosition >= 0 && lastBundle) {
            targetView.setUint32(
              lastBundle.position + start,
              targetView.getUint32(lastBundle.position + start) + incrementPosition
            );
          }
          position2 += idsToInsert.length * 6;
          if (position2 > safeEnd)
            makeRoom(position2);
          packr.offset = position2;
          let serialized = insertIds(target.subarray(start, position2), idsToInsert);
          referenceMap2 = null;
          return serialized;
        }
        packr.offset = position2;
        if (encodeOptions & REUSE_BUFFER_MODE) {
          target.start = start;
          target.end = position2;
          return target;
        }
        return target.subarray(start, position2);
      } catch (error) {
        encodingError = error;
        throw error;
      } finally {
        if (structures) {
          resetStructures();
          if (hasSharedUpdate && packr.saveStructures) {
            let sharedLength = structures.sharedLength || 0;
            let returnBuffer = target.subarray(start, position2);
            let newSharedData = prepareStructures(structures, packr);
            if (!encodingError) {
              if (packr.saveStructures(newSharedData, newSharedData.isCompatible) === false) {
                return packr.pack(value, encodeOptions);
              }
              packr.lastNamedStructuresLength = sharedLength;
              if (target.length > 1073741824) target = null;
              return returnBuffer;
            }
          }
        }
        if (target.length > 1073741824) target = null;
        if (encodeOptions & RESET_BUFFER_MODE)
          position2 = start;
      }
    };
    const resetStructures = () => {
      if (serializationsSinceTransitionRebuild < 10)
        serializationsSinceTransitionRebuild++;
      let sharedLength = structures.sharedLength || 0;
      if (structures.length > sharedLength && !isSequential)
        structures.length = sharedLength;
      if (transitionsCount > 1e4) {
        structures.transitions = null;
        serializationsSinceTransitionRebuild = 0;
        transitionsCount = 0;
        if (recordIdsToRemove.length > 0)
          recordIdsToRemove = [];
      } else if (recordIdsToRemove.length > 0 && !isSequential) {
        for (let i = 0, l = recordIdsToRemove.length; i < l; i++) {
          recordIdsToRemove[i][RECORD_SYMBOL] = 0;
        }
        recordIdsToRemove = [];
      }
    };
    const packArray = (value) => {
      var length = value.length;
      if (length < 16) {
        target[position2++] = 144 | length;
      } else if (length < 65536) {
        target[position2++] = 220;
        target[position2++] = length >> 8;
        target[position2++] = length & 255;
      } else {
        target[position2++] = 221;
        targetView.setUint32(position2, length);
        position2 += 4;
      }
      for (let i = 0; i < length; i++) {
        pack2(value[i]);
      }
    };
    const pack2 = (value) => {
      if (position2 > safeEnd)
        target = makeRoom(position2);
      var type = typeof value;
      var length;
      if (type === "string") {
        let strLength = value.length;
        if (bundledStrings2 && strLength >= 4 && strLength < 4096) {
          if ((bundledStrings2.size += strLength) > MAX_BUNDLE_SIZE) {
            let extStart;
            let maxBytes2 = (bundledStrings2[0] ? bundledStrings2[0].length * 3 + bundledStrings2[1].length : 0) + 10;
            if (position2 + maxBytes2 > safeEnd)
              target = makeRoom(position2 + maxBytes2);
            let lastBundle;
            if (bundledStrings2.position) {
              lastBundle = bundledStrings2;
              target[position2] = 200;
              position2 += 3;
              target[position2++] = 98;
              extStart = position2 - start;
              position2 += 4;
              writeBundles(start, pack2, 0);
              targetView.setUint16(extStart + start - 3, position2 - start - extStart);
            } else {
              target[position2++] = 214;
              target[position2++] = 98;
              extStart = position2 - start;
              position2 += 4;
            }
            bundledStrings2 = ["", ""];
            bundledStrings2.previous = lastBundle;
            bundledStrings2.size = 0;
            bundledStrings2.position = extStart;
          }
          let twoByte = hasNonLatin.test(value);
          bundledStrings2[twoByte ? 0 : 1] += value;
          target[position2++] = 193;
          pack2(twoByte ? -strLength : strLength);
          return;
        }
        let headerSize;
        if (strLength < 32) {
          headerSize = 1;
        } else if (strLength < 256) {
          headerSize = 2;
        } else if (strLength < 65536) {
          headerSize = 3;
        } else {
          headerSize = 5;
        }
        let maxBytes = strLength * 3;
        if (position2 + maxBytes > safeEnd)
          target = makeRoom(position2 + maxBytes);
        if (strLength < 64 || !encodeUtf8) {
          let i, c1, c2, strPosition = position2 + headerSize;
          for (i = 0; i < strLength; i++) {
            c1 = value.charCodeAt(i);
            if (c1 < 128) {
              target[strPosition++] = c1;
            } else if (c1 < 2048) {
              target[strPosition++] = c1 >> 6 | 192;
              target[strPosition++] = c1 & 63 | 128;
            } else if ((c1 & 64512) === 55296 && ((c2 = value.charCodeAt(i + 1)) & 64512) === 56320) {
              c1 = 65536 + ((c1 & 1023) << 10) + (c2 & 1023);
              i++;
              target[strPosition++] = c1 >> 18 | 240;
              target[strPosition++] = c1 >> 12 & 63 | 128;
              target[strPosition++] = c1 >> 6 & 63 | 128;
              target[strPosition++] = c1 & 63 | 128;
            } else {
              target[strPosition++] = c1 >> 12 | 224;
              target[strPosition++] = c1 >> 6 & 63 | 128;
              target[strPosition++] = c1 & 63 | 128;
            }
          }
          length = strPosition - position2 - headerSize;
        } else {
          length = encodeUtf8(value, position2 + headerSize);
        }
        if (length < 32) {
          target[position2++] = 160 | length;
        } else if (length < 256) {
          if (headerSize < 2) {
            target.copyWithin(position2 + 2, position2 + 1, position2 + 1 + length);
          }
          target[position2++] = 217;
          target[position2++] = length;
        } else if (length < 65536) {
          if (headerSize < 3) {
            target.copyWithin(position2 + 3, position2 + 2, position2 + 2 + length);
          }
          target[position2++] = 218;
          target[position2++] = length >> 8;
          target[position2++] = length & 255;
        } else {
          if (headerSize < 5) {
            target.copyWithin(position2 + 5, position2 + 3, position2 + 3 + length);
          }
          target[position2++] = 219;
          targetView.setUint32(position2, length);
          position2 += 4;
        }
        position2 += length;
      } else if (type === "number") {
        if (value >>> 0 === value) {
          if (value < 32 || value < 128 && this.useRecords === false || value < 64 && !this.randomAccessStructure) {
            target[position2++] = value;
          } else if (value < 256) {
            target[position2++] = 204;
            target[position2++] = value;
          } else if (value < 65536) {
            target[position2++] = 205;
            target[position2++] = value >> 8;
            target[position2++] = value & 255;
          } else {
            target[position2++] = 206;
            targetView.setUint32(position2, value);
            position2 += 4;
          }
        } else if (value >> 0 === value) {
          if (value >= -32) {
            target[position2++] = 256 + value;
          } else if (value >= -128) {
            target[position2++] = 208;
            target[position2++] = value + 256;
          } else if (value >= -32768) {
            target[position2++] = 209;
            targetView.setInt16(position2, value);
            position2 += 2;
          } else {
            target[position2++] = 210;
            targetView.setInt32(position2, value);
            position2 += 4;
          }
        } else {
          let useFloat32;
          if ((useFloat32 = this.useFloat32) > 0 && value < 4294967296 && value >= -2147483648) {
            target[position2++] = 202;
            targetView.setFloat32(position2, value);
            let xShifted;
            if (useFloat32 < 4 || // this checks for rounding of numbers that were encoded in 32-bit float to nearest significant decimal digit that could be preserved
            (xShifted = value * mult10[(target[position2] & 127) << 1 | target[position2 + 1] >> 7]) >> 0 === xShifted) {
              position2 += 4;
              return;
            } else
              position2--;
          }
          target[position2++] = 203;
          targetView.setFloat64(position2, value);
          position2 += 8;
        }
      } else if (type === "object" || type === "function") {
        if (!value)
          target[position2++] = 192;
        else {
          if (referenceMap2) {
            let referee = referenceMap2.get(value);
            if (referee) {
              if (!referee.id) {
                let idsToInsert = referenceMap2.idsToInsert || (referenceMap2.idsToInsert = []);
                referee.id = idsToInsert.push(referee);
              }
              target[position2++] = 214;
              target[position2++] = 112;
              targetView.setUint32(position2, referee.id);
              position2 += 4;
              return;
            } else
              referenceMap2.set(value, { offset: position2 - start });
          }
          let constructor = value.constructor;
          if (constructor === Object) {
            writeObject(value);
          } else if (constructor === Array) {
            packArray(value);
          } else if (constructor === Map) {
            if (this.mapAsEmptyObject) target[position2++] = 128;
            else {
              length = value.size;
              if (length < 16) {
                target[position2++] = 128 | length;
              } else if (length < 65536) {
                target[position2++] = 222;
                target[position2++] = length >> 8;
                target[position2++] = length & 255;
              } else {
                target[position2++] = 223;
                targetView.setUint32(position2, length);
                position2 += 4;
              }
              for (let [key, entryValue] of value) {
                pack2(key);
                pack2(entryValue);
              }
            }
          } else {
            for (let i = 0, l = extensions.length; i < l; i++) {
              let extensionClass = extensionClasses[i];
              if (value instanceof extensionClass) {
                let extension = extensions[i];
                if (extension.write) {
                  if (extension.type) {
                    target[position2++] = 212;
                    target[position2++] = extension.type;
                    target[position2++] = 0;
                  }
                  let writeResult = extension.write.call(this, value);
                  if (writeResult === value) {
                    if (Array.isArray(value)) {
                      packArray(value);
                    } else {
                      writeObject(value);
                    }
                  } else {
                    pack2(writeResult);
                  }
                  return;
                }
                let currentTarget = target;
                let currentTargetView = targetView;
                let currentPosition = position2;
                target = null;
                let result;
                try {
                  result = extension.pack.call(this, value, (size) => {
                    target = currentTarget;
                    currentTarget = null;
                    position2 += size;
                    if (position2 > safeEnd)
                      makeRoom(position2);
                    return {
                      target,
                      targetView,
                      position: position2 - size
                    };
                  }, pack2);
                } finally {
                  if (currentTarget) {
                    target = currentTarget;
                    targetView = currentTargetView;
                    position2 = currentPosition;
                    safeEnd = target.length - 10;
                  }
                }
                if (result) {
                  if (result.length + position2 > safeEnd)
                    makeRoom(result.length + position2);
                  position2 = writeExtensionData(result, target, position2, extension.type);
                }
                return;
              }
            }
            if (Array.isArray(value)) {
              packArray(value);
            } else {
              if (value.toJSON) {
                const json = value.toJSON();
                if (json !== value)
                  return pack2(json);
              }
              if (type === "function")
                return pack2(this.writeFunction && this.writeFunction(value));
              writeObject(value);
            }
          }
        }
      } else if (type === "boolean") {
        target[position2++] = value ? 195 : 194;
      } else if (type === "bigint") {
        if (value < 9223372036854776e3 && value >= -9223372036854776e3) {
          target[position2++] = 211;
          targetView.setBigInt64(position2, value);
        } else if (value < 18446744073709552e3 && value > 0) {
          target[position2++] = 207;
          targetView.setBigUint64(position2, value);
        } else {
          if (this.largeBigIntToFloat) {
            target[position2++] = 203;
            targetView.setFloat64(position2, Number(value));
          } else if (this.largeBigIntToString) {
            return pack2(value.toString());
          } else if (this.useBigIntExtension || this.moreTypes) {
            let empty = value < 0 ? BigInt(-1) : BigInt(0);
            let array;
            if (value >> BigInt(65536) === empty) {
              let mask = BigInt(18446744073709552e3) - BigInt(1);
              let chunks = [];
              while (true) {
                chunks.push(value & mask);
                if (value >> BigInt(63) === empty) break;
                value >>= BigInt(64);
              }
              array = new Uint8Array(new BigUint64Array(chunks).buffer);
              array.reverse();
            } else {
              let invert = value < 0;
              let string = (invert ? ~value : value).toString(16);
              if (string.length % 2) {
                string = "0" + string;
              } else if (parseInt(string.charAt(0), 16) >= 8) {
                string = "00" + string;
              }
              if (hasNodeBuffer) {
                array = Buffer.from(string, "hex");
              } else {
                array = new Uint8Array(string.length / 2);
                for (let i = 0; i < array.length; i++) {
                  array[i] = parseInt(string.slice(i * 2, i * 2 + 2), 16);
                }
              }
              if (invert) {
                for (let i = 0; i < array.length; i++) array[i] = ~array[i];
              }
            }
            if (array.length + position2 > safeEnd)
              makeRoom(array.length + position2);
            position2 = writeExtensionData(array, target, position2, 66);
            return;
          } else {
            throw new RangeError(value + " was too large to fit in MessagePack 64-bit integer format, use useBigIntExtension, or set largeBigIntToFloat to convert to float-64, or set largeBigIntToString to convert to string");
          }
        }
        position2 += 8;
      } else if (type === "undefined") {
        if (this.encodeUndefinedAsNil)
          target[position2++] = 192;
        else {
          target[position2++] = 212;
          target[position2++] = 0;
          target[position2++] = 0;
        }
      } else {
        throw new Error("Unknown type: " + type);
      }
    };
    const writePlainObject = this.variableMapSize || this.coercibleKeyAsNumber || this.skipValues ? (object) => {
      let keys;
      if (this.skipValues) {
        keys = [];
        for (let key2 in object) {
          if ((typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key2)) && !this.skipValues.includes(object[key2]))
            keys.push(key2);
        }
      } else {
        keys = Object.keys(object);
      }
      let length = keys.length;
      if (length < 16) {
        target[position2++] = 128 | length;
      } else if (length < 65536) {
        target[position2++] = 222;
        target[position2++] = length >> 8;
        target[position2++] = length & 255;
      } else {
        target[position2++] = 223;
        targetView.setUint32(position2, length);
        position2 += 4;
      }
      let key;
      if (this.coercibleKeyAsNumber) {
        for (let i = 0; i < length; i++) {
          key = keys[i];
          let num = Number(key);
          pack2(isNaN(num) ? key : num);
          pack2(object[key]);
        }
      } else {
        for (let i = 0; i < length; i++) {
          pack2(key = keys[i]);
          pack2(object[key]);
        }
      }
    } : (object) => {
      target[position2++] = 222;
      let objectOffset = position2 - start;
      position2 += 2;
      let size = 0;
      for (let key in object) {
        if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) {
          pack2(key);
          pack2(object[key]);
          size++;
        }
      }
      if (size > 65535) {
        throw new Error('Object is too large to serialize with fast 16-bit map size, use the "variableMapSize" option to serialize this object');
      }
      target[objectOffset++ + start] = size >> 8;
      target[objectOffset + start] = size & 255;
    };
    const writeRecord = this.useRecords === false ? writePlainObject : options.progressiveRecords && !useTwoByteRecords ? (
      // this is about 2% faster for highly stable structures, since it only requires one for-in loop (but much more expensive when new structure needs to be written)
      (object) => {
        let nextTransition, transition = structures.transitions || (structures.transitions = /* @__PURE__ */ Object.create(null));
        let objectOffset = position2++ - start;
        let wroteKeys;
        for (let key in object) {
          if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) {
            nextTransition = transition[key];
            if (nextTransition)
              transition = nextTransition;
            else {
              let keys = Object.keys(object);
              let lastTransition = transition;
              transition = structures.transitions;
              let newTransitions = 0;
              for (let i = 0, l = keys.length; i < l; i++) {
                let key2 = keys[i];
                nextTransition = transition[key2];
                if (!nextTransition) {
                  nextTransition = transition[key2] = /* @__PURE__ */ Object.create(null);
                  newTransitions++;
                }
                transition = nextTransition;
              }
              if (objectOffset + start + 1 == position2) {
                position2--;
                newRecord(transition, keys, newTransitions);
              } else
                insertNewRecord(transition, keys, objectOffset, newTransitions);
              wroteKeys = true;
              transition = lastTransition[key];
            }
            pack2(object[key]);
          }
        }
        if (!wroteKeys) {
          let recordId = transition[RECORD_SYMBOL];
          if (recordId)
            target[objectOffset + start] = recordId;
          else
            insertNewRecord(transition, Object.keys(object), objectOffset, 0);
        }
      }
    ) : (object) => {
      let nextTransition, transition = structures.transitions || (structures.transitions = /* @__PURE__ */ Object.create(null));
      let newTransitions = 0;
      for (let key in object) if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) {
        nextTransition = transition[key];
        if (!nextTransition) {
          nextTransition = transition[key] = /* @__PURE__ */ Object.create(null);
          newTransitions++;
        }
        transition = nextTransition;
      }
      let recordId = transition[RECORD_SYMBOL];
      if (recordId) {
        if (recordId >= 96 && useTwoByteRecords) {
          target[position2++] = ((recordId -= 96) & 31) + 96;
          target[position2++] = recordId >> 5;
        } else
          target[position2++] = recordId;
      } else {
        newRecord(transition, transition.__keys__ || Object.keys(object), newTransitions);
      }
      for (let key in object)
        if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) {
          pack2(object[key]);
        }
    };
    const checkUseRecords = typeof this.useRecords == "function" && this.useRecords;
    const writeObject = checkUseRecords ? (object) => {
      checkUseRecords(object) ? writeRecord(object) : writePlainObject(object);
    } : writeRecord;
    const makeRoom = (end) => {
      let newSize;
      if (end > 16777216) {
        if (end - start > MAX_BUFFER_SIZE)
          throw new Error("Packed buffer would be larger than maximum buffer size");
        newSize = Math.min(
          MAX_BUFFER_SIZE,
          Math.round(Math.max((end - start) * (end > 67108864 ? 1.25 : 2), 4194304) / 4096) * 4096
        );
      } else
        newSize = (Math.max(end - start << 2, target.length - 1) >> 12) + 1 << 12;
      let newBuffer = new ByteArrayAllocate(newSize);
      targetView = newBuffer.dataView || (newBuffer.dataView = new DataView(newBuffer.buffer, 0, newSize));
      end = Math.min(end, target.length);
      if (target.copy)
        target.copy(newBuffer, 0, start, end);
      else
        newBuffer.set(target.slice(start, end));
      position2 -= start;
      start = 0;
      safeEnd = newBuffer.length - 10;
      return target = newBuffer;
    };
    const newRecord = (transition, keys, newTransitions) => {
      let recordId = structures.nextId;
      if (!recordId)
        recordId = 64;
      if (recordId < sharedLimitId && this.shouldShareStructure && !this.shouldShareStructure(keys)) {
        recordId = structures.nextOwnId;
        if (!(recordId < maxStructureId))
          recordId = sharedLimitId;
        structures.nextOwnId = recordId + 1;
      } else {
        if (recordId >= maxStructureId)
          recordId = sharedLimitId;
        structures.nextId = recordId + 1;
      }
      let highByte = keys.highByte = recordId >= 96 && useTwoByteRecords ? recordId - 96 >> 5 : -1;
      transition[RECORD_SYMBOL] = recordId;
      transition.__keys__ = keys;
      structures[recordId - 64] = keys;
      if (recordId < sharedLimitId) {
        keys.isShared = true;
        structures.sharedLength = recordId - 63;
        hasSharedUpdate = true;
        if (highByte >= 0) {
          target[position2++] = (recordId & 31) + 96;
          target[position2++] = highByte;
        } else {
          target[position2++] = recordId;
        }
      } else {
        if (highByte >= 0) {
          target[position2++] = 213;
          target[position2++] = 114;
          target[position2++] = (recordId & 31) + 96;
          target[position2++] = highByte;
        } else {
          target[position2++] = 212;
          target[position2++] = 114;
          target[position2++] = recordId;
        }
        if (newTransitions)
          transitionsCount += serializationsSinceTransitionRebuild * newTransitions;
        if (recordIdsToRemove.length >= maxOwnStructures)
          recordIdsToRemove.shift()[RECORD_SYMBOL] = 0;
        recordIdsToRemove.push(transition);
        pack2(keys);
      }
    };
    const insertNewRecord = (transition, keys, insertionOffset, newTransitions) => {
      let mainTarget = target;
      let mainPosition = position2;
      let mainSafeEnd = safeEnd;
      let mainStart = start;
      target = keysTarget;
      position2 = 0;
      start = 0;
      if (!target)
        keysTarget = target = new ByteArrayAllocate(8192);
      safeEnd = target.length - 10;
      newRecord(transition, keys, newTransitions);
      keysTarget = target;
      let keysPosition = position2;
      target = mainTarget;
      position2 = mainPosition;
      safeEnd = mainSafeEnd;
      start = mainStart;
      if (keysPosition > 1) {
        let newEnd = position2 + keysPosition - 1;
        if (newEnd > safeEnd)
          makeRoom(newEnd);
        let insertionPosition = insertionOffset + start;
        target.copyWithin(insertionPosition + keysPosition, insertionPosition + 1, position2);
        target.set(keysTarget.slice(0, keysPosition), insertionPosition);
        position2 = newEnd;
      } else {
        target[insertionOffset + start] = keysTarget[0];
      }
    };
    const writeStruct = (object) => {
      let newPosition = writeStructSlots(object, target, start, position2, structures, makeRoom, (value, newPosition2, notifySharedUpdate) => {
        if (notifySharedUpdate)
          return hasSharedUpdate = true;
        position2 = newPosition2;
        let startTarget = target;
        pack2(value);
        resetStructures();
        if (startTarget !== target) {
          return { position: position2, targetView, target };
        }
        return position2;
      }, this);
      if (newPosition === 0)
        return writeObject(object);
      position2 = newPosition;
    };
  }
  useBuffer(buffer) {
    target = buffer;
    target.dataView || (target.dataView = new DataView(target.buffer, target.byteOffset, target.byteLength));
    targetView = target.dataView;
    position2 = 0;
  }
  set position(value) {
    position2 = value;
  }
  get position() {
    return position2;
  }
  clearSharedData() {
    if (this.structures)
      this.structures = [];
    if (this.typedStructs)
      this.typedStructs = [];
  }
};
extensionClasses = [Date, Set, Error, RegExp, ArrayBuffer, Object.getPrototypeOf(Uint8Array.prototype).constructor, DataView, C1Type];
extensions = [{
  pack(date, allocateForWrite, pack2) {
    let seconds = date.getTime() / 1e3;
    if ((this.useTimestamp32 || date.getMilliseconds() === 0) && seconds >= 0 && seconds < 4294967296) {
      let { target: target2, targetView: targetView2, position: position3 } = allocateForWrite(6);
      target2[position3++] = 214;
      target2[position3++] = 255;
      targetView2.setUint32(position3, seconds);
    } else if (seconds > 0 && seconds < 4294967296) {
      let { target: target2, targetView: targetView2, position: position3 } = allocateForWrite(10);
      target2[position3++] = 215;
      target2[position3++] = 255;
      targetView2.setUint32(position3, date.getMilliseconds() * 4e6 + (seconds / 1e3 / 4294967296 >> 0));
      targetView2.setUint32(position3 + 4, seconds);
    } else if (isNaN(seconds)) {
      if (this.onInvalidDate) {
        allocateForWrite(0);
        return pack2(this.onInvalidDate());
      }
      let { target: target2, targetView: targetView2, position: position3 } = allocateForWrite(3);
      target2[position3++] = 212;
      target2[position3++] = 255;
      target2[position3++] = 255;
    } else {
      let { target: target2, targetView: targetView2, position: position3 } = allocateForWrite(15);
      target2[position3++] = 199;
      target2[position3++] = 12;
      target2[position3++] = 255;
      targetView2.setUint32(position3, date.getMilliseconds() * 1e6);
      targetView2.setBigInt64(position3 + 4, BigInt(Math.floor(seconds)));
    }
  }
}, {
  pack(set2, allocateForWrite, pack2) {
    if (this.setAsEmptyObject) {
      allocateForWrite(0);
      return pack2({});
    }
    let array = Array.from(set2);
    let { target: target2, position: position3 } = allocateForWrite(this.moreTypes ? 3 : 0);
    if (this.moreTypes) {
      target2[position3++] = 212;
      target2[position3++] = 115;
      target2[position3++] = 0;
    }
    pack2(array);
  }
}, {
  pack(error, allocateForWrite, pack2) {
    let { target: target2, position: position3 } = allocateForWrite(this.moreTypes ? 3 : 0);
    if (this.moreTypes) {
      target2[position3++] = 212;
      target2[position3++] = 101;
      target2[position3++] = 0;
    }
    pack2([error.name, error.message, error.cause]);
  }
}, {
  pack(regex, allocateForWrite, pack2) {
    let { target: target2, position: position3 } = allocateForWrite(this.moreTypes ? 3 : 0);
    if (this.moreTypes) {
      target2[position3++] = 212;
      target2[position3++] = 120;
      target2[position3++] = 0;
    }
    pack2([regex.source, regex.flags]);
  }
}, {
  pack(arrayBuffer, allocateForWrite) {
    if (this.moreTypes)
      writeExtBuffer(arrayBuffer, 16, allocateForWrite);
    else
      writeBuffer(hasNodeBuffer ? Buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer), allocateForWrite);
  }
}, {
  pack(typedArray, allocateForWrite) {
    let constructor = typedArray.constructor;
    if (constructor !== ByteArray && this.moreTypes)
      writeExtBuffer(typedArray, typedArrays.indexOf(constructor.name), allocateForWrite);
    else
      writeBuffer(typedArray, allocateForWrite);
  }
}, {
  pack(arrayBuffer, allocateForWrite) {
    if (this.moreTypes)
      writeExtBuffer(arrayBuffer, 17, allocateForWrite);
    else
      writeBuffer(hasNodeBuffer ? Buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer), allocateForWrite);
  }
}, {
  pack(c1, allocateForWrite) {
    let { target: target2, position: position3 } = allocateForWrite(1);
    target2[position3] = 193;
  }
}];
function writeExtBuffer(typedArray, type, allocateForWrite, encode2) {
  let length = typedArray.byteLength;
  if (length + 1 < 256) {
    var { target: target2, position: position3 } = allocateForWrite(4 + length);
    target2[position3++] = 199;
    target2[position3++] = length + 1;
  } else if (length + 1 < 65536) {
    var { target: target2, position: position3 } = allocateForWrite(5 + length);
    target2[position3++] = 200;
    target2[position3++] = length + 1 >> 8;
    target2[position3++] = length + 1 & 255;
  } else {
    var { target: target2, position: position3, targetView: targetView2 } = allocateForWrite(7 + length);
    target2[position3++] = 201;
    targetView2.setUint32(position3, length + 1);
    position3 += 4;
  }
  target2[position3++] = 116;
  target2[position3++] = type;
  if (!typedArray.buffer) typedArray = new Uint8Array(typedArray);
  target2.set(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength), position3);
}
function writeBuffer(buffer, allocateForWrite) {
  let length = buffer.byteLength;
  var target2, position3;
  if (length < 256) {
    var { target: target2, position: position3 } = allocateForWrite(length + 2);
    target2[position3++] = 196;
    target2[position3++] = length;
  } else if (length < 65536) {
    var { target: target2, position: position3 } = allocateForWrite(length + 3);
    target2[position3++] = 197;
    target2[position3++] = length >> 8;
    target2[position3++] = length & 255;
  } else {
    var { target: target2, position: position3, targetView: targetView2 } = allocateForWrite(length + 5);
    target2[position3++] = 198;
    targetView2.setUint32(position3, length);
    position3 += 4;
  }
  target2.set(buffer, position3);
}
function writeExtensionData(result, target2, position3, type) {
  let length = result.length;
  switch (length) {
    case 1:
      target2[position3++] = 212;
      break;
    case 2:
      target2[position3++] = 213;
      break;
    case 4:
      target2[position3++] = 214;
      break;
    case 8:
      target2[position3++] = 215;
      break;
    case 16:
      target2[position3++] = 216;
      break;
    default:
      if (length < 256) {
        target2[position3++] = 199;
        target2[position3++] = length;
      } else if (length < 65536) {
        target2[position3++] = 200;
        target2[position3++] = length >> 8;
        target2[position3++] = length & 255;
      } else {
        target2[position3++] = 201;
        target2[position3++] = length >> 24;
        target2[position3++] = length >> 16 & 255;
        target2[position3++] = length >> 8 & 255;
        target2[position3++] = length & 255;
      }
  }
  target2[position3++] = type;
  target2.set(result, position3);
  position3 += length;
  return position3;
}
function insertIds(serialized, idsToInsert) {
  let nextId;
  let distanceToMove = idsToInsert.length * 6;
  let lastEnd = serialized.length - distanceToMove;
  while (nextId = idsToInsert.pop()) {
    let offset = nextId.offset;
    let id = nextId.id;
    serialized.copyWithin(offset + distanceToMove, offset, lastEnd);
    distanceToMove -= 6;
    let position3 = offset + distanceToMove;
    serialized[position3++] = 214;
    serialized[position3++] = 105;
    serialized[position3++] = id >> 24;
    serialized[position3++] = id >> 16 & 255;
    serialized[position3++] = id >> 8 & 255;
    serialized[position3++] = id & 255;
    lastEnd = offset;
  }
  return serialized;
}
function writeBundles(start, pack2, incrementPosition) {
  if (bundledStrings2.length > 0) {
    targetView.setUint32(bundledStrings2.position + start, position2 + incrementPosition - bundledStrings2.position - start);
    bundledStrings2.stringsPosition = position2 - start;
    let writeStrings = bundledStrings2;
    bundledStrings2 = null;
    pack2(writeStrings[0]);
    pack2(writeStrings[1]);
  }
}
function prepareStructures(structures, packr) {
  structures.isCompatible = (existingStructures) => {
    let compatible = !existingStructures || (packr.lastNamedStructuresLength || 0) === existingStructures.length;
    if (!compatible)
      packr._mergeStructures(existingStructures);
    return compatible;
  };
  return structures;
}
var defaultPackr = new Packr({ useRecords: false });
var pack = defaultPackr.pack;
var encode = defaultPackr.pack;
var Encoder = Packr;
var { NEVER, ALWAYS, DECIMAL_ROUND, DECIMAL_FIT } = FLOAT32_OPTIONS;
var REUSE_BUFFER_MODE = 512;
var RESET_BUFFER_MODE = 1024;
var RESERVE_START_SPACE = 2048;

// node_modules/@aztec/bb.js/dest/browser/bbapi_exception.js
var BBApiException = class _BBApiException extends Error {
  constructor(message) {
    super(message);
    this.name = "BBApiException";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, _BBApiException);
    }
  }
};

// node_modules/@aztec/bb.js/dest/browser/cbind/generated/api_types.js
function toCircuitComputeVkResponse(o) {
  if (o.bytes === void 0) {
    throw new Error("Expected bytes in CircuitComputeVkResponse deserialization");
  }
  if (o.fields === void 0) {
    throw new Error("Expected fields in CircuitComputeVkResponse deserialization");
  }
  if (o.hash === void 0) {
    throw new Error("Expected hash in CircuitComputeVkResponse deserialization");
  }
  ;
  return {
    bytes: o.bytes,
    fields: o.fields,
    hash: o.hash
  };
}
function toGoblinProof(o) {
  if (o.merge_proof === void 0) {
    throw new Error("Expected merge_proof in GoblinProof deserialization");
  }
  if (o.eccvm_proof === void 0) {
    throw new Error("Expected eccvm_proof in GoblinProof deserialization");
  }
  if (o.ipa_proof === void 0) {
    throw new Error("Expected ipa_proof in GoblinProof deserialization");
  }
  if (o.translator_proof === void 0) {
    throw new Error("Expected translator_proof in GoblinProof deserialization");
  }
  ;
  return {
    mergeProof: o.merge_proof,
    eccvmProof: o.eccvm_proof,
    ipaProof: o.ipa_proof,
    translatorProof: o.translator_proof
  };
}
function toChonkProof(o) {
  if (o.mega_proof === void 0) {
    throw new Error("Expected mega_proof in ChonkProof deserialization");
  }
  if (o.goblin_proof === void 0) {
    throw new Error("Expected goblin_proof in ChonkProof deserialization");
  }
  ;
  return {
    megaProof: o.mega_proof,
    goblinProof: toGoblinProof(o.goblin_proof)
  };
}
function toGrumpkinPoint(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in GrumpkinPoint deserialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in GrumpkinPoint deserialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function toSecp256k1Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Secp256k1Point deserialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Secp256k1Point deserialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function toBn254G1Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Bn254G1Point deserialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Bn254G1Point deserialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function toBn254G2Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Bn254G2Point deserialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Bn254G2Point deserialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function toSecp256r1Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Secp256r1Point deserialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Secp256r1Point deserialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function toCircuitProveResponse(o) {
  if (o.public_inputs === void 0) {
    throw new Error("Expected public_inputs in CircuitProveResponse deserialization");
  }
  if (o.proof === void 0) {
    throw new Error("Expected proof in CircuitProveResponse deserialization");
  }
  if (o.vk === void 0) {
    throw new Error("Expected vk in CircuitProveResponse deserialization");
  }
  ;
  return {
    publicInputs: o.public_inputs,
    proof: o.proof,
    vk: toCircuitComputeVkResponse(o.vk)
  };
}
function toCircuitInfoResponse(o) {
  if (o.num_gates === void 0) {
    throw new Error("Expected num_gates in CircuitInfoResponse deserialization");
  }
  if (o.num_gates_dyadic === void 0) {
    throw new Error("Expected num_gates_dyadic in CircuitInfoResponse deserialization");
  }
  if (o.num_acir_opcodes === void 0) {
    throw new Error("Expected num_acir_opcodes in CircuitInfoResponse deserialization");
  }
  if (o.gates_per_opcode === void 0) {
    throw new Error("Expected gates_per_opcode in CircuitInfoResponse deserialization");
  }
  ;
  return {
    numGates: o.num_gates,
    numGatesDyadic: o.num_gates_dyadic,
    numAcirOpcodes: o.num_acir_opcodes,
    gatesPerOpcode: o.gates_per_opcode
  };
}
function toCircuitVerifyResponse(o) {
  if (o.verified === void 0) {
    throw new Error("Expected verified in CircuitVerifyResponse deserialization");
  }
  ;
  return {
    verified: o.verified
  };
}
function toChonkComputeVkResponse(o) {
  if (o.bytes === void 0) {
    throw new Error("Expected bytes in ChonkComputeVkResponse deserialization");
  }
  if (o.fields === void 0) {
    throw new Error("Expected fields in ChonkComputeVkResponse deserialization");
  }
  ;
  return {
    bytes: o.bytes,
    fields: o.fields
  };
}
function toChonkStartResponse(o) {
  return {};
}
function toChonkLoadResponse(o) {
  return {};
}
function toChonkAccumulateResponse(o) {
  return {};
}
function toChonkProveResponse(o) {
  if (o.proof === void 0) {
    throw new Error("Expected proof in ChonkProveResponse deserialization");
  }
  ;
  return {
    proof: toChonkProof(o.proof)
  };
}
function toChonkVerifyResponse(o) {
  if (o.valid === void 0) {
    throw new Error("Expected valid in ChonkVerifyResponse deserialization");
  }
  ;
  return {
    valid: o.valid
  };
}
function toVkAsFieldsResponse(o) {
  if (o.fields === void 0) {
    throw new Error("Expected fields in VkAsFieldsResponse deserialization");
  }
  ;
  return {
    fields: o.fields
  };
}
function toMegaVkAsFieldsResponse(o) {
  if (o.fields === void 0) {
    throw new Error("Expected fields in MegaVkAsFieldsResponse deserialization");
  }
  ;
  return {
    fields: o.fields
  };
}
function toCircuitWriteSolidityVerifierResponse(o) {
  if (o.solidity_code === void 0) {
    throw new Error("Expected solidity_code in CircuitWriteSolidityVerifierResponse deserialization");
  }
  ;
  return {
    solidityCode: o.solidity_code
  };
}
function toChonkCheckPrecomputedVkResponse(o) {
  if (o.valid === void 0) {
    throw new Error("Expected valid in ChonkCheckPrecomputedVkResponse deserialization");
  }
  if (o.actual_vk === void 0) {
    throw new Error("Expected actual_vk in ChonkCheckPrecomputedVkResponse deserialization");
  }
  ;
  return {
    valid: o.valid,
    actualVk: o.actual_vk
  };
}
function toChonkStatsResponse(o) {
  if (o.acir_opcodes === void 0) {
    throw new Error("Expected acir_opcodes in ChonkStatsResponse deserialization");
  }
  if (o.circuit_size === void 0) {
    throw new Error("Expected circuit_size in ChonkStatsResponse deserialization");
  }
  if (o.gates_per_opcode === void 0) {
    throw new Error("Expected gates_per_opcode in ChonkStatsResponse deserialization");
  }
  ;
  return {
    acirOpcodes: o.acir_opcodes,
    circuitSize: o.circuit_size,
    gatesPerOpcode: o.gates_per_opcode
  };
}
function toChonkCompressProofResponse(o) {
  if (o.compressed_proof === void 0) {
    throw new Error("Expected compressed_proof in ChonkCompressProofResponse deserialization");
  }
  ;
  return {
    compressedProof: o.compressed_proof
  };
}
function toChonkDecompressProofResponse(o) {
  if (o.proof === void 0) {
    throw new Error("Expected proof in ChonkDecompressProofResponse deserialization");
  }
  ;
  return {
    proof: toChonkProof(o.proof)
  };
}
function toPoseidon2HashResponse(o) {
  if (o.hash === void 0) {
    throw new Error("Expected hash in Poseidon2HashResponse deserialization");
  }
  ;
  return {
    hash: o.hash
  };
}
function toPoseidon2PermutationResponse(o) {
  if (o.outputs === void 0) {
    throw new Error("Expected outputs in Poseidon2PermutationResponse deserialization");
  }
  ;
  return {
    outputs: o.outputs
  };
}
function toPedersenCommitResponse(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in PedersenCommitResponse deserialization");
  }
  ;
  return {
    point: toGrumpkinPoint(o.point)
  };
}
function toPedersenHashResponse(o) {
  if (o.hash === void 0) {
    throw new Error("Expected hash in PedersenHashResponse deserialization");
  }
  ;
  return {
    hash: o.hash
  };
}
function toPedersenHashBufferResponse(o) {
  if (o.hash === void 0) {
    throw new Error("Expected hash in PedersenHashBufferResponse deserialization");
  }
  ;
  return {
    hash: o.hash
  };
}
function toBlake2sResponse(o) {
  if (o.hash === void 0) {
    throw new Error("Expected hash in Blake2sResponse deserialization");
  }
  ;
  return {
    hash: o.hash
  };
}
function toBlake2sToFieldResponse(o) {
  if (o.field === void 0) {
    throw new Error("Expected field in Blake2sToFieldResponse deserialization");
  }
  ;
  return {
    field: o.field
  };
}
function toAesEncryptResponse(o) {
  if (o.ciphertext === void 0) {
    throw new Error("Expected ciphertext in AesEncryptResponse deserialization");
  }
  ;
  return {
    ciphertext: o.ciphertext
  };
}
function toAesDecryptResponse(o) {
  if (o.plaintext === void 0) {
    throw new Error("Expected plaintext in AesDecryptResponse deserialization");
  }
  ;
  return {
    plaintext: o.plaintext
  };
}
function toGrumpkinMulResponse(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in GrumpkinMulResponse deserialization");
  }
  ;
  return {
    point: toGrumpkinPoint(o.point)
  };
}
function toGrumpkinAddResponse(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in GrumpkinAddResponse deserialization");
  }
  ;
  return {
    point: toGrumpkinPoint(o.point)
  };
}
function toGrumpkinBatchMulResponse(o) {
  if (o.points === void 0) {
    throw new Error("Expected points in GrumpkinBatchMulResponse deserialization");
  }
  ;
  return {
    points: o.points.map((v) => toGrumpkinPoint(v))
  };
}
function toGrumpkinGetRandomFrResponse(o) {
  if (o.value === void 0) {
    throw new Error("Expected value in GrumpkinGetRandomFrResponse deserialization");
  }
  ;
  return {
    value: o.value
  };
}
function toGrumpkinReduce512Response(o) {
  if (o.value === void 0) {
    throw new Error("Expected value in GrumpkinReduce512Response deserialization");
  }
  ;
  return {
    value: o.value
  };
}
function toSecp256k1MulResponse(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Secp256k1MulResponse deserialization");
  }
  ;
  return {
    point: toSecp256k1Point(o.point)
  };
}
function toSecp256k1GetRandomFrResponse(o) {
  if (o.value === void 0) {
    throw new Error("Expected value in Secp256k1GetRandomFrResponse deserialization");
  }
  ;
  return {
    value: o.value
  };
}
function toSecp256k1Reduce512Response(o) {
  if (o.value === void 0) {
    throw new Error("Expected value in Secp256k1Reduce512Response deserialization");
  }
  ;
  return {
    value: o.value
  };
}
function toBn254FrSqrtResponse(o) {
  if (o.is_square_root === void 0) {
    throw new Error("Expected is_square_root in Bn254FrSqrtResponse deserialization");
  }
  if (o.value === void 0) {
    throw new Error("Expected value in Bn254FrSqrtResponse deserialization");
  }
  ;
  return {
    isSquareRoot: o.is_square_root,
    value: o.value
  };
}
function toBn254FqSqrtResponse(o) {
  if (o.is_square_root === void 0) {
    throw new Error("Expected is_square_root in Bn254FqSqrtResponse deserialization");
  }
  if (o.value === void 0) {
    throw new Error("Expected value in Bn254FqSqrtResponse deserialization");
  }
  ;
  return {
    isSquareRoot: o.is_square_root,
    value: o.value
  };
}
function toBn254G1MulResponse(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Bn254G1MulResponse deserialization");
  }
  ;
  return {
    point: toBn254G1Point(o.point)
  };
}
function toBn254G2MulResponse(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Bn254G2MulResponse deserialization");
  }
  ;
  return {
    point: toBn254G2Point(o.point)
  };
}
function toBn254G1IsOnCurveResponse(o) {
  if (o.is_on_curve === void 0) {
    throw new Error("Expected is_on_curve in Bn254G1IsOnCurveResponse deserialization");
  }
  ;
  return {
    isOnCurve: o.is_on_curve
  };
}
function toBn254G1FromCompressedResponse(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Bn254G1FromCompressedResponse deserialization");
  }
  ;
  return {
    point: toBn254G1Point(o.point)
  };
}
function toSchnorrComputePublicKeyResponse(o) {
  if (o.public_key === void 0) {
    throw new Error("Expected public_key in SchnorrComputePublicKeyResponse deserialization");
  }
  ;
  return {
    publicKey: toGrumpkinPoint(o.public_key)
  };
}
function toSchnorrConstructSignatureResponse(o) {
  if (o.s === void 0) {
    throw new Error("Expected s in SchnorrConstructSignatureResponse deserialization");
  }
  if (o.e === void 0) {
    throw new Error("Expected e in SchnorrConstructSignatureResponse deserialization");
  }
  ;
  return {
    s: o.s,
    e: o.e
  };
}
function toSchnorrVerifySignatureResponse(o) {
  if (o.verified === void 0) {
    throw new Error("Expected verified in SchnorrVerifySignatureResponse deserialization");
  }
  ;
  return {
    verified: o.verified
  };
}
function toEcdsaSecp256k1ComputePublicKeyResponse(o) {
  if (o.public_key === void 0) {
    throw new Error("Expected public_key in EcdsaSecp256k1ComputePublicKeyResponse deserialization");
  }
  ;
  return {
    publicKey: toSecp256k1Point(o.public_key)
  };
}
function toEcdsaSecp256r1ComputePublicKeyResponse(o) {
  if (o.public_key === void 0) {
    throw new Error("Expected public_key in EcdsaSecp256r1ComputePublicKeyResponse deserialization");
  }
  ;
  return {
    publicKey: toSecp256r1Point(o.public_key)
  };
}
function toEcdsaSecp256k1ConstructSignatureResponse(o) {
  if (o.r === void 0) {
    throw new Error("Expected r in EcdsaSecp256k1ConstructSignatureResponse deserialization");
  }
  if (o.s === void 0) {
    throw new Error("Expected s in EcdsaSecp256k1ConstructSignatureResponse deserialization");
  }
  if (o.v === void 0) {
    throw new Error("Expected v in EcdsaSecp256k1ConstructSignatureResponse deserialization");
  }
  ;
  return {
    r: o.r,
    s: o.s,
    v: o.v
  };
}
function toEcdsaSecp256r1ConstructSignatureResponse(o) {
  if (o.r === void 0) {
    throw new Error("Expected r in EcdsaSecp256r1ConstructSignatureResponse deserialization");
  }
  if (o.s === void 0) {
    throw new Error("Expected s in EcdsaSecp256r1ConstructSignatureResponse deserialization");
  }
  if (o.v === void 0) {
    throw new Error("Expected v in EcdsaSecp256r1ConstructSignatureResponse deserialization");
  }
  ;
  return {
    r: o.r,
    s: o.s,
    v: o.v
  };
}
function toEcdsaSecp256k1RecoverPublicKeyResponse(o) {
  if (o.public_key === void 0) {
    throw new Error("Expected public_key in EcdsaSecp256k1RecoverPublicKeyResponse deserialization");
  }
  ;
  return {
    publicKey: toSecp256k1Point(o.public_key)
  };
}
function toEcdsaSecp256r1RecoverPublicKeyResponse(o) {
  if (o.public_key === void 0) {
    throw new Error("Expected public_key in EcdsaSecp256r1RecoverPublicKeyResponse deserialization");
  }
  ;
  return {
    publicKey: toSecp256r1Point(o.public_key)
  };
}
function toEcdsaSecp256k1VerifySignatureResponse(o) {
  if (o.verified === void 0) {
    throw new Error("Expected verified in EcdsaSecp256k1VerifySignatureResponse deserialization");
  }
  ;
  return {
    verified: o.verified
  };
}
function toEcdsaSecp256r1VerifySignatureResponse(o) {
  if (o.verified === void 0) {
    throw new Error("Expected verified in EcdsaSecp256r1VerifySignatureResponse deserialization");
  }
  ;
  return {
    verified: o.verified
  };
}
function toSrsInitSrsResponse(o) {
  if (o.dummy === void 0) {
    throw new Error("Expected dummy in SrsInitSrsResponse deserialization");
  }
  ;
  return {
    dummy: o.dummy
  };
}
function toSrsInitGrumpkinSrsResponse(o) {
  if (o.dummy === void 0) {
    throw new Error("Expected dummy in SrsInitGrumpkinSrsResponse deserialization");
  }
  ;
  return {
    dummy: o.dummy
  };
}
function toShutdownResponse(o) {
  return {};
}
function fromCircuitInput(o) {
  if (o.name === void 0) {
    throw new Error("Expected name in CircuitInput serialization");
  }
  if (o.bytecode === void 0) {
    throw new Error("Expected bytecode in CircuitInput serialization");
  }
  if (o.verificationKey === void 0) {
    throw new Error("Expected verificationKey in CircuitInput serialization");
  }
  ;
  return {
    name: o.name,
    bytecode: o.bytecode,
    verification_key: o.verificationKey
  };
}
function fromProofSystemSettings(o) {
  if (o.ipaAccumulation === void 0) {
    throw new Error("Expected ipaAccumulation in ProofSystemSettings serialization");
  }
  if (o.oracleHashType === void 0) {
    throw new Error("Expected oracleHashType in ProofSystemSettings serialization");
  }
  if (o.disableZk === void 0) {
    throw new Error("Expected disableZk in ProofSystemSettings serialization");
  }
  if (o.optimizedSolidityVerifier === void 0) {
    throw new Error("Expected optimizedSolidityVerifier in ProofSystemSettings serialization");
  }
  ;
  return {
    ipa_accumulation: o.ipaAccumulation,
    oracle_hash_type: o.oracleHashType,
    disable_zk: o.disableZk,
    optimized_solidity_verifier: o.optimizedSolidityVerifier
  };
}
function fromCircuitProve(o) {
  if (o.circuit === void 0) {
    throw new Error("Expected circuit in CircuitProve serialization");
  }
  if (o.witness === void 0) {
    throw new Error("Expected witness in CircuitProve serialization");
  }
  if (o.settings === void 0) {
    throw new Error("Expected settings in CircuitProve serialization");
  }
  ;
  return {
    circuit: fromCircuitInput(o.circuit),
    witness: o.witness,
    settings: fromProofSystemSettings(o.settings)
  };
}
function fromCircuitInputNoVK(o) {
  if (o.name === void 0) {
    throw new Error("Expected name in CircuitInputNoVK serialization");
  }
  if (o.bytecode === void 0) {
    throw new Error("Expected bytecode in CircuitInputNoVK serialization");
  }
  ;
  return {
    name: o.name,
    bytecode: o.bytecode
  };
}
function fromCircuitComputeVk(o) {
  if (o.circuit === void 0) {
    throw new Error("Expected circuit in CircuitComputeVk serialization");
  }
  if (o.settings === void 0) {
    throw new Error("Expected settings in CircuitComputeVk serialization");
  }
  ;
  return {
    circuit: fromCircuitInputNoVK(o.circuit),
    settings: fromProofSystemSettings(o.settings)
  };
}
function fromCircuitStats(o) {
  if (o.circuit === void 0) {
    throw new Error("Expected circuit in CircuitStats serialization");
  }
  if (o.includeGatesPerOpcode === void 0) {
    throw new Error("Expected includeGatesPerOpcode in CircuitStats serialization");
  }
  if (o.settings === void 0) {
    throw new Error("Expected settings in CircuitStats serialization");
  }
  ;
  return {
    circuit: fromCircuitInput(o.circuit),
    include_gates_per_opcode: o.includeGatesPerOpcode,
    settings: fromProofSystemSettings(o.settings)
  };
}
function fromCircuitVerify(o) {
  if (o.verificationKey === void 0) {
    throw new Error("Expected verificationKey in CircuitVerify serialization");
  }
  if (o.publicInputs === void 0) {
    throw new Error("Expected publicInputs in CircuitVerify serialization");
  }
  if (o.proof === void 0) {
    throw new Error("Expected proof in CircuitVerify serialization");
  }
  if (o.settings === void 0) {
    throw new Error("Expected settings in CircuitVerify serialization");
  }
  ;
  return {
    verification_key: o.verificationKey,
    public_inputs: o.publicInputs,
    proof: o.proof,
    settings: fromProofSystemSettings(o.settings)
  };
}
function fromChonkComputeVk(o) {
  if (o.circuit === void 0) {
    throw new Error("Expected circuit in ChonkComputeVk serialization");
  }
  ;
  return {
    circuit: fromCircuitInputNoVK(o.circuit)
  };
}
function fromChonkStart(o) {
  if (o.numCircuits === void 0) {
    throw new Error("Expected numCircuits in ChonkStart serialization");
  }
  ;
  return {
    num_circuits: o.numCircuits
  };
}
function fromChonkLoad(o) {
  if (o.circuit === void 0) {
    throw new Error("Expected circuit in ChonkLoad serialization");
  }
  ;
  return {
    circuit: fromCircuitInput(o.circuit)
  };
}
function fromChonkAccumulate(o) {
  if (o.witness === void 0) {
    throw new Error("Expected witness in ChonkAccumulate serialization");
  }
  ;
  return {
    witness: o.witness
  };
}
function fromChonkProve(o) {
  return {};
}
function fromGoblinProof(o) {
  if (o.mergeProof === void 0) {
    throw new Error("Expected mergeProof in GoblinProof serialization");
  }
  if (o.eccvmProof === void 0) {
    throw new Error("Expected eccvmProof in GoblinProof serialization");
  }
  if (o.ipaProof === void 0) {
    throw new Error("Expected ipaProof in GoblinProof serialization");
  }
  if (o.translatorProof === void 0) {
    throw new Error("Expected translatorProof in GoblinProof serialization");
  }
  ;
  return {
    merge_proof: o.mergeProof,
    eccvm_proof: o.eccvmProof,
    ipa_proof: o.ipaProof,
    translator_proof: o.translatorProof
  };
}
function fromChonkProof(o) {
  if (o.megaProof === void 0) {
    throw new Error("Expected megaProof in ChonkProof serialization");
  }
  if (o.goblinProof === void 0) {
    throw new Error("Expected goblinProof in ChonkProof serialization");
  }
  ;
  return {
    mega_proof: o.megaProof,
    goblin_proof: fromGoblinProof(o.goblinProof)
  };
}
function fromChonkVerify(o) {
  if (o.proof === void 0) {
    throw new Error("Expected proof in ChonkVerify serialization");
  }
  if (o.vk === void 0) {
    throw new Error("Expected vk in ChonkVerify serialization");
  }
  ;
  return {
    proof: fromChonkProof(o.proof),
    vk: o.vk
  };
}
function fromVkAsFields(o) {
  if (o.verificationKey === void 0) {
    throw new Error("Expected verificationKey in VkAsFields serialization");
  }
  ;
  return {
    verification_key: o.verificationKey
  };
}
function fromMegaVkAsFields(o) {
  if (o.verificationKey === void 0) {
    throw new Error("Expected verificationKey in MegaVkAsFields serialization");
  }
  ;
  return {
    verification_key: o.verificationKey
  };
}
function fromCircuitWriteSolidityVerifier(o) {
  if (o.verificationKey === void 0) {
    throw new Error("Expected verificationKey in CircuitWriteSolidityVerifier serialization");
  }
  if (o.settings === void 0) {
    throw new Error("Expected settings in CircuitWriteSolidityVerifier serialization");
  }
  ;
  return {
    verification_key: o.verificationKey,
    settings: fromProofSystemSettings(o.settings)
  };
}
function fromChonkCheckPrecomputedVk(o) {
  if (o.circuit === void 0) {
    throw new Error("Expected circuit in ChonkCheckPrecomputedVk serialization");
  }
  ;
  return {
    circuit: fromCircuitInput(o.circuit)
  };
}
function fromChonkStats(o) {
  if (o.circuit === void 0) {
    throw new Error("Expected circuit in ChonkStats serialization");
  }
  if (o.includeGatesPerOpcode === void 0) {
    throw new Error("Expected includeGatesPerOpcode in ChonkStats serialization");
  }
  ;
  return {
    circuit: fromCircuitInputNoVK(o.circuit),
    include_gates_per_opcode: o.includeGatesPerOpcode
  };
}
function fromChonkCompressProof(o) {
  if (o.proof === void 0) {
    throw new Error("Expected proof in ChonkCompressProof serialization");
  }
  ;
  return {
    proof: fromChonkProof(o.proof)
  };
}
function fromChonkDecompressProof(o) {
  if (o.compressedProof === void 0) {
    throw new Error("Expected compressedProof in ChonkDecompressProof serialization");
  }
  ;
  return {
    compressed_proof: o.compressedProof
  };
}
function fromPoseidon2Hash(o) {
  if (o.inputs === void 0) {
    throw new Error("Expected inputs in Poseidon2Hash serialization");
  }
  ;
  return {
    inputs: o.inputs
  };
}
function fromPoseidon2Permutation(o) {
  if (o.inputs === void 0) {
    throw new Error("Expected inputs in Poseidon2Permutation serialization");
  }
  ;
  return {
    inputs: o.inputs
  };
}
function fromPedersenCommit(o) {
  if (o.inputs === void 0) {
    throw new Error("Expected inputs in PedersenCommit serialization");
  }
  if (o.hashIndex === void 0) {
    throw new Error("Expected hashIndex in PedersenCommit serialization");
  }
  ;
  return {
    inputs: o.inputs,
    hash_index: o.hashIndex
  };
}
function fromPedersenHash(o) {
  if (o.inputs === void 0) {
    throw new Error("Expected inputs in PedersenHash serialization");
  }
  if (o.hashIndex === void 0) {
    throw new Error("Expected hashIndex in PedersenHash serialization");
  }
  ;
  return {
    inputs: o.inputs,
    hash_index: o.hashIndex
  };
}
function fromPedersenHashBuffer(o) {
  if (o.input === void 0) {
    throw new Error("Expected input in PedersenHashBuffer serialization");
  }
  if (o.hashIndex === void 0) {
    throw new Error("Expected hashIndex in PedersenHashBuffer serialization");
  }
  ;
  return {
    input: o.input,
    hash_index: o.hashIndex
  };
}
function fromBlake2s(o) {
  if (o.data === void 0) {
    throw new Error("Expected data in Blake2s serialization");
  }
  ;
  return {
    data: o.data
  };
}
function fromBlake2sToField(o) {
  if (o.data === void 0) {
    throw new Error("Expected data in Blake2sToField serialization");
  }
  ;
  return {
    data: o.data
  };
}
function fromAesEncrypt(o) {
  if (o.plaintext === void 0) {
    throw new Error("Expected plaintext in AesEncrypt serialization");
  }
  if (o.iv === void 0) {
    throw new Error("Expected iv in AesEncrypt serialization");
  }
  if (o.key === void 0) {
    throw new Error("Expected key in AesEncrypt serialization");
  }
  if (o.length === void 0) {
    throw new Error("Expected length in AesEncrypt serialization");
  }
  ;
  return {
    plaintext: o.plaintext,
    iv: o.iv,
    key: o.key,
    length: o.length
  };
}
function fromAesDecrypt(o) {
  if (o.ciphertext === void 0) {
    throw new Error("Expected ciphertext in AesDecrypt serialization");
  }
  if (o.iv === void 0) {
    throw new Error("Expected iv in AesDecrypt serialization");
  }
  if (o.key === void 0) {
    throw new Error("Expected key in AesDecrypt serialization");
  }
  if (o.length === void 0) {
    throw new Error("Expected length in AesDecrypt serialization");
  }
  ;
  return {
    ciphertext: o.ciphertext,
    iv: o.iv,
    key: o.key,
    length: o.length
  };
}
function fromGrumpkinPoint(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in GrumpkinPoint serialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in GrumpkinPoint serialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function fromGrumpkinMul(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in GrumpkinMul serialization");
  }
  if (o.scalar === void 0) {
    throw new Error("Expected scalar in GrumpkinMul serialization");
  }
  ;
  return {
    point: fromGrumpkinPoint(o.point),
    scalar: o.scalar
  };
}
function fromGrumpkinAdd(o) {
  if (o.pointA === void 0) {
    throw new Error("Expected pointA in GrumpkinAdd serialization");
  }
  if (o.pointB === void 0) {
    throw new Error("Expected pointB in GrumpkinAdd serialization");
  }
  ;
  return {
    point_a: fromGrumpkinPoint(o.pointA),
    point_b: fromGrumpkinPoint(o.pointB)
  };
}
function fromGrumpkinBatchMul(o) {
  if (o.points === void 0) {
    throw new Error("Expected points in GrumpkinBatchMul serialization");
  }
  if (o.scalar === void 0) {
    throw new Error("Expected scalar in GrumpkinBatchMul serialization");
  }
  ;
  return {
    points: o.points.map((v) => fromGrumpkinPoint(v)),
    scalar: o.scalar
  };
}
function fromGrumpkinGetRandomFr(o) {
  if (o.dummy === void 0) {
    throw new Error("Expected dummy in GrumpkinGetRandomFr serialization");
  }
  ;
  return {
    dummy: o.dummy
  };
}
function fromGrumpkinReduce512(o) {
  if (o.input === void 0) {
    throw new Error("Expected input in GrumpkinReduce512 serialization");
  }
  ;
  return {
    input: o.input
  };
}
function fromSecp256k1Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Secp256k1Point serialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Secp256k1Point serialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function fromSecp256k1Mul(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Secp256k1Mul serialization");
  }
  if (o.scalar === void 0) {
    throw new Error("Expected scalar in Secp256k1Mul serialization");
  }
  ;
  return {
    point: fromSecp256k1Point(o.point),
    scalar: o.scalar
  };
}
function fromSecp256k1GetRandomFr(o) {
  if (o.dummy === void 0) {
    throw new Error("Expected dummy in Secp256k1GetRandomFr serialization");
  }
  ;
  return {
    dummy: o.dummy
  };
}
function fromSecp256k1Reduce512(o) {
  if (o.input === void 0) {
    throw new Error("Expected input in Secp256k1Reduce512 serialization");
  }
  ;
  return {
    input: o.input
  };
}
function fromBn254FrSqrt(o) {
  if (o.input === void 0) {
    throw new Error("Expected input in Bn254FrSqrt serialization");
  }
  ;
  return {
    input: o.input
  };
}
function fromBn254FqSqrt(o) {
  if (o.input === void 0) {
    throw new Error("Expected input in Bn254FqSqrt serialization");
  }
  ;
  return {
    input: o.input
  };
}
function fromBn254G1Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Bn254G1Point serialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Bn254G1Point serialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function fromBn254G1Mul(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Bn254G1Mul serialization");
  }
  if (o.scalar === void 0) {
    throw new Error("Expected scalar in Bn254G1Mul serialization");
  }
  ;
  return {
    point: fromBn254G1Point(o.point),
    scalar: o.scalar
  };
}
function fromBn254G2Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Bn254G2Point serialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Bn254G2Point serialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function fromBn254G2Mul(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Bn254G2Mul serialization");
  }
  if (o.scalar === void 0) {
    throw new Error("Expected scalar in Bn254G2Mul serialization");
  }
  ;
  return {
    point: fromBn254G2Point(o.point),
    scalar: o.scalar
  };
}
function fromBn254G1IsOnCurve(o) {
  if (o.point === void 0) {
    throw new Error("Expected point in Bn254G1IsOnCurve serialization");
  }
  ;
  return {
    point: fromBn254G1Point(o.point)
  };
}
function fromBn254G1FromCompressed(o) {
  if (o.compressed === void 0) {
    throw new Error("Expected compressed in Bn254G1FromCompressed serialization");
  }
  ;
  return {
    compressed: o.compressed
  };
}
function fromSchnorrComputePublicKey(o) {
  if (o.privateKey === void 0) {
    throw new Error("Expected privateKey in SchnorrComputePublicKey serialization");
  }
  ;
  return {
    private_key: o.privateKey
  };
}
function fromSchnorrConstructSignature(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in SchnorrConstructSignature serialization");
  }
  if (o.privateKey === void 0) {
    throw new Error("Expected privateKey in SchnorrConstructSignature serialization");
  }
  ;
  return {
    message: o.message,
    private_key: o.privateKey
  };
}
function fromSchnorrVerifySignature(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in SchnorrVerifySignature serialization");
  }
  if (o.publicKey === void 0) {
    throw new Error("Expected publicKey in SchnorrVerifySignature serialization");
  }
  if (o.s === void 0) {
    throw new Error("Expected s in SchnorrVerifySignature serialization");
  }
  if (o.e === void 0) {
    throw new Error("Expected e in SchnorrVerifySignature serialization");
  }
  ;
  return {
    message: o.message,
    public_key: fromGrumpkinPoint(o.publicKey),
    s: o.s,
    e: o.e
  };
}
function fromEcdsaSecp256k1ComputePublicKey(o) {
  if (o.privateKey === void 0) {
    throw new Error("Expected privateKey in EcdsaSecp256k1ComputePublicKey serialization");
  }
  ;
  return {
    private_key: o.privateKey
  };
}
function fromEcdsaSecp256r1ComputePublicKey(o) {
  if (o.privateKey === void 0) {
    throw new Error("Expected privateKey in EcdsaSecp256r1ComputePublicKey serialization");
  }
  ;
  return {
    private_key: o.privateKey
  };
}
function fromEcdsaSecp256k1ConstructSignature(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in EcdsaSecp256k1ConstructSignature serialization");
  }
  if (o.privateKey === void 0) {
    throw new Error("Expected privateKey in EcdsaSecp256k1ConstructSignature serialization");
  }
  ;
  return {
    message: o.message,
    private_key: o.privateKey
  };
}
function fromEcdsaSecp256r1ConstructSignature(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in EcdsaSecp256r1ConstructSignature serialization");
  }
  if (o.privateKey === void 0) {
    throw new Error("Expected privateKey in EcdsaSecp256r1ConstructSignature serialization");
  }
  ;
  return {
    message: o.message,
    private_key: o.privateKey
  };
}
function fromEcdsaSecp256k1RecoverPublicKey(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in EcdsaSecp256k1RecoverPublicKey serialization");
  }
  if (o.r === void 0) {
    throw new Error("Expected r in EcdsaSecp256k1RecoverPublicKey serialization");
  }
  if (o.s === void 0) {
    throw new Error("Expected s in EcdsaSecp256k1RecoverPublicKey serialization");
  }
  if (o.v === void 0) {
    throw new Error("Expected v in EcdsaSecp256k1RecoverPublicKey serialization");
  }
  ;
  return {
    message: o.message,
    r: o.r,
    s: o.s,
    v: o.v
  };
}
function fromEcdsaSecp256r1RecoverPublicKey(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in EcdsaSecp256r1RecoverPublicKey serialization");
  }
  if (o.r === void 0) {
    throw new Error("Expected r in EcdsaSecp256r1RecoverPublicKey serialization");
  }
  if (o.s === void 0) {
    throw new Error("Expected s in EcdsaSecp256r1RecoverPublicKey serialization");
  }
  if (o.v === void 0) {
    throw new Error("Expected v in EcdsaSecp256r1RecoverPublicKey serialization");
  }
  ;
  return {
    message: o.message,
    r: o.r,
    s: o.s,
    v: o.v
  };
}
function fromEcdsaSecp256k1VerifySignature(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in EcdsaSecp256k1VerifySignature serialization");
  }
  if (o.publicKey === void 0) {
    throw new Error("Expected publicKey in EcdsaSecp256k1VerifySignature serialization");
  }
  if (o.r === void 0) {
    throw new Error("Expected r in EcdsaSecp256k1VerifySignature serialization");
  }
  if (o.s === void 0) {
    throw new Error("Expected s in EcdsaSecp256k1VerifySignature serialization");
  }
  if (o.v === void 0) {
    throw new Error("Expected v in EcdsaSecp256k1VerifySignature serialization");
  }
  ;
  return {
    message: o.message,
    public_key: fromSecp256k1Point(o.publicKey),
    r: o.r,
    s: o.s,
    v: o.v
  };
}
function fromSecp256r1Point(o) {
  if (o.x === void 0) {
    throw new Error("Expected x in Secp256r1Point serialization");
  }
  if (o.y === void 0) {
    throw new Error("Expected y in Secp256r1Point serialization");
  }
  ;
  return {
    x: o.x,
    y: o.y
  };
}
function fromEcdsaSecp256r1VerifySignature(o) {
  if (o.message === void 0) {
    throw new Error("Expected message in EcdsaSecp256r1VerifySignature serialization");
  }
  if (o.publicKey === void 0) {
    throw new Error("Expected publicKey in EcdsaSecp256r1VerifySignature serialization");
  }
  if (o.r === void 0) {
    throw new Error("Expected r in EcdsaSecp256r1VerifySignature serialization");
  }
  if (o.s === void 0) {
    throw new Error("Expected s in EcdsaSecp256r1VerifySignature serialization");
  }
  if (o.v === void 0) {
    throw new Error("Expected v in EcdsaSecp256r1VerifySignature serialization");
  }
  ;
  return {
    message: o.message,
    public_key: fromSecp256r1Point(o.publicKey),
    r: o.r,
    s: o.s,
    v: o.v
  };
}
function fromSrsInitSrs(o) {
  if (o.pointsBuf === void 0) {
    throw new Error("Expected pointsBuf in SrsInitSrs serialization");
  }
  if (o.numPoints === void 0) {
    throw new Error("Expected numPoints in SrsInitSrs serialization");
  }
  if (o.g2Point === void 0) {
    throw new Error("Expected g2Point in SrsInitSrs serialization");
  }
  ;
  return {
    points_buf: o.pointsBuf,
    num_points: o.numPoints,
    g2_point: o.g2Point
  };
}
function fromSrsInitGrumpkinSrs(o) {
  if (o.pointsBuf === void 0) {
    throw new Error("Expected pointsBuf in SrsInitGrumpkinSrs serialization");
  }
  if (o.numPoints === void 0) {
    throw new Error("Expected numPoints in SrsInitGrumpkinSrs serialization");
  }
  ;
  return {
    points_buf: o.pointsBuf,
    num_points: o.numPoints
  };
}
function fromShutdown(o) {
  return {};
}

// node_modules/@aztec/bb.js/dest/browser/cbind/generated/async.js
async function msgpackCall(backend, input) {
  const inputBuffer = new Encoder({ useRecords: false }).pack(input);
  const encodedResult = await backend.call(inputBuffer);
  return new Decoder({ useRecords: false }).unpack(encodedResult);
}
var AsyncApi = class {
  backend;
  constructor(backend) {
    this.backend = backend;
  }
  circuitProve(command) {
    const msgpackCommand = fromCircuitProve(command);
    return msgpackCall(this.backend, [["CircuitProve", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "CircuitProveResponse") {
        throw new BBApiException(`Expected variant name 'CircuitProveResponse' but got '${variantName}'`);
      }
      return toCircuitProveResponse(result);
    });
  }
  circuitComputeVk(command) {
    const msgpackCommand = fromCircuitComputeVk(command);
    return msgpackCall(this.backend, [["CircuitComputeVk", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "CircuitComputeVkResponse") {
        throw new BBApiException(`Expected variant name 'CircuitComputeVkResponse' but got '${variantName}'`);
      }
      return toCircuitComputeVkResponse(result);
    });
  }
  circuitStats(command) {
    const msgpackCommand = fromCircuitStats(command);
    return msgpackCall(this.backend, [["CircuitStats", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "CircuitInfoResponse") {
        throw new BBApiException(`Expected variant name 'CircuitInfoResponse' but got '${variantName}'`);
      }
      return toCircuitInfoResponse(result);
    });
  }
  circuitVerify(command) {
    const msgpackCommand = fromCircuitVerify(command);
    return msgpackCall(this.backend, [["CircuitVerify", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "CircuitVerifyResponse") {
        throw new BBApiException(`Expected variant name 'CircuitVerifyResponse' but got '${variantName}'`);
      }
      return toCircuitVerifyResponse(result);
    });
  }
  chonkComputeVk(command) {
    const msgpackCommand = fromChonkComputeVk(command);
    return msgpackCall(this.backend, [["ChonkComputeVk", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkComputeVkResponse") {
        throw new BBApiException(`Expected variant name 'ChonkComputeVkResponse' but got '${variantName}'`);
      }
      return toChonkComputeVkResponse(result);
    });
  }
  chonkStart(command) {
    const msgpackCommand = fromChonkStart(command);
    return msgpackCall(this.backend, [["ChonkStart", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkStartResponse") {
        throw new BBApiException(`Expected variant name 'ChonkStartResponse' but got '${variantName}'`);
      }
      return toChonkStartResponse(result);
    });
  }
  chonkLoad(command) {
    const msgpackCommand = fromChonkLoad(command);
    return msgpackCall(this.backend, [["ChonkLoad", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkLoadResponse") {
        throw new BBApiException(`Expected variant name 'ChonkLoadResponse' but got '${variantName}'`);
      }
      return toChonkLoadResponse(result);
    });
  }
  chonkAccumulate(command) {
    const msgpackCommand = fromChonkAccumulate(command);
    return msgpackCall(this.backend, [["ChonkAccumulate", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkAccumulateResponse") {
        throw new BBApiException(`Expected variant name 'ChonkAccumulateResponse' but got '${variantName}'`);
      }
      return toChonkAccumulateResponse(result);
    });
  }
  chonkProve(command) {
    const msgpackCommand = fromChonkProve(command);
    return msgpackCall(this.backend, [["ChonkProve", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkProveResponse") {
        throw new BBApiException(`Expected variant name 'ChonkProveResponse' but got '${variantName}'`);
      }
      return toChonkProveResponse(result);
    });
  }
  chonkVerify(command) {
    const msgpackCommand = fromChonkVerify(command);
    return msgpackCall(this.backend, [["ChonkVerify", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkVerifyResponse") {
        throw new BBApiException(`Expected variant name 'ChonkVerifyResponse' but got '${variantName}'`);
      }
      return toChonkVerifyResponse(result);
    });
  }
  vkAsFields(command) {
    const msgpackCommand = fromVkAsFields(command);
    return msgpackCall(this.backend, [["VkAsFields", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "VkAsFieldsResponse") {
        throw new BBApiException(`Expected variant name 'VkAsFieldsResponse' but got '${variantName}'`);
      }
      return toVkAsFieldsResponse(result);
    });
  }
  megaVkAsFields(command) {
    const msgpackCommand = fromMegaVkAsFields(command);
    return msgpackCall(this.backend, [["MegaVkAsFields", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "MegaVkAsFieldsResponse") {
        throw new BBApiException(`Expected variant name 'MegaVkAsFieldsResponse' but got '${variantName}'`);
      }
      return toMegaVkAsFieldsResponse(result);
    });
  }
  circuitWriteSolidityVerifier(command) {
    const msgpackCommand = fromCircuitWriteSolidityVerifier(command);
    return msgpackCall(this.backend, [["CircuitWriteSolidityVerifier", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "CircuitWriteSolidityVerifierResponse") {
        throw new BBApiException(`Expected variant name 'CircuitWriteSolidityVerifierResponse' but got '${variantName}'`);
      }
      return toCircuitWriteSolidityVerifierResponse(result);
    });
  }
  chonkCheckPrecomputedVk(command) {
    const msgpackCommand = fromChonkCheckPrecomputedVk(command);
    return msgpackCall(this.backend, [["ChonkCheckPrecomputedVk", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkCheckPrecomputedVkResponse") {
        throw new BBApiException(`Expected variant name 'ChonkCheckPrecomputedVkResponse' but got '${variantName}'`);
      }
      return toChonkCheckPrecomputedVkResponse(result);
    });
  }
  chonkStats(command) {
    const msgpackCommand = fromChonkStats(command);
    return msgpackCall(this.backend, [["ChonkStats", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkStatsResponse") {
        throw new BBApiException(`Expected variant name 'ChonkStatsResponse' but got '${variantName}'`);
      }
      return toChonkStatsResponse(result);
    });
  }
  chonkCompressProof(command) {
    const msgpackCommand = fromChonkCompressProof(command);
    return msgpackCall(this.backend, [["ChonkCompressProof", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkCompressProofResponse") {
        throw new BBApiException(`Expected variant name 'ChonkCompressProofResponse' but got '${variantName}'`);
      }
      return toChonkCompressProofResponse(result);
    });
  }
  chonkDecompressProof(command) {
    const msgpackCommand = fromChonkDecompressProof(command);
    return msgpackCall(this.backend, [["ChonkDecompressProof", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ChonkDecompressProofResponse") {
        throw new BBApiException(`Expected variant name 'ChonkDecompressProofResponse' but got '${variantName}'`);
      }
      return toChonkDecompressProofResponse(result);
    });
  }
  poseidon2Hash(command) {
    const msgpackCommand = fromPoseidon2Hash(command);
    return msgpackCall(this.backend, [["Poseidon2Hash", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Poseidon2HashResponse") {
        throw new BBApiException(`Expected variant name 'Poseidon2HashResponse' but got '${variantName}'`);
      }
      return toPoseidon2HashResponse(result);
    });
  }
  poseidon2Permutation(command) {
    const msgpackCommand = fromPoseidon2Permutation(command);
    return msgpackCall(this.backend, [["Poseidon2Permutation", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Poseidon2PermutationResponse") {
        throw new BBApiException(`Expected variant name 'Poseidon2PermutationResponse' but got '${variantName}'`);
      }
      return toPoseidon2PermutationResponse(result);
    });
  }
  pedersenCommit(command) {
    const msgpackCommand = fromPedersenCommit(command);
    return msgpackCall(this.backend, [["PedersenCommit", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "PedersenCommitResponse") {
        throw new BBApiException(`Expected variant name 'PedersenCommitResponse' but got '${variantName}'`);
      }
      return toPedersenCommitResponse(result);
    });
  }
  pedersenHash(command) {
    const msgpackCommand = fromPedersenHash(command);
    return msgpackCall(this.backend, [["PedersenHash", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "PedersenHashResponse") {
        throw new BBApiException(`Expected variant name 'PedersenHashResponse' but got '${variantName}'`);
      }
      return toPedersenHashResponse(result);
    });
  }
  pedersenHashBuffer(command) {
    const msgpackCommand = fromPedersenHashBuffer(command);
    return msgpackCall(this.backend, [["PedersenHashBuffer", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "PedersenHashBufferResponse") {
        throw new BBApiException(`Expected variant name 'PedersenHashBufferResponse' but got '${variantName}'`);
      }
      return toPedersenHashBufferResponse(result);
    });
  }
  blake2s(command) {
    const msgpackCommand = fromBlake2s(command);
    return msgpackCall(this.backend, [["Blake2s", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Blake2sResponse") {
        throw new BBApiException(`Expected variant name 'Blake2sResponse' but got '${variantName}'`);
      }
      return toBlake2sResponse(result);
    });
  }
  blake2sToField(command) {
    const msgpackCommand = fromBlake2sToField(command);
    return msgpackCall(this.backend, [["Blake2sToField", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Blake2sToFieldResponse") {
        throw new BBApiException(`Expected variant name 'Blake2sToFieldResponse' but got '${variantName}'`);
      }
      return toBlake2sToFieldResponse(result);
    });
  }
  aesEncrypt(command) {
    const msgpackCommand = fromAesEncrypt(command);
    return msgpackCall(this.backend, [["AesEncrypt", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "AesEncryptResponse") {
        throw new BBApiException(`Expected variant name 'AesEncryptResponse' but got '${variantName}'`);
      }
      return toAesEncryptResponse(result);
    });
  }
  aesDecrypt(command) {
    const msgpackCommand = fromAesDecrypt(command);
    return msgpackCall(this.backend, [["AesDecrypt", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "AesDecryptResponse") {
        throw new BBApiException(`Expected variant name 'AesDecryptResponse' but got '${variantName}'`);
      }
      return toAesDecryptResponse(result);
    });
  }
  grumpkinMul(command) {
    const msgpackCommand = fromGrumpkinMul(command);
    return msgpackCall(this.backend, [["GrumpkinMul", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "GrumpkinMulResponse") {
        throw new BBApiException(`Expected variant name 'GrumpkinMulResponse' but got '${variantName}'`);
      }
      return toGrumpkinMulResponse(result);
    });
  }
  grumpkinAdd(command) {
    const msgpackCommand = fromGrumpkinAdd(command);
    return msgpackCall(this.backend, [["GrumpkinAdd", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "GrumpkinAddResponse") {
        throw new BBApiException(`Expected variant name 'GrumpkinAddResponse' but got '${variantName}'`);
      }
      return toGrumpkinAddResponse(result);
    });
  }
  grumpkinBatchMul(command) {
    const msgpackCommand = fromGrumpkinBatchMul(command);
    return msgpackCall(this.backend, [["GrumpkinBatchMul", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "GrumpkinBatchMulResponse") {
        throw new BBApiException(`Expected variant name 'GrumpkinBatchMulResponse' but got '${variantName}'`);
      }
      return toGrumpkinBatchMulResponse(result);
    });
  }
  grumpkinGetRandomFr(command) {
    const msgpackCommand = fromGrumpkinGetRandomFr(command);
    return msgpackCall(this.backend, [["GrumpkinGetRandomFr", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "GrumpkinGetRandomFrResponse") {
        throw new BBApiException(`Expected variant name 'GrumpkinGetRandomFrResponse' but got '${variantName}'`);
      }
      return toGrumpkinGetRandomFrResponse(result);
    });
  }
  grumpkinReduce512(command) {
    const msgpackCommand = fromGrumpkinReduce512(command);
    return msgpackCall(this.backend, [["GrumpkinReduce512", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "GrumpkinReduce512Response") {
        throw new BBApiException(`Expected variant name 'GrumpkinReduce512Response' but got '${variantName}'`);
      }
      return toGrumpkinReduce512Response(result);
    });
  }
  secp256k1Mul(command) {
    const msgpackCommand = fromSecp256k1Mul(command);
    return msgpackCall(this.backend, [["Secp256k1Mul", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Secp256k1MulResponse") {
        throw new BBApiException(`Expected variant name 'Secp256k1MulResponse' but got '${variantName}'`);
      }
      return toSecp256k1MulResponse(result);
    });
  }
  secp256k1GetRandomFr(command) {
    const msgpackCommand = fromSecp256k1GetRandomFr(command);
    return msgpackCall(this.backend, [["Secp256k1GetRandomFr", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Secp256k1GetRandomFrResponse") {
        throw new BBApiException(`Expected variant name 'Secp256k1GetRandomFrResponse' but got '${variantName}'`);
      }
      return toSecp256k1GetRandomFrResponse(result);
    });
  }
  secp256k1Reduce512(command) {
    const msgpackCommand = fromSecp256k1Reduce512(command);
    return msgpackCall(this.backend, [["Secp256k1Reduce512", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Secp256k1Reduce512Response") {
        throw new BBApiException(`Expected variant name 'Secp256k1Reduce512Response' but got '${variantName}'`);
      }
      return toSecp256k1Reduce512Response(result);
    });
  }
  bn254FrSqrt(command) {
    const msgpackCommand = fromBn254FrSqrt(command);
    return msgpackCall(this.backend, [["Bn254FrSqrt", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Bn254FrSqrtResponse") {
        throw new BBApiException(`Expected variant name 'Bn254FrSqrtResponse' but got '${variantName}'`);
      }
      return toBn254FrSqrtResponse(result);
    });
  }
  bn254FqSqrt(command) {
    const msgpackCommand = fromBn254FqSqrt(command);
    return msgpackCall(this.backend, [["Bn254FqSqrt", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Bn254FqSqrtResponse") {
        throw new BBApiException(`Expected variant name 'Bn254FqSqrtResponse' but got '${variantName}'`);
      }
      return toBn254FqSqrtResponse(result);
    });
  }
  bn254G1Mul(command) {
    const msgpackCommand = fromBn254G1Mul(command);
    return msgpackCall(this.backend, [["Bn254G1Mul", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Bn254G1MulResponse") {
        throw new BBApiException(`Expected variant name 'Bn254G1MulResponse' but got '${variantName}'`);
      }
      return toBn254G1MulResponse(result);
    });
  }
  bn254G2Mul(command) {
    const msgpackCommand = fromBn254G2Mul(command);
    return msgpackCall(this.backend, [["Bn254G2Mul", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Bn254G2MulResponse") {
        throw new BBApiException(`Expected variant name 'Bn254G2MulResponse' but got '${variantName}'`);
      }
      return toBn254G2MulResponse(result);
    });
  }
  bn254G1IsOnCurve(command) {
    const msgpackCommand = fromBn254G1IsOnCurve(command);
    return msgpackCall(this.backend, [["Bn254G1IsOnCurve", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Bn254G1IsOnCurveResponse") {
        throw new BBApiException(`Expected variant name 'Bn254G1IsOnCurveResponse' but got '${variantName}'`);
      }
      return toBn254G1IsOnCurveResponse(result);
    });
  }
  bn254G1FromCompressed(command) {
    const msgpackCommand = fromBn254G1FromCompressed(command);
    return msgpackCall(this.backend, [["Bn254G1FromCompressed", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "Bn254G1FromCompressedResponse") {
        throw new BBApiException(`Expected variant name 'Bn254G1FromCompressedResponse' but got '${variantName}'`);
      }
      return toBn254G1FromCompressedResponse(result);
    });
  }
  schnorrComputePublicKey(command) {
    const msgpackCommand = fromSchnorrComputePublicKey(command);
    return msgpackCall(this.backend, [["SchnorrComputePublicKey", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "SchnorrComputePublicKeyResponse") {
        throw new BBApiException(`Expected variant name 'SchnorrComputePublicKeyResponse' but got '${variantName}'`);
      }
      return toSchnorrComputePublicKeyResponse(result);
    });
  }
  schnorrConstructSignature(command) {
    const msgpackCommand = fromSchnorrConstructSignature(command);
    return msgpackCall(this.backend, [["SchnorrConstructSignature", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "SchnorrConstructSignatureResponse") {
        throw new BBApiException(`Expected variant name 'SchnorrConstructSignatureResponse' but got '${variantName}'`);
      }
      return toSchnorrConstructSignatureResponse(result);
    });
  }
  schnorrVerifySignature(command) {
    const msgpackCommand = fromSchnorrVerifySignature(command);
    return msgpackCall(this.backend, [["SchnorrVerifySignature", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "SchnorrVerifySignatureResponse") {
        throw new BBApiException(`Expected variant name 'SchnorrVerifySignatureResponse' but got '${variantName}'`);
      }
      return toSchnorrVerifySignatureResponse(result);
    });
  }
  ecdsaSecp256k1ComputePublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256k1ComputePublicKey(command);
    return msgpackCall(this.backend, [["EcdsaSecp256k1ComputePublicKey", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256k1ComputePublicKeyResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256k1ComputePublicKeyResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256k1ComputePublicKeyResponse(result);
    });
  }
  ecdsaSecp256r1ComputePublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256r1ComputePublicKey(command);
    return msgpackCall(this.backend, [["EcdsaSecp256r1ComputePublicKey", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256r1ComputePublicKeyResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256r1ComputePublicKeyResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256r1ComputePublicKeyResponse(result);
    });
  }
  ecdsaSecp256k1ConstructSignature(command) {
    const msgpackCommand = fromEcdsaSecp256k1ConstructSignature(command);
    return msgpackCall(this.backend, [["EcdsaSecp256k1ConstructSignature", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256k1ConstructSignatureResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256k1ConstructSignatureResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256k1ConstructSignatureResponse(result);
    });
  }
  ecdsaSecp256r1ConstructSignature(command) {
    const msgpackCommand = fromEcdsaSecp256r1ConstructSignature(command);
    return msgpackCall(this.backend, [["EcdsaSecp256r1ConstructSignature", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256r1ConstructSignatureResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256r1ConstructSignatureResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256r1ConstructSignatureResponse(result);
    });
  }
  ecdsaSecp256k1RecoverPublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256k1RecoverPublicKey(command);
    return msgpackCall(this.backend, [["EcdsaSecp256k1RecoverPublicKey", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256k1RecoverPublicKeyResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256k1RecoverPublicKeyResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256k1RecoverPublicKeyResponse(result);
    });
  }
  ecdsaSecp256r1RecoverPublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256r1RecoverPublicKey(command);
    return msgpackCall(this.backend, [["EcdsaSecp256r1RecoverPublicKey", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256r1RecoverPublicKeyResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256r1RecoverPublicKeyResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256r1RecoverPublicKeyResponse(result);
    });
  }
  ecdsaSecp256k1VerifySignature(command) {
    const msgpackCommand = fromEcdsaSecp256k1VerifySignature(command);
    return msgpackCall(this.backend, [["EcdsaSecp256k1VerifySignature", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256k1VerifySignatureResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256k1VerifySignatureResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256k1VerifySignatureResponse(result);
    });
  }
  ecdsaSecp256r1VerifySignature(command) {
    const msgpackCommand = fromEcdsaSecp256r1VerifySignature(command);
    return msgpackCall(this.backend, [["EcdsaSecp256r1VerifySignature", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "EcdsaSecp256r1VerifySignatureResponse") {
        throw new BBApiException(`Expected variant name 'EcdsaSecp256r1VerifySignatureResponse' but got '${variantName}'`);
      }
      return toEcdsaSecp256r1VerifySignatureResponse(result);
    });
  }
  srsInitSrs(command) {
    const msgpackCommand = fromSrsInitSrs(command);
    return msgpackCall(this.backend, [["SrsInitSrs", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "SrsInitSrsResponse") {
        throw new BBApiException(`Expected variant name 'SrsInitSrsResponse' but got '${variantName}'`);
      }
      return toSrsInitSrsResponse(result);
    });
  }
  srsInitGrumpkinSrs(command) {
    const msgpackCommand = fromSrsInitGrumpkinSrs(command);
    return msgpackCall(this.backend, [["SrsInitGrumpkinSrs", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "SrsInitGrumpkinSrsResponse") {
        throw new BBApiException(`Expected variant name 'SrsInitGrumpkinSrsResponse' but got '${variantName}'`);
      }
      return toSrsInitGrumpkinSrsResponse(result);
    });
  }
  shutdown(command) {
    const msgpackCommand = fromShutdown(command);
    return msgpackCall(this.backend, [["Shutdown", msgpackCommand]]).then(([variantName, result]) => {
      if (variantName === "ErrorResponse") {
        throw new BBApiException(result.message || "Unknown error from barretenberg");
      }
      if (variantName !== "ShutdownResponse") {
        throw new BBApiException(`Expected variant name 'ShutdownResponse' but got '${variantName}'`);
      }
      return toShutdownResponse(result);
    });
  }
  destroy() {
    return this.backend.destroy ? this.backend.destroy() : Promise.resolve();
  }
};

// node_modules/@aztec/bb.js/dest/browser/cbind/generated/sync.js
function msgpackCall2(backend, input) {
  const inputBuffer = new Encoder({ useRecords: false }).pack(input);
  const encodedResult = backend.call(inputBuffer);
  return new Decoder({ useRecords: false }).unpack(encodedResult);
}
var SyncApi = class {
  backend;
  constructor(backend) {
    this.backend = backend;
  }
  circuitProve(command) {
    const msgpackCommand = fromCircuitProve(command);
    const [variantName, result] = msgpackCall2(this.backend, [["CircuitProve", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "CircuitProveResponse") {
      throw new BBApiException(`Expected variant name 'CircuitProveResponse' but got '${variantName}'`);
    }
    return toCircuitProveResponse(result);
  }
  circuitComputeVk(command) {
    const msgpackCommand = fromCircuitComputeVk(command);
    const [variantName, result] = msgpackCall2(this.backend, [["CircuitComputeVk", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "CircuitComputeVkResponse") {
      throw new BBApiException(`Expected variant name 'CircuitComputeVkResponse' but got '${variantName}'`);
    }
    return toCircuitComputeVkResponse(result);
  }
  circuitStats(command) {
    const msgpackCommand = fromCircuitStats(command);
    const [variantName, result] = msgpackCall2(this.backend, [["CircuitStats", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "CircuitInfoResponse") {
      throw new BBApiException(`Expected variant name 'CircuitInfoResponse' but got '${variantName}'`);
    }
    return toCircuitInfoResponse(result);
  }
  circuitVerify(command) {
    const msgpackCommand = fromCircuitVerify(command);
    const [variantName, result] = msgpackCall2(this.backend, [["CircuitVerify", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "CircuitVerifyResponse") {
      throw new BBApiException(`Expected variant name 'CircuitVerifyResponse' but got '${variantName}'`);
    }
    return toCircuitVerifyResponse(result);
  }
  chonkComputeVk(command) {
    const msgpackCommand = fromChonkComputeVk(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkComputeVk", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkComputeVkResponse") {
      throw new BBApiException(`Expected variant name 'ChonkComputeVkResponse' but got '${variantName}'`);
    }
    return toChonkComputeVkResponse(result);
  }
  chonkStart(command) {
    const msgpackCommand = fromChonkStart(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkStart", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkStartResponse") {
      throw new BBApiException(`Expected variant name 'ChonkStartResponse' but got '${variantName}'`);
    }
    return toChonkStartResponse(result);
  }
  chonkLoad(command) {
    const msgpackCommand = fromChonkLoad(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkLoad", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkLoadResponse") {
      throw new BBApiException(`Expected variant name 'ChonkLoadResponse' but got '${variantName}'`);
    }
    return toChonkLoadResponse(result);
  }
  chonkAccumulate(command) {
    const msgpackCommand = fromChonkAccumulate(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkAccumulate", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkAccumulateResponse") {
      throw new BBApiException(`Expected variant name 'ChonkAccumulateResponse' but got '${variantName}'`);
    }
    return toChonkAccumulateResponse(result);
  }
  chonkProve(command) {
    const msgpackCommand = fromChonkProve(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkProve", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkProveResponse") {
      throw new BBApiException(`Expected variant name 'ChonkProveResponse' but got '${variantName}'`);
    }
    return toChonkProveResponse(result);
  }
  chonkVerify(command) {
    const msgpackCommand = fromChonkVerify(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkVerify", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkVerifyResponse") {
      throw new BBApiException(`Expected variant name 'ChonkVerifyResponse' but got '${variantName}'`);
    }
    return toChonkVerifyResponse(result);
  }
  vkAsFields(command) {
    const msgpackCommand = fromVkAsFields(command);
    const [variantName, result] = msgpackCall2(this.backend, [["VkAsFields", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "VkAsFieldsResponse") {
      throw new BBApiException(`Expected variant name 'VkAsFieldsResponse' but got '${variantName}'`);
    }
    return toVkAsFieldsResponse(result);
  }
  megaVkAsFields(command) {
    const msgpackCommand = fromMegaVkAsFields(command);
    const [variantName, result] = msgpackCall2(this.backend, [["MegaVkAsFields", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "MegaVkAsFieldsResponse") {
      throw new BBApiException(`Expected variant name 'MegaVkAsFieldsResponse' but got '${variantName}'`);
    }
    return toMegaVkAsFieldsResponse(result);
  }
  circuitWriteSolidityVerifier(command) {
    const msgpackCommand = fromCircuitWriteSolidityVerifier(command);
    const [variantName, result] = msgpackCall2(this.backend, [["CircuitWriteSolidityVerifier", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "CircuitWriteSolidityVerifierResponse") {
      throw new BBApiException(`Expected variant name 'CircuitWriteSolidityVerifierResponse' but got '${variantName}'`);
    }
    return toCircuitWriteSolidityVerifierResponse(result);
  }
  chonkCheckPrecomputedVk(command) {
    const msgpackCommand = fromChonkCheckPrecomputedVk(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkCheckPrecomputedVk", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkCheckPrecomputedVkResponse") {
      throw new BBApiException(`Expected variant name 'ChonkCheckPrecomputedVkResponse' but got '${variantName}'`);
    }
    return toChonkCheckPrecomputedVkResponse(result);
  }
  chonkStats(command) {
    const msgpackCommand = fromChonkStats(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkStats", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkStatsResponse") {
      throw new BBApiException(`Expected variant name 'ChonkStatsResponse' but got '${variantName}'`);
    }
    return toChonkStatsResponse(result);
  }
  chonkCompressProof(command) {
    const msgpackCommand = fromChonkCompressProof(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkCompressProof", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkCompressProofResponse") {
      throw new BBApiException(`Expected variant name 'ChonkCompressProofResponse' but got '${variantName}'`);
    }
    return toChonkCompressProofResponse(result);
  }
  chonkDecompressProof(command) {
    const msgpackCommand = fromChonkDecompressProof(command);
    const [variantName, result] = msgpackCall2(this.backend, [["ChonkDecompressProof", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ChonkDecompressProofResponse") {
      throw new BBApiException(`Expected variant name 'ChonkDecompressProofResponse' but got '${variantName}'`);
    }
    return toChonkDecompressProofResponse(result);
  }
  poseidon2Hash(command) {
    const msgpackCommand = fromPoseidon2Hash(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Poseidon2Hash", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Poseidon2HashResponse") {
      throw new BBApiException(`Expected variant name 'Poseidon2HashResponse' but got '${variantName}'`);
    }
    return toPoseidon2HashResponse(result);
  }
  poseidon2Permutation(command) {
    const msgpackCommand = fromPoseidon2Permutation(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Poseidon2Permutation", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Poseidon2PermutationResponse") {
      throw new BBApiException(`Expected variant name 'Poseidon2PermutationResponse' but got '${variantName}'`);
    }
    return toPoseidon2PermutationResponse(result);
  }
  pedersenCommit(command) {
    const msgpackCommand = fromPedersenCommit(command);
    const [variantName, result] = msgpackCall2(this.backend, [["PedersenCommit", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "PedersenCommitResponse") {
      throw new BBApiException(`Expected variant name 'PedersenCommitResponse' but got '${variantName}'`);
    }
    return toPedersenCommitResponse(result);
  }
  pedersenHash(command) {
    const msgpackCommand = fromPedersenHash(command);
    const [variantName, result] = msgpackCall2(this.backend, [["PedersenHash", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "PedersenHashResponse") {
      throw new BBApiException(`Expected variant name 'PedersenHashResponse' but got '${variantName}'`);
    }
    return toPedersenHashResponse(result);
  }
  pedersenHashBuffer(command) {
    const msgpackCommand = fromPedersenHashBuffer(command);
    const [variantName, result] = msgpackCall2(this.backend, [["PedersenHashBuffer", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "PedersenHashBufferResponse") {
      throw new BBApiException(`Expected variant name 'PedersenHashBufferResponse' but got '${variantName}'`);
    }
    return toPedersenHashBufferResponse(result);
  }
  blake2s(command) {
    const msgpackCommand = fromBlake2s(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Blake2s", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Blake2sResponse") {
      throw new BBApiException(`Expected variant name 'Blake2sResponse' but got '${variantName}'`);
    }
    return toBlake2sResponse(result);
  }
  blake2sToField(command) {
    const msgpackCommand = fromBlake2sToField(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Blake2sToField", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Blake2sToFieldResponse") {
      throw new BBApiException(`Expected variant name 'Blake2sToFieldResponse' but got '${variantName}'`);
    }
    return toBlake2sToFieldResponse(result);
  }
  aesEncrypt(command) {
    const msgpackCommand = fromAesEncrypt(command);
    const [variantName, result] = msgpackCall2(this.backend, [["AesEncrypt", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "AesEncryptResponse") {
      throw new BBApiException(`Expected variant name 'AesEncryptResponse' but got '${variantName}'`);
    }
    return toAesEncryptResponse(result);
  }
  aesDecrypt(command) {
    const msgpackCommand = fromAesDecrypt(command);
    const [variantName, result] = msgpackCall2(this.backend, [["AesDecrypt", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "AesDecryptResponse") {
      throw new BBApiException(`Expected variant name 'AesDecryptResponse' but got '${variantName}'`);
    }
    return toAesDecryptResponse(result);
  }
  grumpkinMul(command) {
    const msgpackCommand = fromGrumpkinMul(command);
    const [variantName, result] = msgpackCall2(this.backend, [["GrumpkinMul", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "GrumpkinMulResponse") {
      throw new BBApiException(`Expected variant name 'GrumpkinMulResponse' but got '${variantName}'`);
    }
    return toGrumpkinMulResponse(result);
  }
  grumpkinAdd(command) {
    const msgpackCommand = fromGrumpkinAdd(command);
    const [variantName, result] = msgpackCall2(this.backend, [["GrumpkinAdd", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "GrumpkinAddResponse") {
      throw new BBApiException(`Expected variant name 'GrumpkinAddResponse' but got '${variantName}'`);
    }
    return toGrumpkinAddResponse(result);
  }
  grumpkinBatchMul(command) {
    const msgpackCommand = fromGrumpkinBatchMul(command);
    const [variantName, result] = msgpackCall2(this.backend, [["GrumpkinBatchMul", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "GrumpkinBatchMulResponse") {
      throw new BBApiException(`Expected variant name 'GrumpkinBatchMulResponse' but got '${variantName}'`);
    }
    return toGrumpkinBatchMulResponse(result);
  }
  grumpkinGetRandomFr(command) {
    const msgpackCommand = fromGrumpkinGetRandomFr(command);
    const [variantName, result] = msgpackCall2(this.backend, [["GrumpkinGetRandomFr", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "GrumpkinGetRandomFrResponse") {
      throw new BBApiException(`Expected variant name 'GrumpkinGetRandomFrResponse' but got '${variantName}'`);
    }
    return toGrumpkinGetRandomFrResponse(result);
  }
  grumpkinReduce512(command) {
    const msgpackCommand = fromGrumpkinReduce512(command);
    const [variantName, result] = msgpackCall2(this.backend, [["GrumpkinReduce512", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "GrumpkinReduce512Response") {
      throw new BBApiException(`Expected variant name 'GrumpkinReduce512Response' but got '${variantName}'`);
    }
    return toGrumpkinReduce512Response(result);
  }
  secp256k1Mul(command) {
    const msgpackCommand = fromSecp256k1Mul(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Secp256k1Mul", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Secp256k1MulResponse") {
      throw new BBApiException(`Expected variant name 'Secp256k1MulResponse' but got '${variantName}'`);
    }
    return toSecp256k1MulResponse(result);
  }
  secp256k1GetRandomFr(command) {
    const msgpackCommand = fromSecp256k1GetRandomFr(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Secp256k1GetRandomFr", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Secp256k1GetRandomFrResponse") {
      throw new BBApiException(`Expected variant name 'Secp256k1GetRandomFrResponse' but got '${variantName}'`);
    }
    return toSecp256k1GetRandomFrResponse(result);
  }
  secp256k1Reduce512(command) {
    const msgpackCommand = fromSecp256k1Reduce512(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Secp256k1Reduce512", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Secp256k1Reduce512Response") {
      throw new BBApiException(`Expected variant name 'Secp256k1Reduce512Response' but got '${variantName}'`);
    }
    return toSecp256k1Reduce512Response(result);
  }
  bn254FrSqrt(command) {
    const msgpackCommand = fromBn254FrSqrt(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Bn254FrSqrt", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Bn254FrSqrtResponse") {
      throw new BBApiException(`Expected variant name 'Bn254FrSqrtResponse' but got '${variantName}'`);
    }
    return toBn254FrSqrtResponse(result);
  }
  bn254FqSqrt(command) {
    const msgpackCommand = fromBn254FqSqrt(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Bn254FqSqrt", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Bn254FqSqrtResponse") {
      throw new BBApiException(`Expected variant name 'Bn254FqSqrtResponse' but got '${variantName}'`);
    }
    return toBn254FqSqrtResponse(result);
  }
  bn254G1Mul(command) {
    const msgpackCommand = fromBn254G1Mul(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Bn254G1Mul", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Bn254G1MulResponse") {
      throw new BBApiException(`Expected variant name 'Bn254G1MulResponse' but got '${variantName}'`);
    }
    return toBn254G1MulResponse(result);
  }
  bn254G2Mul(command) {
    const msgpackCommand = fromBn254G2Mul(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Bn254G2Mul", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Bn254G2MulResponse") {
      throw new BBApiException(`Expected variant name 'Bn254G2MulResponse' but got '${variantName}'`);
    }
    return toBn254G2MulResponse(result);
  }
  bn254G1IsOnCurve(command) {
    const msgpackCommand = fromBn254G1IsOnCurve(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Bn254G1IsOnCurve", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Bn254G1IsOnCurveResponse") {
      throw new BBApiException(`Expected variant name 'Bn254G1IsOnCurveResponse' but got '${variantName}'`);
    }
    return toBn254G1IsOnCurveResponse(result);
  }
  bn254G1FromCompressed(command) {
    const msgpackCommand = fromBn254G1FromCompressed(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Bn254G1FromCompressed", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "Bn254G1FromCompressedResponse") {
      throw new BBApiException(`Expected variant name 'Bn254G1FromCompressedResponse' but got '${variantName}'`);
    }
    return toBn254G1FromCompressedResponse(result);
  }
  schnorrComputePublicKey(command) {
    const msgpackCommand = fromSchnorrComputePublicKey(command);
    const [variantName, result] = msgpackCall2(this.backend, [["SchnorrComputePublicKey", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "SchnorrComputePublicKeyResponse") {
      throw new BBApiException(`Expected variant name 'SchnorrComputePublicKeyResponse' but got '${variantName}'`);
    }
    return toSchnorrComputePublicKeyResponse(result);
  }
  schnorrConstructSignature(command) {
    const msgpackCommand = fromSchnorrConstructSignature(command);
    const [variantName, result] = msgpackCall2(this.backend, [["SchnorrConstructSignature", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "SchnorrConstructSignatureResponse") {
      throw new BBApiException(`Expected variant name 'SchnorrConstructSignatureResponse' but got '${variantName}'`);
    }
    return toSchnorrConstructSignatureResponse(result);
  }
  schnorrVerifySignature(command) {
    const msgpackCommand = fromSchnorrVerifySignature(command);
    const [variantName, result] = msgpackCall2(this.backend, [["SchnorrVerifySignature", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "SchnorrVerifySignatureResponse") {
      throw new BBApiException(`Expected variant name 'SchnorrVerifySignatureResponse' but got '${variantName}'`);
    }
    return toSchnorrVerifySignatureResponse(result);
  }
  ecdsaSecp256k1ComputePublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256k1ComputePublicKey(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256k1ComputePublicKey", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256k1ComputePublicKeyResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256k1ComputePublicKeyResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256k1ComputePublicKeyResponse(result);
  }
  ecdsaSecp256r1ComputePublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256r1ComputePublicKey(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256r1ComputePublicKey", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256r1ComputePublicKeyResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256r1ComputePublicKeyResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256r1ComputePublicKeyResponse(result);
  }
  ecdsaSecp256k1ConstructSignature(command) {
    const msgpackCommand = fromEcdsaSecp256k1ConstructSignature(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256k1ConstructSignature", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256k1ConstructSignatureResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256k1ConstructSignatureResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256k1ConstructSignatureResponse(result);
  }
  ecdsaSecp256r1ConstructSignature(command) {
    const msgpackCommand = fromEcdsaSecp256r1ConstructSignature(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256r1ConstructSignature", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256r1ConstructSignatureResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256r1ConstructSignatureResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256r1ConstructSignatureResponse(result);
  }
  ecdsaSecp256k1RecoverPublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256k1RecoverPublicKey(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256k1RecoverPublicKey", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256k1RecoverPublicKeyResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256k1RecoverPublicKeyResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256k1RecoverPublicKeyResponse(result);
  }
  ecdsaSecp256r1RecoverPublicKey(command) {
    const msgpackCommand = fromEcdsaSecp256r1RecoverPublicKey(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256r1RecoverPublicKey", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256r1RecoverPublicKeyResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256r1RecoverPublicKeyResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256r1RecoverPublicKeyResponse(result);
  }
  ecdsaSecp256k1VerifySignature(command) {
    const msgpackCommand = fromEcdsaSecp256k1VerifySignature(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256k1VerifySignature", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256k1VerifySignatureResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256k1VerifySignatureResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256k1VerifySignatureResponse(result);
  }
  ecdsaSecp256r1VerifySignature(command) {
    const msgpackCommand = fromEcdsaSecp256r1VerifySignature(command);
    const [variantName, result] = msgpackCall2(this.backend, [["EcdsaSecp256r1VerifySignature", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "EcdsaSecp256r1VerifySignatureResponse") {
      throw new BBApiException(`Expected variant name 'EcdsaSecp256r1VerifySignatureResponse' but got '${variantName}'`);
    }
    return toEcdsaSecp256r1VerifySignatureResponse(result);
  }
  srsInitSrs(command) {
    const msgpackCommand = fromSrsInitSrs(command);
    const [variantName, result] = msgpackCall2(this.backend, [["SrsInitSrs", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "SrsInitSrsResponse") {
      throw new BBApiException(`Expected variant name 'SrsInitSrsResponse' but got '${variantName}'`);
    }
    return toSrsInitSrsResponse(result);
  }
  srsInitGrumpkinSrs(command) {
    const msgpackCommand = fromSrsInitGrumpkinSrs(command);
    const [variantName, result] = msgpackCall2(this.backend, [["SrsInitGrumpkinSrs", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "SrsInitGrumpkinSrsResponse") {
      throw new BBApiException(`Expected variant name 'SrsInitGrumpkinSrsResponse' but got '${variantName}'`);
    }
    return toSrsInitGrumpkinSrsResponse(result);
  }
  shutdown(command) {
    const msgpackCommand = fromShutdown(command);
    const [variantName, result] = msgpackCall2(this.backend, [["Shutdown", msgpackCommand]]);
    if (variantName === "ErrorResponse") {
      throw new BBApiException(result.message || "Unknown error from barretenberg");
    }
    if (variantName !== "ShutdownResponse") {
      throw new BBApiException(`Expected variant name 'ShutdownResponse' but got '${variantName}'`);
    }
    return toShutdownResponse(result);
  }
  destroy() {
    if (this.backend.destroy)
      this.backend.destroy();
  }
};

// node_modules/@aztec/bb.js/dest/browser/bb_backends/index.js
var BackendType;
(function(BackendType2) {
  BackendType2["Wasm"] = "Wasm";
  BackendType2["WasmWorker"] = "WasmWorker";
  BackendType2["NativeUnixSocket"] = "NativeUnixSocket";
  BackendType2["NativeSharedMemory"] = "NativeSharedMemory";
})(BackendType || (BackendType = {}));

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/fetch_code/browser/index.js
async function fetchCode(multithreaded, wasmPath) {
  let url;
  if (wasmPath) {
    const suffix = multithreaded ? "-threads" : "";
    const filePath = wasmPath.split("/").slice(0, -1).join("/");
    const fileNameWithExtensions = wasmPath.split("/").pop();
    const [fileName, ...extensions2] = fileNameWithExtensions.split(".");
    url = `${filePath}/${fileName}${suffix}.${extensions2.join(".")}`;
  } else {
    url = multithreaded ? (await import("./barretenberg-threads-JBPBYYG6.js")).default : (await import("./barretenberg-6FMVJVVX.js")).default;
  }
  const res = await fetch(url);
  const maybeCompressedData = await res.arrayBuffer();
  const buffer = new Uint8Array(maybeCompressedData);
  const isGzip = (
    // Check magic number
    buffer[0] === 31 && buffer[1] === 139 && // Check compression method:
    buffer[2] === 8
  );
  if (isGzip) {
    const decompressedData = pako.ungzip(buffer);
    return decompressedData.buffer;
  } else {
    return buffer;
  }
}

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/index.js
async function fetchModuleAndThreads(desiredThreads = 32, wasmPath, logger = () => {
}) {
  const shared = getSharedMemoryAvailable();
  const availableThreads = shared ? await getAvailableThreads(logger) : 1;
  const limitedThreads = Math.min(desiredThreads, availableThreads, 32);
  logger(`Fetching bb wasm from ${wasmPath ?? "default location"}`);
  const code = await fetchCode(shared, wasmPath);
  logger(`Compiling bb wasm of ${code.byteLength} bytes`);
  const module = await WebAssembly.compile(code);
  logger("Compilation of bb wasm complete");
  return { module, threads: limitedThreads };
}

// node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_main/factory/browser/index.js
async function createMainWorker() {
  const worker = new Worker(new URL("./main.worker.js", import.meta.url), { type: "module" });
  await new Promise((resolve) => readinessListener(worker, resolve));
  return worker;
}

// node_modules/@aztec/bb.js/dest/browser/bb_backends/wasm.js
var BarretenbergWasmSyncBackend = class _BarretenbergWasmSyncBackend {
  wasm;
  constructor(wasm) {
    this.wasm = wasm;
  }
  /**
   * Create and initialize a synchronous WASM backend.
   * @param wasmPath Optional path to WASM files
   * @param logger Optional logging function
   */
  static async new(wasmPath, logger) {
    const wasm = new BarretenbergWasmMain();
    const { module, threads } = await fetchModuleAndThreads(1, wasmPath, logger);
    await wasm.init(module, threads, logger);
    return new _BarretenbergWasmSyncBackend(wasm);
  }
  call(inputBuffer) {
    return this.wasm.cbindCall("bbapi", inputBuffer);
  }
  destroy() {
    void this.wasm.destroy();
  }
};
var BarretenbergWasmAsyncBackend = class _BarretenbergWasmAsyncBackend {
  wasm;
  worker;
  constructor(wasm, worker) {
    this.wasm = wasm;
    this.worker = worker;
  }
  /**
   * Create and initialize an asynchronous WASM backend.
   * @param options.threads Number of threads (defaults to hardware max, up to 32 for parallel proving)
   * @param options.wasmPath Optional path to WASM files
   * @param options.logger Optional logging function
   * @param options.memory Optional initial and maximum memory configuration
   * @param options.useWorker Run on worker thread (default: true for browser safety)
   */
  static async new(options = {}) {
    const useWorker = options.useWorker ?? true;
    if (useWorker) {
      const worker = await createMainWorker();
      const wasm = getRemoteBarretenbergWasm(worker);
      const { module, threads } = await fetchModuleAndThreads(options.threads, options.wasmPath, options.logger);
      await wasm.init(module, threads, proxy(options.logger ?? (() => {
      })), options.memory?.initial, options.memory?.maximum);
      return new _BarretenbergWasmAsyncBackend(wasm, worker);
    } else {
      const wasm = new BarretenbergWasmMain();
      const { module, threads } = await fetchModuleAndThreads(options.threads, options.wasmPath, options.logger);
      await wasm.init(module, threads, options.logger, options.memory?.initial, options.memory?.maximum);
      return new _BarretenbergWasmAsyncBackend(wasm);
    }
  }
  async call(inputBuffer) {
    return this.wasm.cbindCall("bbapi", inputBuffer);
  }
  async destroy() {
    await this.wasm.destroy();
    if (this.worker) {
      await this.worker.terminate();
    }
  }
};

// node_modules/@aztec/bb.js/dest/browser/bb_backends/browser/index.js
async function createAsyncBackend(type, options, logger) {
  switch (type) {
    case BackendType.Wasm:
    case BackendType.WasmWorker: {
      const useWorker = type === BackendType.WasmWorker;
      logger(`Using WASM backend (worker: ${useWorker})`);
      const wasm = await BarretenbergWasmAsyncBackend.new({
        threads: options.threads,
        wasmPath: options.wasmPath,
        logger,
        memory: options.memory,
        useWorker
      });
      return new Barretenberg(wasm, options);
    }
    default:
      throw new Error(`Unknown backend type: ${type}`);
  }
}
async function createSyncBackend(type, options, logger) {
  switch (type) {
    case BackendType.Wasm:
      logger("Using WASM backend");
      const wasm = await BarretenbergWasmSyncBackend.new(options.wasmPath, logger);
      return new BarretenbergSync(wasm);
    default:
      throw new Error(`Backend ${type} not supported for BarretenbergSync`);
  }
}

// node_modules/@aztec/bb.js/dest/browser/proof/index.js
var fieldByteSize = 32;
function splitHonkProof(proofWithPublicInputs, numPublicInputs) {
  const publicInputs = proofWithPublicInputs.slice(0, numPublicInputs * fieldByteSize);
  const proof = proofWithPublicInputs.slice(numPublicInputs * fieldByteSize);
  return {
    proof,
    publicInputs
  };
}
function reconstructHonkProof(publicInputs, proof) {
  const proofWithPublicInputs = Uint8Array.from([...publicInputs, ...proof]);
  return proofWithPublicInputs;
}
function deflattenFields(flattenedFields) {
  const publicInputSize = 32;
  const chunkedFlattenedPublicInputs = [];
  for (let i = 0; i < flattenedFields.length; i += publicInputSize) {
    const publicInput = flattenedFields.slice(i, i + publicInputSize);
    chunkedFlattenedPublicInputs.push(publicInput);
  }
  return chunkedFlattenedPublicInputs.map(uint8ArrayToHex);
}
function uint8ArrayToHex(buffer) {
  const hex = [];
  buffer.forEach(function(i) {
    let h = i.toString(16);
    if (h.length % 2) {
      h = "0" + h;
    }
    hex.push(h);
  });
  return "0x" + hex.join("");
}
function hexToUint8Array(hex) {
  const sanitizedHex = BigInt(hex).toString(16).padStart(64, "0");
  const len = sanitizedHex.length / 2;
  const u8 = new Uint8Array(len);
  let i = 0;
  let j = 0;
  while (i < len) {
    u8[i] = parseInt(sanitizedHex.slice(j, j + 2), 16);
    i += 1;
    j += 2;
  }
  return u8;
}

// node_modules/@aztec/bb.js/dest/browser/barretenberg/backend.js
var AztecClientBackendError = class extends Error {
  constructor(message) {
    super(message);
  }
};
function getProofSettingsFromOptions(options) {
  if (options?.verifierTarget) {
    const legacyOptions = [options.keccak, options.keccakZK, options.starknet, options.starknetZK].filter(Boolean);
    if (legacyOptions.length > 0) {
      throw new Error("Cannot use verifierTarget with legacy options (keccak, keccakZK, starknet, starknetZK). Use verifierTarget alone.");
    }
    switch (options.verifierTarget) {
      case "evm":
        return { ipaAccumulation: false, oracleHashType: "keccak", disableZk: false, optimizedSolidityVerifier: false };
      case "evm-no-zk":
        return { ipaAccumulation: false, oracleHashType: "keccak", disableZk: true, optimizedSolidityVerifier: false };
      case "noir-recursive":
        return {
          ipaAccumulation: false,
          oracleHashType: "poseidon2",
          disableZk: false,
          optimizedSolidityVerifier: false
        };
      case "noir-recursive-no-zk":
        return {
          ipaAccumulation: false,
          oracleHashType: "poseidon2",
          disableZk: true,
          optimizedSolidityVerifier: false
        };
      case "noir-rollup":
        return {
          ipaAccumulation: true,
          oracleHashType: "poseidon2",
          disableZk: false,
          optimizedSolidityVerifier: false
        };
      case "noir-rollup-no-zk":
        return {
          ipaAccumulation: true,
          oracleHashType: "poseidon2",
          disableZk: true,
          optimizedSolidityVerifier: false
        };
      case "starknet":
        return {
          ipaAccumulation: false,
          oracleHashType: "starknet",
          disableZk: false,
          optimizedSolidityVerifier: false
        };
      case "starknet-no-zk":
        return {
          ipaAccumulation: false,
          oracleHashType: "starknet",
          disableZk: true,
          optimizedSolidityVerifier: false
        };
    }
  }
  return {
    ipaAccumulation: false,
    oracleHashType: options?.keccak || options?.keccakZK ? "keccak" : options?.starknet || options?.starknetZK ? "starknet" : "poseidon2",
    disableZk: options?.keccak || options?.starknet ? true : false,
    optimizedSolidityVerifier: false
  };
}
var UltraHonkVerifierBackend = class {
  api;
  constructor(api) {
    this.api = api;
  }
  async verifyProof(proofData, options) {
    const proofFrs = [];
    for (let i = 0; i < proofData.proof.length; i += 32) {
      proofFrs.push(proofData.proof.slice(i, i + 32));
    }
    const { verified } = await this.api.circuitVerify({
      verificationKey: proofData.verificationKey,
      publicInputs: proofData.publicInputs.map(hexToUint8Array),
      proof: proofFrs,
      settings: getProofSettingsFromOptions(options)
    });
    return verified;
  }
};
var UltraHonkBackend = class {
  api;
  // These type assertions are used so that we don't
  // have to initialize `api` in the constructor.
  // These are initialized asynchronously in the `init` function,
  // constructors cannot be asynchronous which is why we do this.
  acirUncompressedBytecode;
  constructor(acirBytecode, api) {
    this.api = api;
    this.acirUncompressedBytecode = acirToUint8Array(acirBytecode);
  }
  async generateProof(compressedWitness, options) {
    const witness = ungzip_1(compressedWitness);
    const { proof, publicInputs } = await this.api.circuitProve({
      witness,
      circuit: {
        name: "circuit",
        bytecode: this.acirUncompressedBytecode,
        verificationKey: new Uint8Array(0)
        // Empty VK - lower performance.
      },
      settings: getProofSettingsFromOptions(options)
    });
    console.log(`Generated proof for circuit with ${publicInputs.length} public inputs and ${proof.length} fields.`);
    const flatProof = new Uint8Array(proof.length * 32);
    proof.forEach((fr, i) => {
      flatProof.set(fr, i * 32);
    });
    return { proof: flatProof, publicInputs: publicInputs.map(uint8ArrayToHex) };
  }
  async verifyProof(proofData, options) {
    const proofFrs = [];
    for (let i = 0; i < proofData.proof.length; i += 32) {
      proofFrs.push(proofData.proof.slice(i, i + 32));
    }
    const vkResult = await this.api.circuitComputeVk({
      circuit: {
        name: "circuit",
        bytecode: this.acirUncompressedBytecode
      },
      settings: getProofSettingsFromOptions(options)
    });
    const { verified } = await this.api.circuitVerify({
      verificationKey: vkResult.bytes,
      publicInputs: proofData.publicInputs.map(hexToUint8Array),
      proof: proofFrs,
      settings: getProofSettingsFromOptions(options)
    });
    return verified;
  }
  async getVerificationKey(options) {
    const vkResult = await this.api.circuitComputeVk({
      circuit: {
        name: "circuit",
        bytecode: this.acirUncompressedBytecode
      },
      settings: getProofSettingsFromOptions(options)
    });
    return vkResult.bytes;
  }
  /** @description Returns a solidity verifier */
  async getSolidityVerifier(vk, options) {
    const result = await this.api.circuitWriteSolidityVerifier({
      verificationKey: vk,
      settings: getProofSettingsFromOptions(options)
    });
    return result.solidityCode;
  }
  // TODO(https://github.com/noir-lang/noir/issues/5661): Update this to handle Honk recursive aggregation in the browser once it is ready in the backend itself
  async generateRecursiveProofArtifacts(_proof, _numOfPublicInputs, options) {
    const vkResult = await this.api.circuitComputeVk({
      circuit: {
        name: "circuit",
        bytecode: this.acirUncompressedBytecode
      },
      settings: getProofSettingsFromOptions(options)
    });
    const vkAsFields = [];
    for (let i = 0; i < vkResult.bytes.length; i += 32) {
      const chunk = vkResult.bytes.slice(i, i + 32);
      vkAsFields.push(uint8ArrayToHex(chunk));
    }
    return {
      // TODO(https://github.com/noir-lang/noir/issues/5661)
      proofAsFields: [],
      vkAsFields,
      // We use an empty string for the vk hash here as it is unneeded as part of the recursive artifacts
      // The user can be expected to hash the vk inside their circuit to check whether the vk is the circuit
      // they expect
      vkHash: uint8ArrayToHex(vkResult.hash)
    };
  }
};
var AztecClientBackend = class {
  acirBuf;
  api;
  circuitNames;
  // These type assertions are used so that we don't
  // have to initialize `api` in the constructor.
  // These are initialized asynchronously in the `init` function,
  // constructors cannot be asynchronous which is why we do this.
  constructor(acirBuf, api, circuitNames = []) {
    this.acirBuf = acirBuf;
    this.api = api;
    this.circuitNames = circuitNames;
  }
  async prove(witnessBuf, vksBuf = []) {
    if (vksBuf.length !== 0 && this.acirBuf.length !== witnessBuf.length) {
      throw new AztecClientBackendError("Witness and bytecodes must have the same stack depth!");
    }
    if (vksBuf.length !== 0 && vksBuf.length !== witnessBuf.length) {
      throw new AztecClientBackendError("Witness and VKs must have the same stack depth!");
    }
    this.api.chonkStart({ numCircuits: this.acirBuf.length });
    for (let i = 0; i < this.acirBuf.length; i++) {
      const bytecode = this.acirBuf[i];
      const witness = witnessBuf[i] || new Uint8Array(0);
      const vk = vksBuf[i] || new Uint8Array(0);
      const functionName = this.circuitNames[i] || `circuit_${i}`;
      this.api.chonkLoad({
        circuit: {
          name: functionName,
          bytecode,
          verificationKey: vk
        }
      });
      this.api.chonkAccumulate({
        witness
      });
    }
    const proveResult = await this.api.chonkProve({});
    const proof = new Encoder({ useRecords: false }).encode(fromChonkProof(proveResult.proof));
    const lastIdx = this.acirBuf.length - 1;
    const vkResult = await this.api.chonkComputeVk({
      circuit: {
        name: this.circuitNames[lastIdx] || "circuit",
        bytecode: this.acirBuf[lastIdx]
      }
    });
    const proofFields = [
      proveResult.proof.megaProof,
      proveResult.proof.goblinProof.mergeProof,
      proveResult.proof.goblinProof.eccvmProof,
      proveResult.proof.goblinProof.ipaProof,
      proveResult.proof.goblinProof.translatorProof
    ].flat();
    if (!await this.verifyNative(proveResult.proof, vkResult.bytes)) {
      throw new AztecClientBackendError("Failed to verify the private (Chonk) transaction proof!");
    }
    return [proofFields, proof, vkResult.bytes];
  }
  async verify(proof, vk) {
    const result = await this.api.chonkVerify({
      proof: toChonkProof(new Decoder({ useRecords: false }).decode(proof)),
      vk
    });
    return result.valid;
  }
  /**
   * Internal verification using native ChonkProof type.
   * Avoids encode/decode cycle when called from prove().
   */
  async verifyNative(proof, vk) {
    const result = await this.api.chonkVerify({
      proof,
      vk
    });
    return result.valid;
  }
  async gates() {
    const circuitSizes = [];
    for (let i = 0; i < this.acirBuf.length; i++) {
      const gates = await this.api.chonkStats({
        circuit: {
          name: this.circuitNames[i] || `circuit_${i}`,
          bytecode: this.acirBuf[i]
        },
        includeGatesPerOpcode: false
      });
      circuitSizes.push(gates.circuitSize);
    }
    return circuitSizes;
  }
};
function acirToUint8Array(base64EncodedBytecode) {
  const compressedByteCode = base64Decode(base64EncodedBytecode);
  return ungzip_1(compressedByteCode);
}
function base64Decode(input) {
  if (typeof atob === "function") {
    return Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
  } else {
    throw new Error("atob is not available. Node.js 18+ or browser required.");
  }
}
function fieldToString(field, radix = 10) {
  let result = 0n;
  for (const byte of field) {
    result <<= 8n;
    result += BigInt(byte);
  }
  return result.toString(radix);
}
function fieldsToStrings(fields, radix = 10) {
  return fields.map((field) => fieldToString(field, radix));
}

// node_modules/@aztec/bb.js/dest/browser/barretenberg/index.js
var Barretenberg = class _Barretenberg extends AsyncApi {
  options;
  constructor(backend, options) {
    super(backend);
    this.options = options;
  }
  /**
   * Constructs an instance of Barretenberg.
   *
   * If options.backend is set: uses that specific backend (throws if unavailable)
   * If options.backend is unset: tries backends in order with fallback:
   *   1. NativeUnixSocket (if bb binary available)
   *   2. WasmWorker (in browser) or Wasm (in Node.js)
   */
  static async new(options = {}) {
    const logger = options.logger ?? (() => {
    });
    if (options.backend) {
      const backend = await createAsyncBackend(options.backend, options, logger);
      if (options.backend === BackendType.Wasm || options.backend === BackendType.WasmWorker) {
        await backend.initSRSChonk();
      }
      return backend;
    }
    if (typeof window === "undefined") {
      try {
        return await createAsyncBackend(BackendType.NativeUnixSocket, options, logger);
      } catch (err) {
        logger(`Unix socket unavailable (${err.message}), falling back to WASM`);
        const backend = await createAsyncBackend(BackendType.Wasm, options, logger);
        await backend.initSRSChonk();
        return backend;
      }
    } else {
      logger(`In browser, using WASM over worker backend.`);
      const backend = await createAsyncBackend(BackendType.WasmWorker, options, logger);
      await backend.initSRSChonk();
      return backend;
    }
  }
  async initSRSChonk(srsSize = this.getDefaultSrsSize()) {
    const crs = await CachedNetCrs.new(srsSize + 1, this.options.crsPath, this.options.logger);
    const grumpkinCrs = await CachedNetGrumpkinCrs.new(2 ** 16 + 1, this.options.crsPath, this.options.logger);
    await this.srsInitSrs({ pointsBuf: crs.getG1Data(), numPoints: crs.numPoints, g2Point: crs.getG2Data() });
    await this.srsInitGrumpkinSrs({ pointsBuf: grumpkinCrs.getG1Data(), numPoints: grumpkinCrs.numPoints });
  }
  getDefaultSrsSize() {
    if (typeof self !== "undefined" && typeof self.navigator !== "undefined" && /iPad|iPhone/.test(self.navigator.userAgent)) {
      return 2 ** 18;
    }
    return 2 ** 20;
  }
  async acirGetCircuitSizes(bytecode, recursive, honkRecursion) {
    const response = await this.circuitStats({
      circuit: { name: "", bytecode, verificationKey: new Uint8Array() },
      includeGatesPerOpcode: false,
      settings: {
        ipaAccumulation: false,
        oracleHashType: honkRecursion ? "poseidon2" : "keccak",
        disableZk: !recursive,
        optimizedSolidityVerifier: false
      }
    });
    return [response.numGates, response.numGatesDyadic];
  }
  async destroy() {
    return super.destroy();
  }
  /**
   * Initialize the singleton instance of Barretenberg.
   * @param options Backend configuration options
   */
  static async initSingleton(options = {}) {
    if (!barretenbergSingletonPromise) {
      barretenbergSingletonPromise = _Barretenberg.new(options);
    }
    try {
      barretenbergSingleton = await barretenbergSingletonPromise;
      return barretenbergSingleton;
    } catch (error) {
      barretenbergSingleton = void 0;
      barretenbergSingletonPromise = void 0;
      throw error;
    }
  }
  static async destroySingleton() {
    if (barretenbergSingleton) {
      await barretenbergSingleton.destroy();
      barretenbergSingleton = void 0;
      barretenbergSingletonPromise = void 0;
    }
  }
  /**
   * Get the singleton instance of Barretenberg.
   * Must call initSingleton() first.
   */
  static getSingleton() {
    if (!barretenbergSingleton) {
      throw new Error("First call Barretenberg.initSingleton() on @aztec/bb.js module.");
    }
    return barretenbergSingleton;
  }
};
var barretenbergSingletonPromise;
var barretenbergSingleton;
var barretenbergSyncSingletonPromise;
var barretenbergSyncSingleton;
var BarretenbergSync = class _BarretenbergSync extends SyncApi {
  constructor(backend) {
    super(backend);
  }
  /**
   * Create a new BarretenbergSync instance.
   *
   * If options.backend is set: uses that specific backend (throws if unavailable)
   * If options.backend is unset: tries backends in order with fallback:
   *   1. NativeSharedMem (if bb binary + NAPI module available)
   *   2. Wasm
   *
   * Supported backends: Wasm, NativeSharedMem
   * Not supported: WasmWorker (no workers in sync), NativeUnixSocket (async only)
   */
  static async new(options = {}) {
    const logger = options.logger ?? (() => {
    });
    if (options.backend) {
      return await createSyncBackend(options.backend, options, logger);
    }
    try {
      return await createSyncBackend(BackendType.NativeSharedMemory, options, logger);
    } catch (err) {
      logger(`Shared memory unavailable (${err.message}), falling back to WASM`);
    }
    return await createSyncBackend(BackendType.Wasm, options, logger);
  }
  /**
   * Initialize the singleton instance.
   * @param options Backend configuration options
   */
  static async initSingleton(options = {}) {
    if (!barretenbergSyncSingletonPromise) {
      barretenbergSyncSingletonPromise = _BarretenbergSync.new(options);
    }
    barretenbergSyncSingleton = await barretenbergSyncSingletonPromise;
    return barretenbergSyncSingleton;
  }
  static destroySingleton() {
    if (barretenbergSyncSingleton) {
      barretenbergSyncSingleton.destroy();
      barretenbergSyncSingleton = void 0;
      barretenbergSyncSingletonPromise = void 0;
    }
  }
  static getSingleton() {
    if (!barretenbergSyncSingleton) {
      throw new Error("First call BarretenbergSync.initSingleton() on @aztec/bb.js module.");
    }
    return barretenbergSyncSingleton;
  }
};

// node_modules/@aztec/bb.js/dest/browser/cbind/generated/curve_constants.js
var BN254_FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
var BN254_FQ_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
var BN254_G1_GENERATOR = {
  x: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  y: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2])
};
var BN254_G2_GENERATOR = {
  x: [new Uint8Array([24, 0, 222, 239, 18, 31, 30, 118, 66, 106, 0, 102, 94, 92, 68, 121, 103, 67, 34, 212, 247, 94, 218, 221, 70, 222, 189, 92, 217, 146, 246, 237]), new Uint8Array([25, 142, 147, 147, 146, 13, 72, 58, 114, 96, 191, 183, 49, 251, 93, 37, 241, 170, 73, 51, 53, 169, 231, 18, 151, 228, 133, 183, 174, 243, 18, 194])],
  y: [new Uint8Array([18, 200, 94, 165, 219, 140, 109, 235, 74, 171, 113, 128, 141, 203, 64, 143, 227, 209, 231, 105, 12, 67, 211, 123, 76, 230, 204, 1, 102, 250, 125, 170]), new Uint8Array([9, 6, 137, 208, 88, 95, 240, 117, 236, 158, 153, 173, 105, 12, 51, 149, 188, 75, 49, 51, 112, 179, 142, 243, 85, 172, 218, 220, 209, 34, 151, 91])]
};
var GRUMPKIN_FR_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
var GRUMPKIN_FQ_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
var GRUMPKIN_G1_GENERATOR = {
  x: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  y: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 2, 207, 19, 94, 117, 6, 164, 93, 99, 45, 39, 13, 69, 241, 24, 18, 148, 131, 63, 196, 141, 130, 63, 39, 44])
};
var SECP256K1_FR_MODULUS = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
var SECP256K1_FQ_MODULUS = 115792089237316195423570985008687907853269984665640564039457584007908834671663n;
var SECP256K1_G1_GENERATOR = {
  x: new Uint8Array([121, 190, 102, 126, 249, 220, 187, 172, 85, 160, 98, 149, 206, 135, 11, 7, 2, 155, 252, 219, 45, 206, 40, 217, 89, 242, 129, 91, 22, 248, 23, 152]),
  y: new Uint8Array([72, 58, 218, 119, 38, 163, 196, 101, 93, 164, 251, 252, 14, 17, 8, 168, 253, 23, 180, 72, 166, 133, 84, 25, 156, 71, 208, 143, 251, 16, 212, 184])
};
var SECP256R1_FR_MODULUS = 115792089210356248762697446949407573529996955224135760342422259061068512044369n;
var SECP256R1_FQ_MODULUS = 115792089210356248762697446949407573530086143415290314195533631308867097853951n;
var SECP256R1_G1_GENERATOR = {
  x: new Uint8Array([107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150]),
  y: new Uint8Array([79, 227, 66, 226, 254, 26, 127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182, 64, 104, 55, 191, 81, 245])
};

// node_modules/@aztec/bb.js/dest/browser/bb_backends/browser/platform.js
function findBbBinary(customPath) {
  throw new Error("Not implemented in browser environment.");
}
function findNapiBinary(customPath) {
  throw new Error("Not implemented in browser environment.");
}
export {
  AztecClientBackend,
  BBApiException,
  BN254_FQ_MODULUS,
  BN254_FR_MODULUS,
  BN254_G1_GENERATOR,
  BN254_G2_GENERATOR,
  BackendType,
  Barretenberg,
  BarretenbergSync,
  CachedNetCrs as Crs,
  GRUMPKIN_FQ_MODULUS,
  GRUMPKIN_FR_MODULUS,
  GRUMPKIN_G1_GENERATOR,
  CachedNetGrumpkinCrs as GrumpkinCrs,
  SECP256K1_FQ_MODULUS,
  SECP256K1_FR_MODULUS,
  SECP256K1_G1_GENERATOR,
  SECP256R1_FQ_MODULUS,
  SECP256R1_FR_MODULUS,
  SECP256R1_G1_GENERATOR,
  UltraHonkBackend,
  UltraHonkVerifierBackend,
  deflattenFields,
  fieldToString,
  fieldsToStrings,
  findBbBinary,
  findNapiBinary,
  randomBytes,
  reconstructHonkProof,
  splitHonkProof,
  toChonkProof
};
