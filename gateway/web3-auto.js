// ERC-6860 auto mode: translate `/<method>/<arg>/…?<query>` into a standard ABI call and decode what
// comes back. The Worker has no runtime dependencies, so keccak-256 (for function selectors) and the
// small ABI codec needed here are implemented inline.

export class AutoModeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// --- keccak-256 ---------------------------------------------------------------
// Keccak-f[1600] over 64-bit BigInt lanes. Selectors hash a few dozen bytes, so clarity wins over speed.
const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets indexed by lane x + 5y.
const ROTATIONS = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];
const rotl64 = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK64);

function keccakF(s) {
  for (const rc of ROUND_CONSTANTS) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], ROTATIONS[x + 5 * y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 25; y += 5) {
        s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y]);
      }
    }
    s[0] ^= rc;
  }
}

export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((s[i] >> BigInt(8 * k)) & 0xffn);
  }
  return out;
}

// --- helpers ------------------------------------------------------------------
const utf8 = (s) => new TextEncoder().encode(s);
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const pad32 = (h) => h.padStart(64, '0');
// Table lookup rather than parseInt per byte: web3:// bodies reach megabytes, and on the 1.3 MB
// privacypools.gwei page this is several times faster, which matters under the Worker CPU limit.
const HEX_VALUES = new Uint8Array(128);
for (let i = 0; i < 10; i++) HEX_VALUES[48 + i] = i;
for (let i = 0; i < 6; i++) HEX_VALUES[65 + i] = HEX_VALUES[97 + i] = 10 + i;
export function hexToBytes(h) {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0, j = 0; i < out.length; i++, j += 2) {
    out[i] = (HEX_VALUES[h.charCodeAt(j)] << 4) | HEX_VALUES[h.charCodeAt(j + 1)];
  }
  return out;
}
function tail(bytes) {
  let data = toHex(bytes);
  while (data.length % 64) data += '0';
  return pad32(bytes.length.toString(16)) + data;
}

// Canonical type name for a base type, or null. `uint`/`int` are aliases for the 256-bit types.
function baseType(name) {
  if (name === 'bool' || name === 'address' || name === 'string' || name === 'bytes') return { kind: name };
  let m = /^(u?int)(\d*)$/.exec(name);
  if (m) {
    const bits = m[2] ? Number(m[2]) : 256;
    if (bits < 8 || bits > 256 || bits % 8 || (m[2] && m[2][0] === '0')) return null;
    return { kind: m[1], bits };
  }
  m = /^bytes([1-9]\d?)$/.exec(name);
  if (m && Number(m[1]) <= 32) return { kind: 'bytes', size: Number(m[1]) };
  return null;
}
const typeName = (t) => (t.bits ? `${t.kind}${t.bits}` : t.size ? `bytes${t.size}` : t.kind);

// --- call encoding ------------------------------------------------------------
const METHOD = /^[A-Za-z$_][A-Za-z0-9$_]*$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

// Type an argument from its explicit `type!` prefix, or detect it in the order ERC-6860 lists.
function typeArgument(raw) {
  const prefixed = /^([a-z]+\d*)!/.exec(raw);
  if (prefixed) {
    const type = baseType(prefixed[1]);
    if (!type) throw new AutoModeError(`Unsupported argument type "${prefixed[1]}".`);
    return { type, value: raw.slice(prefixed[0].length) };
  }
  if (/^\d+$/.test(raw)) return { type: { kind: 'uint', bits: 256 }, value: raw };
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return { type: { kind: 'bytes', size: 32 }, value: raw };
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return { type: { kind: 'address' }, value: raw };
  if (HEX_BYTES.test(raw)) return { type: { kind: 'bytes' }, value: raw };
  if (raw === 'true' || raw === 'false') return { type: { kind: 'bool' }, value: raw };
  return { type: { kind: 'address' }, value: raw }; // a domain name; rejected when encoded
}

function encodeArgument({ type, value }) {
  const invalid = () => new AutoModeError(`Invalid ${typeName(type)} argument "${value}".`);
  switch (type.kind) {
    case 'uint': {
      if (!/^\d+$/.test(value)) throw invalid();
      const n = BigInt(value);
      if (n >= 1n << BigInt(type.bits)) throw invalid();
      return { head: pad32(n.toString(16)) };
    }
    case 'int': {
      if (!/^-?\d+$/.test(value)) throw invalid();
      const n = BigInt(value);
      const limit = 1n << BigInt(type.bits - 1);
      if (n >= limit || n < -limit) throw invalid();
      return { head: pad32((n < 0n ? (1n << 256n) + n : n).toString(16)) };
    }
    case 'bool':
      if (value !== 'true' && value !== 'false') throw invalid();
      return { head: pad32(value === 'true' ? '1' : '0') };
    case 'address':
      if (/^0x[0-9a-fA-F]{40}$/.test(value)) return { head: pad32(value.slice(2).toLowerCase()) };
      throw new AutoModeError(`Name-service arguments such as "${value}" are not supported; use a 0x address.`);
    case 'bytes':
      if (type.size) {
        if (!new RegExp(`^0x[0-9a-fA-F]{${type.size * 2}}$`).test(value)) throw invalid();
        return { head: value.slice(2).toLowerCase().padEnd(64, '0') };
      }
      if (!HEX_BYTES.test(value)) throw invalid();
      return { tail: tail(hexToBytes(value.slice(2))) };
    case 'string':
      return { tail: tail(utf8(value)) };
  }
  throw invalid();
}

