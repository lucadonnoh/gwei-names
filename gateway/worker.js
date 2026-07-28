// gwei.domains gateway — a Cloudflare Worker that turns `<name>.gwei.domains` into the website
// stored at that name's on-chain records.
//
// For each request it: reads the label from the Host, asks the NameNFT contract for the name's
// contenthash, decodes it (IPFS, IPNS, or Swarm), and reverse-proxies the content from a public gateway.
// If no contenthash is set, it falls back to the ERC-6821 `contentcontract` text record and serves the
// site straight out of a smart contract over web3:// (ERC-6860), with no storage network in the middle.
// Resolved name→content-reference lookups and fetched content are cached at the edge (Cloudflare Cache API);
// every proxied response is hardened with security headers.
//
// Deploy on a `*.gwei.domains/*` route (see gateway/README.md).

const NAMENFT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6'; // GNS NameNFT (mainnet; same address on Sepolia)
// Public RPCs that reliably serve eth_call under load. (llamarpc/1rpc proved flaky from the Worker.)
// For scale, set a dedicated endpoint as a secret — `wrangler secret put RPC_URL` — it's tried first.
const RPCS = [
  'https://0xrpc.io/eth',
  'https://gateway.tenderly.co/public/mainnet',
  'https://ethereum-rpc.publicnode.com',
];
// Chains a `contentcontract` record may point at, keyed by chain id, with their ERC-3770 short names.
// Names themselves always resolve on mainnet (that's where the record lives); only the web3:// contract
// call goes to the chain named in the record. Adding a chain is a single entry here.
const SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
];
const CHAINS = {
  1: { short: 'eth', rpcs: RPCS },
  11155111: { short: 'sep', rpcs: SEPOLIA_RPCS },
};
const SHORT_TO_CHAIN = Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [c.short, Number(id)]));
// Tried in order; ipfs.io's path gateway serves directly (no origin-isolation redirect for us).
const IPFS_GATEWAYS = ['https://ipfs.io', 'https://dweb.link'];
// Public Swarm (bzz) endpoint that serves the referenced content bytes. gateway.ethswarm.org is
// a sharing-app UI (its /bzz/* routes return the same app shell), while api.gateway.ethswarm.org
// redirects bare hashes to bzz.link moderation. The download endpoint marks responses as
// attachments; that header is removed below so websites and their assets render inline.
const SWARM_GATEWAYS = ['https://download.gateway.ethswarm.org'];
// Storage protocol → how to fetch + label it. Picked from the contenthash codec.
const PROTOCOLS = {
  ipfs: { gateways: IPFS_GATEWAYS, prefix: '/ipfs/', header: 'x-ipfs-cid' },
  ipns: { gateways: IPFS_GATEWAYS, prefix: '/ipns/', header: 'x-ipns-name' },
  swarm: { gateways: SWARM_GATEWAYS, prefix: '/bzz/', header: 'x-swarm-reference' },
};
// Subdomains that are real services, not gwei names — proxied through so the wildcard route
// doesn't shadow them.
const RESERVED = {
  diff: 'https://gwei-diff-production.up.railway.app',
};

// How long resolved records / content stay cached at the edge. Contenthash edits become visible
// within RESOLVE_TTL. Negatives ("no website", "unsupported") expire faster so a freshly-set site
// shows up sooner. Transient RPC/upstream failures are never cached.
const RESOLVE_TTL = 300;     // name → content reference (seconds)
const RESOLVE_NEG_TTL = 60;  // name → "none"/"unsupported" (seconds)
const CONTENT_TTL = 300;     // proxied content (seconds)
// resolveMode() is `pure` on every contract we've seen, so its answer is effectively immutable and
// worth caching hard: it saves an eth_call on every cold web3:// request.
const MODE_TTL = 86400;      // contract → resolve mode (seconds)
const CACHE_BASE = 'https://gwei-cache.internal'; // synthetic keys for the resolution cache