// Returns { data, root, lastArg } for a request path. The root (`/` or empty) is a call with empty
// calldata. A path whose first segment can't be a method (`/favicon.ico`) is a 404, not a call.
export function encodeAutoCall(pathname) {
  const segments = (pathname || '/').split('/').slice(1);
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    return { data: '0x', root: true, lastArg: null };
  }
  let decoded;
  try {
    decoded = segments.map(decodeURIComponent);
  } catch (_) {
    throw new AutoModeError('Malformed percent-encoding in the URL path.');
  }
  const [method, ...rawArgs] = decoded;
  if (!METHOD.test(method)) throw new AutoModeError('This contract has no page here.', 404);

  const args = rawArgs.map(typeArgument);
  const parts = args.map(encodeArgument);
  const signature = `${method}(${args.map((a) => typeName(a.type)).join(',')})`;
  const selector = toHex(keccak256(utf8(signature)).subarray(0, 4));
  let cursor = parts.length * 32;
  const head = parts.map((p) => {
    if (p.head) return p.head;
    const offset = pad32(cursor.toString(16));
    cursor += p.tail.length / 2;
    return offset;
  });
  const tails = parts.map((p) => p.tail || '');
  return { data: '0x' + selector + head.join('') + tails.join(''), root: false, lastArg: args[args.length - 1] || null };
}

// --- query --------------------------------------------------------------------
// ERC-6860 `returns`/`returnTypes` and ERC-7087 `mime.*` attributes; the last of each kind wins. Values
// are percent-decoded without treating `+` as a space, since `+` is meaningful in a MIME type.
export function parseAutoQuery(search) {
  let returns;
  let mime = null;
  for (const part of (search || '').replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = eq === -1 ? part : part.slice(0, eq);
    let value = eq === -1 ? '' : part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch (_) {
      throw new AutoModeError('Malformed percent-encoding in the URL query.');
    }
    if (name === 'returns' || name === 'returnTypes') returns = value;
    else if (name === 'mime.content') mime = { content: value };
    else if (name === 'mime.type') mime = { type: value };
    else if (name === 'mime.dataurl') mime = { dataurl: true };
  }
  return { returns: returns || undefined, mime };
}

// --- return decoding ----------------------------------------------------------
function parseReturnTypes(spec) {
  let i = 0;
  const fail = () => {
    throw new AutoModeError(`Unsupported returns attribute "${spec}".`);
  };
  const parseType = () => {
    let type;
    if (spec[i] === '(') {
      i++;
      const items = [];
      if (spec[i] !== ')') {
        for (;;) {
          items.push(parseType());
          if (spec[i] !== ',') break;
          i++;
        }
      }
      if (spec[i++] !== ')') fail();
      type = { tuple: items };
    } else {
      const m = /^[a-z]+\d*/.exec(spec.slice(i));
      if (!m) fail();
      i += m[0].length;
      type = baseType(m[0]) || fail();
    }
    while (spec[i] === '[') {
      const m = /^\[([1-9]\d*)?\]/.exec(spec.slice(i));
      if (!m) fail();
      i += m[0].length;
      type = { array: type, length: m[1] ? Number(m[1]) : null };
    }
    return type;
  };
  if (spec[0] !== '(') fail();
  const top = parseType();
  if (i !== spec.length || !top.tuple) fail();
  return top.tuple;
}

const isDynamic = (t) =>
  t.kind === 'string' || (t.kind === 'bytes' && !t.size) ||
  (t.array ? t.length === null || isDynamic(t.array) : false) ||
  (t.tuple ? t.tuple.some(isDynamic) : false);
const headWords = (t) =>
  isDynamic(t) ? 1 : t.array ? t.length * headWords(t.array) : t.tuple ? t.tuple.reduce((n, x) => n + headWords(x), 0) : 1;