const SEL_COMPUTEID = 'fb021939'; // computeId(string)
const SEL_CONTENTHASH = 'cb323d76'; // contenthash(uint256)
const SEL_TEXT = '308e3386'; // text(uint256,string)
const SEL_RESOLVEMODE = 'dd473fae'; // resolveMode()
const SEL_REQUEST = '1374c460'; // request(string[],(string,string)[])
const CONTENTCONTRACT = 'contentcontract'; // ERC-6821 text record key
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

const pad32 = (h) => h.padStart(64, '0');
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
// Index loop rather than `h.match(/../g)`: a web3:// body can be hundreds of KB, and the regex form
// allocates an intermediate array with one string per byte.
function hexToBytes(h) {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// URL.hostname exposes internationalized DNS labels in their ASCII (Punycode) form. GNS names,
// however, are registered and hashed as UTF-8, so decode each A-label before calling computeId().
// This is the RFC 3492 decoding algorithm kept inline so the Worker has no runtime dependencies.
function decodePunycodeLabel(label) {
  if (!label.startsWith('xn--')) return label;
  const input = label.slice(4);
  if (!input) return null;

  const BASE = 36, T_MIN = 1, T_MAX = 26, SKEW = 38, DAMP = 700;
  const output = [];
  let n = 128, i = 0, bias = 72, index = 0;
  const delimiter = input.lastIndexOf('-');

  if (delimiter >= 0) {
    for (let j = 0; j < delimiter; j++) {
      const code = input.charCodeAt(j);
      if (code >= 0x80) return null;
      output.push(code);
    }
    index = delimiter + 1;
  }

  const digitFor = (code) => {
    if (code >= 0x30 && code <= 0x39) return code - 0x16; // 0-9 → 26-35
    if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z → 0-25
    return BASE;
  };
  const adapt = (delta, points, first) => {
    delta = first ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > Math.floor(((BASE - T_MIN) * T_MAX) / 2)) {
      delta = Math.floor(delta / (BASE - T_MIN));
      k += BASE;
    }
    return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
  };

  while (index < input.length) {
    const oldI = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitFor(input.charCodeAt(index++));
      if (digit >= BASE || digit > Math.floor((Number.MAX_SAFE_INTEGER - i) / weight)) return null;
      i += digit * weight;
      const threshold = k <= bias ? T_MIN : (k >= bias + T_MAX ? T_MAX : k - bias);
      if (digit < threshold) break;
      const factor = BASE - threshold;
      if (weight > Math.floor(Number.MAX_SAFE_INTEGER / factor)) return null;
      weight *= factor;
    }

    const points = output.length + 1;
    bias = adapt(i - oldI, points, oldI === 0);
    const increment = Math.floor(i / points);
    if (increment > 0x10ffff - n) return null;
    n += increment;
    i %= points;
    if (n >= 0xd800 && n <= 0xdfff) return null;
    output.splice(i, 0, n);
    i++;
  }

  try {
    return String.fromCodePoint(...output);
  } catch (_) {
    return null;
  }
}

function decodeDnsName(name) {
  const decoded = [];
  for (const label of name.split('.')) {
    const value = decodePunycodeLabel(label);
    if (value == null) return null;
    decoded.push(value);
  }
  return decoded.join('.');
}

// Browser-facing security headers, mirroring eth.limo's per-subdomain hardening. Each gwei name is
// its own origin (`<name>.gwei.domains`), so this hardens every hosted site. We also normalize CORS:
// public content is world-readable, but we don't let an upstream gateway's CORS headers leak through.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "frame-ancestors 'self';",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), battery=()',
  'strict-transport-security': 'max-age=31536000',
  'cross-origin-resource-policy': 'cross-origin',
};
function harden(headers) {
  for (const k in SECURITY_HEADERS) headers.set(k, SECURITY_HEADERS[k]);
  headers.set('access-control-allow-origin', '*');
  return headers;
}
// Response headers an ERC-5219 contract is allowed to set on its own origin. Everything else is
// dropped — `set-cookie` above all, which a contract has no business writing for a name's visitors.
// (`harden()` still overwrites the security headers afterwards, so those can't be weakened either.)
const WEB3_HEADERS = new Set([
  'content-type', 'cache-control', 'content-encoding', 'content-language',
  'etag', 'last-modified', 'location', 'vary',
]);
// Manual mode returns bare bytes with no content type, so ERC-6860 says to infer one from the path
// extension and fall back to text/html.
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', xml: 'application/xml', wasm: 'application/wasm', pdf: 'application/pdf',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
function mimeFor(pathname) {
  const m = /\.([a-z0-9]+)$/i.exec(pathname || '');
  return m ? MIME[m[1].toLowerCase()] : undefined;
}

function encodeString(sel, str) {
  const bytes = new TextEncoder().encode(str);
  let data = toHex(bytes);
  while (data.length % 64) data += '0';
  return '0x' + sel + pad32('20') + pad32(bytes.length.toString(16)) + data;
}
// A dynamic `string`/`bytes` tail: length word followed by right-padded data.
function tail(bytes) {
  let data = toHex(bytes);
  while (data.length % 64) data += '0';
  return pad32(bytes.length.toString(16)) + data;
}
const utf8 = (s) => new TextEncoder().encode(s);
// `text(uint256,string)` — tokenId, offset to the string (0x40), then the string tail.
function encodeTextCall(tokenIdHex, key) {
  return '0x' + SEL_TEXT + tokenIdHex + pad32('40') + tail(utf8(key));
}
// ERC-5219 `request(string[] resource, KeyValue[] params)`. Both arguments are dynamic arrays whose
// elements are themselves dynamic, so each array is [length, ...offsets, ...tails] with the offsets
// measured from the start of the offset table (i.e. just after the length word).
function encodeStringArray(items) {
  const tails = items.map((s) => tail(utf8(s)));
  let cursor = items.length * 32;
  const offsets = tails.map((t) => {
    const at = pad32(cursor.toString(16));
    cursor += t.length / 2;
    return at;
  });
  return pad32(items.length.toString(16)) + offsets.join('') + tails.join('');
}
function encodeKeyValueArray(pairs) {
  // Each tuple is itself dynamic: [offset to key (0x40), offset to value, key tail, value tail].
  const tuples = pairs.map(([k, v]) => {
    const keyTail = tail(utf8(k));
    return pad32('40') + pad32((64 + keyTail.length / 2).toString(16)) + keyTail + tail(utf8(v));
  });
  let cursor = pairs.length * 32;
  const offsets = tuples.map((t) => {
    const at = pad32(cursor.toString(16));
    cursor += t.length / 2;
    return at;
  });
  return pad32(pairs.length.toString(16)) + offsets.join('') + tuples.join('');
}
function encodeRequestCall(resource, params) {
  const resourceBlock = encodeStringArray(resource);
  const paramsBlock = encodeKeyValueArray(params);
  return '0x' + SEL_REQUEST +
    pad32('40') +
    pad32((64 + resourceBlock.length / 2).toString(16)) +
    resourceBlock + paramsBlock;
}