function decodeReturn(types, hex) {
  const words = hex.length / 64;
  const malformed = () => new AutoModeError('This contract returned data that does not match the returns types.', 502);
  // Offsets let many array elements point at the same string. Without them every decoded byte and
  // element occupies its own place in the response, so the response size is the output budget.
  let budget = hex.length / 2;
  const spend = (units) => {
    budget -= units;
    if (budget < 0) throw new AutoModeError('The decoded return data is too large.', 502);
  };
  const readWord = (at) => {
    if (at % 32 || at / 32 + 1 > words) throw malformed();
    return BigInt('0x' + hex.slice(at * 2, at * 2 + 64));
  };
  // Lengths and offsets can't exceed the data, which also bounds any array allocation below.
  const readSize = (at) => {
    const n = readWord(at);
    if (n > BigInt(hex.length / 2)) throw malformed();
    return Number(n);
  };
  const decodeTuple = (list, base) => {
    let at = base;
    return list.map((t) => {
      if (isDynamic(t)) {
        const value = decodeAt(t, base + readSize(at));
        at += 32;
        return value;
      }
      const value = decodeAt(t, at);
      at += 32 * headWords(t);
      return value;
    });
  };
  // Every element occupies at least its head words, so an array can't claim more elements than fit.
  const elements = (t, length, at) => {
    if ((at + length * 32 * headWords(t.array)) * 2 > hex.length) throw malformed();
    spend(length);
    return new Array(length).fill(t.array);
  };
  const decodeAt = (t, at) => {
    if (t.tuple) return decodeTuple(t.tuple, at);
    if (t.array) {
      if (t.length !== null) return decodeTuple(elements(t, t.length, at), at);
      const length = readSize(at);
      return decodeTuple(elements(t, length, at + 32), at + 32);
    }
    if (t.kind === 'string' || (t.kind === 'bytes' && !t.size)) {
      const length = readSize(at);
      if ((at + 32 + length) * 2 > hex.length) throw malformed();
      spend(length);
      const data = hex.slice((at + 32) * 2, (at + 32 + length) * 2);
      if (t.kind === 'bytes') return '0x' + data;
      return new TextDecoder().decode(hexToBytes(data));
    }
    const w = readWord(at);
    if (t.kind === 'uint') return '0x' + w.toString(16);
    if (t.kind === 'int') {
      const v = w >= 1n << 255n ? w - (1n << 256n) : w;
      return v < 0n ? '-0x' + (-v).toString(16) : '0x' + v.toString(16);
    }
    if (t.kind === 'bool') return w !== 0n;
    if (t.kind === 'address') return '0x' + hex.slice(at * 2 + 24, at * 2 + 64);
    return '0x' + hex.slice(at * 2, at * 2 + t.size * 2); // bytes1..32
  };
  return decodeTuple(types, 0);
}

// JSON body for a `returns` attribute: `()` is the raw return data, anything else is ABI-decoded
// with quantities as compact hex, as in the Ethereum JSON-RPC encoding.
export function encodeAutoReturn(resultHex, returns) {
  const hex = (resultHex || '0x').slice(2);
  if (returns === '()') return JSON.stringify(['0x' + hex]);
  if (returns.length > 256) throw new AutoModeError('The returns attribute is too long.');
  const types = parseReturnTypes(returns);
  if (hex.length % 64) throw new AutoModeError('This contract returned data that does not match the returns types.', 502);
  return JSON.stringify(decodeReturn(types, hex));
}

// --- ERC-7087 -----------------------------------------------------------------
const MIME_TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
const MIME_TYPE = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}(?:\\s*;\\s*${MIME_TOKEN}=(?:${MIME_TOKEN}|"[^"\\\\\\r\\n]*"))*$`);
export const isMimeType = (value) => MIME_TYPE.test(value || '');

// RFC 2397 `data:[<mediatype>][;base64],<data>`. Returns { contentType, body } or null.
export function parseDataUrl(bytes) {
  const text = new TextDecoder().decode(bytes);
  const m = /^data:([^,]*),/.exec(text);
  if (!m) return null;
  let meta = m[1];
  const base64 = /;base64$/i.test(meta);
  if (base64) meta = meta.slice(0, -7);
  const contentType = meta ? (meta.startsWith(';') ? `text/plain${meta}` : meta) : 'text/plain;charset=US-ASCII';
  if (!isMimeType(contentType)) return null;
  const payload = text.slice(m[0].length);
  if (base64) {
    try {
      return { contentType, body: Uint8Array.from(atob(payload.replace(/\s+/g, '')), (c) => c.charCodeAt(0)) };
    } catch (_) {
      return null;
    }
  }
  const out = [];
  for (const token of payload.split(/(%[0-9a-fA-F]{2})/)) {
    if (/^%[0-9a-fA-F]{2}$/.test(token)) out.push(parseInt(token.slice(1), 16));
    else if (token) out.push(...utf8(token));
  }
  return { contentType, body: Uint8Array.from(out) };
}