// --- ABI decoding -------------------------------------------------------------
// `body` is typed `string` by ERC-5219, but contracts put arbitrary bytes there (images, fonts), so
// every dynamic value is decoded to raw bytes and only converted to text where we know it is text.
const word = (hex, at) => parseInt(hex.slice(at * 2, at * 2 + 64), 16);
function readDynamic(hex, at) {
  const len = word(hex, at);
  if (!Number.isFinite(len) || (at + 32 + len) * 2 > hex.length) return null;
  return hexToBytes(hex.slice((at + 32) * 2, (at + 32 + len) * 2));
}
const readText = (hex, at) => {
  const b = readDynamic(hex, at);
  return b === null ? null : new TextDecoder().decode(b);
};
// (uint16 statusCode, string body, KeyValue[] headers) — the ERC-5219 response tuple.
function decodeRequestResult(result) {
  const hex = result.slice(2);
  if (hex.length < 192) return null;
  const status = word(hex, 0);
  const body = readDynamic(hex, word(hex, 32));
  if (body === null) return null;
  const headersAt = word(hex, 64);
  const count = word(hex, headersAt);
  if (!Number.isFinite(count) || count > 64) return null; // sanity bound on a contract-supplied array
  const headers = [];
  for (let i = 0; i < count; i++) {
    const tupleAt = headersAt + 32 + word(hex, headersAt + 32 + i * 32);
    const key = readText(hex, tupleAt + word(hex, tupleAt));
    const value = readText(hex, tupleAt + word(hex, tupleAt + 32));
    if (key !== null && value !== null) headers.push([key, value]);
  }
  return { status, body, headers };
}
function base32(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base36(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = B36[Number(value % 36n)] + out;
    value /= 36n;
  }
  return 'k' + (out || '0');
}
// Decode an unsigned varint, rejecting truncated, overlong, and impractically large values.
function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < bytes.length && i - offset < 10; i++) {
    const byte = bytes[i];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (i > offset && byte === 0) return null; // non-canonical/overlong encoding
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return { value: Number(value), next: i + 1 };
    }
    shift += 7n;
  }
  return null;
}
// IPNS contenthash values contain a CIDv1 with the libp2p-key codec. Gateways conventionally
// expect that CID in base36. Inline identity multihashes shorter than a real public-key protobuf
// are rejected, matching the security validation in the ENS content-hash implementation.
function decodeIpns(cidHex) {
  if (!cidHex || cidHex.length % 2 !== 0) return null;
  const bytes = hexToBytes(cidHex);
  const version = readVarint(bytes, 0);
  if (!version || version.value !== 1) return null;
  const codec = readVarint(bytes, version.next);
  if (!codec || codec.value !== 0x72) return null; // libp2p-key
  const hashCode = readVarint(bytes, codec.next);
  if (!hashCode) return null;
  const hashSize = readVarint(bytes, hashCode.next);
  if (!hashSize || hashSize.value === 0 || hashSize.next + hashSize.value !== bytes.length) return null;
  if (hashCode.value === 0 && hashSize.value < 36) return null; // unsafe identity multihash
  return base36(bytes);
}
// Tries each RPC in turn. Returns { result } on success, or the definitive non-answers { empty } and
// { reverted } — a contract with no `resolveMode()` gives exactly those, and they mean "auto mode"
// rather than "the endpoint is down". Anything else (rate limit, node error) fails over. null if all fail.
async function rpcCall(to, data, rpcs) {
  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      const j = await r.json();
      if (j && j.result && j.result !== '0x') return { result: j.result };
      if (j && j.result === '0x') return { empty: true };
      if (j && j.error && /revert/i.test(j.error.message || '')) return { reverted: true };
    } catch (_) {}
  }
  return null;
}
// Returns the first non-empty result, or null if the call failed, reverted, or returned nothing.
async function ethCall(to, data, rpcs) {
  const r = await rpcCall(to, data, rpcs);
  return r && r.result ? r.result : null;
}
function page(title, body, status, cache = 'public, max-age=60') {
  const headers = harden(new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': cache }));
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>body{background:#0a0a0a;color:#e8e8e0;font-family:Helvetica,Arial,sans-serif;` +
    `min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:24px;line-height:1.6}` +
    `a{color:#e8e8e0}p{color:#b8b8b0;max-width:380px;margin:0}</style>${body}`,
    { status, headers },
  );
}

// Parse an ERC-6821 `contentcontract` record: either an ERC-3770 chain-specific address
// ("eth:0x…", "sep:0x…") or a bare address, which ERC-6821 reads as mainnet. Anything else — an
// unknown chain, a malformed address, a stray path — is treated as "no website" rather than an error,
// so a typo'd record can't take a name offline in a way a retry would never fix.
function parseContentContract(record) {
  const m = /^(?:([a-z0-9-]+):)?(0x[0-9a-fA-F]{40})$/.exec((record || '').trim());
  if (!m) return null;
  const chainId = m[1] ? SHORT_TO_CHAIN[m[1].toLowerCase()] : 1;
  if (!chainId) return null;
  return { kind: 'web3', chainId, address: m[2].toLowerCase() };
}

// Resolve a gwei name to whatever it points at, caching the result. Returns one of:
//   { kind: 'ipfs'|'ipns'|'swarm', ref }     — website (IPFS CID, IPNS name, or Swarm bzz hash)
//   { kind: 'web3', chainId, address }       — website served from a contract over web3://
//   { state: 'none' }             — no contenthash and no usable contentcontract record
//   { state: 'unsupported' }      — contenthash present but unsupported or malformed
//   { error: 'rpc' }              — RPC lookup failed (never cached; a retry recovers)
//
// contenthash wins when both are set: it's the older record, so no existing site changes behavior by
// virtue of a contentcontract record appearing. The extra text() call only happens on the path that
// would otherwise already be a 404, and it's covered by the same negative cache.
async function resolveName(name, rpcs, cache, ctx) {
  const key = new Request(`${CACHE_BASE}/resolve/${encodeURIComponent(name)}`);
  const cached = await cache.match(key);
  if (cached) {
    try { return await cached.json(); } catch (_) {}
  }

  // Transient RPC failures aren't cached, so a retry recovers.
  const idRes = await ethCall(NAMENFT, encodeString(SEL_COMPUTEID, name), rpcs);
  if (!idRes) return { error: 'rpc' };
  const tokenIdHex = idRes.slice(2);
  const chRes = await ethCall(NAMENFT, '0x' + SEL_CONTENTHASH + tokenIdHex, rpcs);
  if (!chRes) return { error: 'rpc' };

  // Decode the contenthash → storage reference.
  //   IPFS:  e301 || <cidv1 bytes>
  //   IPNS:  e501 || <cidv1 libp2p-key bytes>
  //   Swarm: e4 01 01 fa 01 1b 20 || <32-byte bzz hash>   (swarm-ns / cidv1 / swarm-manifest / keccak256)
  const b = chRes.slice(2);
  const len = parseInt(b.slice(64, 128), 16) || 0;
  let result;
  if (len === 0) {
    // No contenthash — fall back to the ERC-6821 `contentcontract` text record. Note that ERC-6821
    // also specifies falling back to the name's *resolved address*; we deliberately don't, because
    // GNS `resolve()` falls back to `ownerOf`, which would make every registered name claim to be
    // a website. Only an explicit record counts.
    // An unset record still ABI-encodes to a non-empty result (offset + zero length), so a null here
    // means the lookup itself failed. Surface that rather than caching a 404 the retry can't clear.
    const ccRes = await ethCall(NAMENFT, encodeTextCall(tokenIdHex, CONTENTCONTRACT), rpcs);
    if (!ccRes) return { error: 'rpc' };
    result = parseContentContract(readText(ccRes.slice(2), word(ccRes.slice(2), 0))) || { state: 'none' };
  } else {
    const chHex = b.slice(128, 128 + len * 2);
    if (chHex.startsWith('e301')) {
      result = { kind: 'ipfs', ref: 'b' + base32(hexToBytes(chHex.slice(4))) };
    } else if (chHex.startsWith('e501')) {
      const ref = decodeIpns(chHex.slice(4));
      result = ref ? { kind: 'ipns', ref } : { state: 'unsupported' };
    } else if (chHex.startsWith('e40101fa011b20')) {
      result = { kind: 'swarm', ref: chHex.slice(14) };
    } else {
      result = { state: 'unsupported' };
    }
  }

  const ttl = result.kind ? RESOLVE_TTL : RESOLVE_NEG_TTL;
  ctx.waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
      }),
    ).catch(() => {}),
  );
  return result;
}

// Read a contract's ERC-6860 resolve mode, caching it hard. A revert, an empty return, or an
// all-zero word all mean "auto" — that's what a contract with no `resolveMode()` at all looks like.
async function resolveMode(chainId, address, rpcs, cache, ctx) {
  const key = new Request(`${CACHE_BASE}/mode/${chainId}/${address}`);
  const cached = await cache.match(key);
  if (cached) {
    try { return (await cached.json()).mode; } catch (_) {}
  }
  const r = await rpcCall(address, '0x' + SEL_RESOLVEMODE, rpcs);
  if (!r) return null; // every endpoint failed — don't cache, a retry recovers
  let mode = 'auto';
  if (r.result && r.result.length >= 66) {
    const decoded = new TextDecoder().decode(hexToBytes(r.result.slice(2, 66))).replace(/\0+$/, '');
    if (decoded) mode = decoded;
  }
  ctx.waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify({ mode }), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${MODE_TTL}` },
      }),
    ).catch(() => {}),
  );
  return mode;
}

// Serve a website straight out of a contract (ERC-6860 web3://), with no storage network in between.
// Dispatches on the contract's declared resolve mode:
//   "5219"   — ERC-6944 resource request: request(pathSegments, queryPairs) returns an HTTP status,
//              a body, and headers, so the contract speaks HTTP itself.
//   "manual" — the raw path+query is the calldata; the return is ABI-encoded bytes.
//   auto     — not served yet; needs path→method translation and the ERC-7087 MIME rules.
async function serveWeb3(ref, name, url, cache, ctx) {
  const chain = CHAINS[ref.chainId];
  if (!chain) return page(name, '<p>This name points to a contract on an unsupported chain.</p>', 415);
  const rpcFailed = () => page(name, '<p>Resolution failed (RPC).</p>', 502, 'no-store');

  const mode = await resolveMode(ref.chainId, ref.address, chain.rpcs, cache, ctx);
  if (!mode) return rpcFailed();

  let status = 200;
  let body;
  const headers = new Headers();

  if (mode === '5219') {
    let resource = url.pathname.split('/').filter(Boolean);
    try { resource = resource.map(decodeURIComponent); } catch (_) {} // keep raw if percent-decoding fails
    const params = [...new URLSearchParams(url.search)];
    const res = await ethCall(ref.address, encodeRequestCall(resource, params), chain.rpcs);
    if (!res) return rpcFailed();
    const decoded = decodeRequestResult(res);
    if (!decoded) return page(name, '<p>This contract returned a malformed ERC-5219 response.</p>', 502, 'no-store');
    // ERC-6944 splits oversized bodies across calls via `web3-next-chunk`. We don't follow the chain
    // yet, and serving only the first chunk would look like a silently truncated site.
    if (decoded.headers.some(([k]) => k.toLowerCase() === 'web3-next-chunk')) {
      return page(name, '<p>This site is served in chunks, which gwei.domains does not support yet.</p>', 501);
    }
    // Response() only accepts 200–599; a contract returning anything else (including a 1xx) would
    // throw rather than fail gracefully, so it's reported as a bad gateway instead.
    status = decoded.status >= 200 && decoded.status <= 599 ? decoded.status : 502;
    body = decoded.body;
    for (const [k, v] of decoded.headers) {
      if (WEB3_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    }
  } else if (mode === 'manual') {
    // Calldata is the raw path+query bytes, with no selector — it lands in the contract's fallback.
    const pathQuery = (url.pathname || '/') + url.search;
    const res = await ethCall(ref.address, '0x' + toHex(utf8(pathQuery)), chain.rpcs);
    if (!res) return rpcFailed();
    const hex = res.slice(2);
    body = readDynamic(hex, word(hex, 0));
    if (body === null) return page(name, '<p>This contract returned a malformed response.</p>', 502, 'no-store');
    headers.set('content-type', mimeFor(url.pathname) || 'text/html; charset=utf-8');
  } else {
    return page(
      name,
      `<p>This name points to a <b>${escapeHtml(mode)}</b>-mode contract. gwei.domains serves ` +
      `resource-request (ERC-5219) and manual mode so far.</p>`,
      415,
    );
  }

  if (!headers.has('cache-control')) headers.set('cache-control', `public, max-age=${CONTENT_TTL}`);
  // Percent-encoded for the same reason as the storage-gateway path below: header values are
  // ByteStrings, and an internationalized name would otherwise throw here.
  headers.set('x-gwei-name', encodeURIComponent(name));
  headers.set('x-web3-contract', `${chain.short}:${ref.address}`);
  headers.set('x-web3-resolve-mode', mode);
  // These statuses are defined to carry no body; handing one to Response() throws.
  const empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : body, { status, headers: harden(headers) });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    // A dedicated RPC (set via `wrangler secret put RPC_URL`) is tried first, then the public pool.
    const rpcs = (env && env.RPC_URL) ? [env.RPC_URL, ...RPCS] : RPCS;

    // Only subdomains of gwei.domains; the apex (the dapp) is routed elsewhere.
    if (!host.endsWith('.gwei.domains')) return page('gwei gateway', '<p>Not a gwei name.</p>', 404);
    const sub = host.slice(0, -'.gwei.domains'.length); // "donnoh", "diff", "a.b", …
    if (!sub) return page('gwei gateway', '<p>Not a gwei name.</p>', 404);

    // Reserved service subdomains: transparently proxy to their real origin (no caching/hardening).
    if (RESERVED[sub]) {
      const upstream = await fetch(RESERVED[sub] + url.pathname + url.search, {
        method: request.method, headers: request.headers, body: request.body, redirect: 'follow',
      });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    }

    const decodedSub = decodeDnsName(sub);
    if (decodedSub == null) return page('gwei gateway', '<p>Invalid internationalized name.</p>', 400);
    const name = decodedSub + '.gwei'; // gwei name this host maps to
    const cache = caches.default;

    // Content cache: serve a previously-proxied full response for this exact URL.
    if (request.method === 'GET') {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    // 1. Resolve the name's records on-chain (cached).
    const r = await resolveName(name, rpcs, cache, ctx);
    if (r.error) return page('gwei gateway', '<p>Resolution failed (RPC).</p>', 502, 'no-store');
    if (r.state === 'none') {
      return page(name, `<p><b>${escapeHtml(name)}</b> has no website set.</p><p><a href="https://gwei.domains">set one →</a></p>`, 404);
    }
    if (r.state === 'unsupported') {
      return page(name, '<p>This name points to an unsupported contenthash (gwei.domains serves IPFS, IPNS, and Swarm).</p>', 415);
    }

    // 2a. Contract-hosted site: call it over web3:// instead of proxying a storage gateway.
    if (r.kind === 'web3') {
      const resp = await serveWeb3(r, name, url, cache, ctx);
      if (request.method === 'GET' && resp.status === 200) {
        ctx.waitUntil(cache.put(request, resp.clone()).catch(() => {}));
      }
      return resp;
    }

    const proto = PROTOCOLS[r.kind];

    // 2b. Reverse-proxy the content from the matching storage gateway (IPFS, IPNS, or Swarm).
    for (const gw of proto.gateways) {
      try {
        const upstream = await fetch(`${gw}${proto.prefix}${r.ref}${url.pathname}${url.search}`, {
          headers: { accept: request.headers.get('accept') || '*/*' },
          redirect: 'follow',
        });
        if (upstream.ok || upstream.status === 304) {
          const headers = harden(new Headers(upstream.headers));
          if (r.kind === 'swarm') headers.delete('content-disposition');
          headers.set('cache-control', `public, max-age=${CONTENT_TTL}`);
          // Header values are ByteStrings; percent-encoding preserves non-ASCII names without
          // making the response construction throw. ASCII names remain unchanged.
          headers.set('x-gwei-name', encodeURIComponent(name));
          headers.set(proto.header, r.ref);
          const resp = new Response(upstream.body, { status: upstream.status, headers });
          // Only full 200 GETs are cacheable; failures and partials are not.
          if (request.method === 'GET' && upstream.status === 200) {
            ctx.waitUntil(cache.put(request, resp.clone()).catch(() => {}));
          }
          return resp;
        }
      } catch (_) {}
    }
    return page(name, '<p>Content is set but couldn’t be fetched right now.</p>', 504, 'no-store');
  },
};
