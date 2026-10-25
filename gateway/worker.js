// gwei.domains gateway — a Cloudflare Worker that turns `<name>.gwei.domains` (or `<name>.gwei.limo`) into the website
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

import { createGatewayPool, configuredGateways } from './content-gateways.js';

import { CHAINS, RPC_BROKER_SHARDS, SHORT_TO_CHAIN, rpcEndpointConfig } from './rpc-config.js';
import {
  AutoModeError, encodeAutoCall, encodeAutoReturn, hexToBytes, isMimeType, parseAutoQuery, parseDataUrl,
} from './web3-auto.js';
import {
  AVATAR_PNG_PATH, MULTICALL3, PROFILE_CSP, PROFILE_TEXT_KEYS, avatarPng, decodeAggregate3, encodeAggregate3, nftAvatarRef,
  postListHtml, profileFromResults, renderLayout, renderProfile, renderUnregistered,
} from './profile-page.js';
import { renderFeed, renderPostPage } from './post-page.js';
import { MAX_POST_BYTES, POST_PATH, parsePost, postPath } from './posts-format.js';
import { renderMarkdown } from './markdown.js';

const NAMENFT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6'; // GNS NameNFT (mainnet; same address on Sepolia)
// Chains a `contentcontract` record may point at, keyed by chain id, with their ERC-3770 short names.
// Names themselves always resolve on mainnet (that's where the record lives); only the web3:// contract
// call goes to the chain named in the record. Endpoint configuration lives in rpc-config.js.
// Deployed gateway origins are configured once for every name via IPFS_GATEWAYS.
const IPFS_GATEWAYS = ['https://ipfs.io', 'https://dweb.link'];
const retrieveContent = createGatewayPool();
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
// Name sites live under each of these (<name>.gwei.domains and the shorter <name>.gwei.limo). The
// dapp and /api/* are on gwei.domains; the gwei.limo apex redirects there.
const DAPP_HOST = 'gwei.domains';
const NAME_DOMAINS = [DAPP_HOST, 'gwei.limo'];
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
// The last successful website lookup per name is kept much longer and only used when a fresh
// lookup fails, so an RPC outage serves a name's last known site instead of an error page.
const RESOLVE_LKG_TTL = 7 * 86400;
const IPFS_CACHE_TTL = 86400; // Immutable content can remain at the edge through upstream outages.
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
const SEL_HTML = '33c34ac3'; // html(), the getter single-file site contracts expose
const SEL_RESOLVE = '4f896d4f'; // resolve(uint256): zero unless the name is registered and active
const SEL_OWNEROF = '6352211e'; // ownerOf(uint256)
const SEL_EXPIRESAT = '17c95709'; // expiresAt(uint256)
const SEL_REVERSE = '9af8b7aa'; // reverseResolve(address): the address's primary name, if active
const SEL_TOKENURI = 'c87b56dd'; // tokenURI(uint256), ERC-721
const SEL_URI = '0e89341c'; // uri(uint256), ERC-1155
const CONTENTCONTRACT = 'contentcontract'; // ERC-6821 text record key
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

const pad32 = (h) => h.padStart(64, '0');
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
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
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
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
function cacheControlParts(value) {
  return (value || '').split(',').map((part) => part.trim()).filter(Boolean);
}
function cacheDirectiveName(part) {
  return part.split('=', 1)[0].trim().toLowerCase();
}
function hasCacheDirective(parts, name) {
  return parts.some((part) => cacheDirectiveName(part) === name);
}
function cacheDirectiveSeconds(parts, name) {
  const part = parts.find((candidate) => cacheDirectiveName(candidate) === name);
  if (!part) return null;
  const at = part.indexOf('=');
  if (at === -1) return null;
  const value = part.slice(at + 1).trim().replace(/^"|"$/g, '');
  if (!/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}
// A name can be repointed after RESOLVE_TTL, so neither a browser nor the edge may retain contract
// content longer than that. Restrictive contract directives are preserved (or made stricter);
// directives that permit stale reuse, such as immutable/stale-while-revalidate, are deliberately
// omitted from the normalized value.
function web3CacheControl(value) {
  const parts = cacheControlParts(value);
  if (hasCacheDirective(parts, 'no-store')) return 'no-store';

  const isPrivate = hasCacheDirective(parts, 'private');
  const scope = isPrivate ? 'private' : 'public';
  if (hasCacheDirective(parts, 'no-cache')) return `${scope}, no-cache, max-age=0`;

  const maxAge = Math.min(cacheDirectiveSeconds(parts, 'max-age') ?? CONTENT_TTL, CONTENT_TTL);
  const normalized = [scope, `max-age=${maxAge}`];
  const sharedMaxAge = cacheDirectiveSeconds(parts, 's-maxage');
  if (!isPrivate && sharedMaxAge !== null) {
    normalized.push(`s-maxage=${Math.min(sharedMaxAge, CONTENT_TTL)}`);
  }
  if (hasCacheDirective(parts, 'must-revalidate')) normalized.push('must-revalidate');
  if (!isPrivate && hasCacheDirective(parts, 'proxy-revalidate')) normalized.push('proxy-revalidate');
  return normalized.join(', ');
}
function web3ResponseIsCacheable(response) {
  const parts = cacheControlParts(response.headers.get('cache-control'));
  if (['no-store', 'no-cache', 'private'].some((name) => hasCacheDirective(parts, name))) return false;
  const ttl = cacheDirectiveSeconds(parts, 's-maxage') ?? cacheDirectiveSeconds(parts, 'max-age');
  return ttl !== null && ttl > 0;
}
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
// Auto mode leaves the MIME type undefined when nothing names one. Browsers would sniff it, but every
// response is sent with `nosniff`, so recognize the common formats here instead.
function sniffMime(bytes) {
  const startsWith = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return MIME.png;
  if (startsWith(0xff, 0xd8, 0xff)) return MIME.jpg;
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return MIME.gif;
  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return MIME.pdf;
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return MIME.webp;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 1024));
  } catch (_) {
    // A multi-byte character cut at the 1 KiB boundary is still text.
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 1020)); } catch (_) { text = null; }
  }
  if (text === null || /[\x00-\x08\x0e-\x1f]/.test(text)) return 'application/octet-stream';
  const head = text.replace(/^\uFEFF?\s*/, '').slice(0, 256).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return MIME.html;
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return MIME.svg;
  return MIME.txt;
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
const LOCATION_HINT = {
  AF: 'afr', AN: 'oc', AS: 'apac', EU: 'weur', NA: 'enam', OC: 'oc', SA: 'sam',
};

class RpcOverloadedError extends Error {}

function rpcRoute(request, env) {
  const continent = request.cf?.continent;
  const region = typeof continent === 'string' && /^[A-Z]{2}$/.test(continent)
    ? continent
    : 'ZZ';
  return { env, region, locationHint: LOCATION_HINT[region] };
}

// Fast deterministic routing, not a cryptographic hash. Exact calls in the same region always land
// on the same broker (single-flight), while unrelated calls spread across four broker shards.
function rpcShard(chainId, to, data, long) {
  let hash = 0x811c9dc5;
  const value = `${chainId}|${to}|${long ? 1 : 0}|${data}`;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % RPC_BROKER_SHARDS;
}

function isOverloadError(error) {
  return /overload|queue full|gateway busy|too many requests/i.test(error?.message || '');
}

// Returns { result } on success, or the definitive non-answers { empty } and { reverted }. Endpoint
// rotation, cooldowns, timeouts, concurrency limits, and exact-call coalescing live in the Durable
// Object broker so they are safe and effective across concurrent Worker requests.
async function rpcCall(chainId, to, data, route, { long = false } = {}) {
  const namespace = route.env?.RPC_BROKER;
  if (!namespace?.getByName) return null;
  const name = `rpc:${route.region}:${chainId}:${rpcShard(chainId, to, data, long)}`;
  try {
    const stub = route.locationHint
      ? namespace.getByName(name, { locationHint: route.locationHint })
      : namespace.getByName(name);
    const result = await stub.rpc({ chainId, to, data, long });
    if (result?.overloaded) throw new RpcOverloadedError('RPC broker queue full');
    if (result?.result || result?.empty || result?.reverted) return result;
  } catch (error) {
    if (error instanceof RpcOverloadedError || isOverloadError(error)) {
      throw new RpcOverloadedError('RPC broker overloaded');
    }
    console.error(JSON.stringify({ event: 'rpc_broker_error', message: error?.message || String(error) }));
  }
  return null;
}

// Returns the first non-empty result, or null if the call failed, reverted, or returned nothing.
async function ethCall(chainId, to, data, route, options) {
  const r = await rpcCall(chainId, to, data, route, options);
  return r && r.result ? r.result : null;
}
// True if a request path could address something outside the content root it is appended to:
// an encoded slash or backslash, or a segment that is '.' or '..' once decoded.
export function pathLeavesRoot(pathname) {
  if (/%(2f|5c)/i.test(pathname) || pathname.includes('\\')) return true;
  for (const segment of pathname.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return true; }
    if (decoded === '.' || decoded === '..') return true;
  }
  return false;
}

// --- posts --------------------------------------------------------------------------------------
// Posts (posts/SPEC.md) are indexed by one PostIndex Durable Object, synced every minute by the cron
// trigger. Name pages read it directly; gwei.domains/api/* exposes it to the dapp and to anyone else.
const POSTS_CRON = '* * * * *';
const postIndex = (env) => (env?.POST_INDEX?.getByName ? env.POST_INDEX.getByName('posts') : null);
// A name's posts for its page and feed, cached at the edge for half a minute.
async function cachedPosts(index, token, owner, limit, cache, ctx) {
  const key = new Request(`${CACHE_BASE}/posts/${token}/${owner}/${limit}`);
  const hit = await cache.match(key);
  if (hit) {
    try { return await hit.json(); } catch (_) {}
  }
  const posts = await index.forToken(token, owner, limit);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(posts), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
  })).catch(() => {}));
  return posts;
}
// A broken index must never take a profile page down with it.
async function fromIndex(read, fallback) {
  try {
    return await read();
  } catch (error) {
    console.error(JSON.stringify({ event: 'posts_index_error', message: String(error?.message || error).slice(0, 200) }));
    return fallback;
  }
}

// Everything under /api is public data, so any origin may read it (and upload posts, which only
// count once a name's owner authorizes their hash on-chain).
const API_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
};
function apiJson(value, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...API_HEADERS },
  });
}
function apiBytes(bytes, type) {
  // Posts and blobs are named by their hash, so they never change.
  return new Response(bytes, {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', ...API_HEADERS },
  });
}
// The request body, or null once it passes `max` bytes.
async function readBody(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

// GET answers are cached at the edge (for as long as their cache-control says), so a burst of reads
// never queues up in the single index object.
async function handleApi(request, url, env, ctx) {
  if (request.method === 'GET' && typeof caches !== 'undefined') {
    const key = new Request(`${CACHE_BASE}/api${url.pathname}${url.search}`);
    const hit = await caches.default.match(key);
    if (hit) return hit;
    const response = await answerApi(request, url, env);
    if (response.status === 200 && /max-age=[1-9]/.test(response.headers.get('cache-control') || '')) {
      ctx?.waitUntil(caches.default.put(key, response.clone()).catch(() => {}));
    }
    return response;
  }
  return answerApi(request, url, env);
}

async function answerApi(request, url, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_HEADERS });
  const index = postIndex(env);
  if (!index) return apiJson({ error: 'Posts are not enabled on this gateway.' }, 503);
  const path = url.pathname.replace(/\/+$/, '');
  const hashIn = (re) => re.exec(path)?.[1]?.toLowerCase();
  let m;
  try {
    if (request.method === 'POST') {
      if (path === '/api/sync') return apiJson(await index.poke());
      if (path !== '/api/posts' && path !== '/api/posts/preview') return apiJson({ error: 'Not found.' }, 404);
      const bytes = await readBody(request, MAX_POST_BYTES);
      if (!bytes) return apiJson({ error: `A post is at most ${MAX_POST_BYTES} bytes.` }, 413);
      if (path === '/api/posts/preview') {
        const post = parsePost(bytes);
        if (!post) return apiJson({ error: 'Not a v1 post: a JSON object with "v": 1, a "title" and a "body".' }, 400);
        return apiJson({ title: post.title, html: renderMarkdown(post.body) });
      }
      const result = await index.upload(bytes, request.headers.get('cf-connecting-ip') || '');
      return result.error ? apiJson({ error: result.error }, result.status || 400) : apiJson(result, 201);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return apiJson({ error: 'Method not allowed.' }, 405);
    if (path === '/api/posts/recent') {
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit'), 10) || 20, 1), 50);
      return apiJson({ posts: await index.recent(limit) }, 200, 'public, max-age=30');
    }
    if ((m = hashIn(/^\/api\/posts\/(0x[0-9a-fA-F]{64})\/raw$/))) {
      const bytes = await index.raw(m);
      return bytes ? apiBytes(bytes, 'application/json; charset=utf-8') : apiJson({ error: 'Unknown post.' }, 404, 'public, max-age=10');
    }
    if ((m = hashIn(/^\/api\/posts\/(0x[0-9a-fA-F]{64})$/))) {
      const detail = await index.detail(m);
      // Clients poll a fresh post until its authorization and blob show up, so only settled answers are cached.
      return detail ? apiJson(detail, 200, detail.onchain ? 'public, max-age=30' : 'no-store') : apiJson({ error: 'Unknown post.' }, 404, 'no-store');
    }
    if ((m = hashIn(/^\/api\/names\/(0x[0-9a-fA-F]{64})\/posts$/))) {
      return apiJson({ posts: await index.forCurrentOwner(m, 100) }, 200, 'public, max-age=30');
    }
    if ((m = hashIn(/^\/api\/authors\/(0x[0-9a-fA-F]{40})\/paid$/))) {
      return apiJson({ authorizations: await index.paidBy(m, 100) }, 200, 'public, max-age=10');
    }
    if ((m = hashIn(/^\/api\/blobs\/(0x01[0-9a-fA-F]{62})$/))) {
      const bytes = await index.blobBytes(m);
      return bytes ? apiBytes(bytes, 'application/octet-stream') : apiJson({ error: 'Unknown blob.' }, 404, 'public, max-age=10');
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'posts_api_error', path, message: String(error?.message || error).slice(0, 200) }));
    return apiJson({ error: 'The post index is unavailable right now.' }, 503);
  }
  return apiJson({ error: 'Not found.' }, 404);
}

// Gateway pages (errors, "no website", name profiles) share gwei.domains' look via profile-page.js.
function page(title, body, status, cache = 'public, max-age=60') {
  return htmlResponse(renderLayout({ title, body }), status, cache);
}
function htmlResponse(html, status, cache = 'public, max-age=60', csp = null) {
  const headers = harden(new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': cache }));
  if (csp) headers.set('content-security-policy', csp);
  return new Response(html, { status, headers });
}

// Transient failures (RPC, a busy broker, unreachable storage) usually clear within seconds, so these
// pages reload themselves up to three times a minute instead of leaving the visitor to refresh.
const RETRY_SCRIPT = '<script>(()=>{try{const k="gwei-retry:"+location.href,now=Date.now(),' +
  't=JSON.parse(sessionStorage.getItem(k)||"[]").filter((x)=>now-x<60000);if(t.length>=3)return;' +
  't.push(now);sessionStorage.setItem(k,JSON.stringify(t));' +
  'document.body.insertAdjacentHTML("beforeend","<p>Retrying automatically…</p>");' +
  'setTimeout(()=>location.reload(),1000+t.length*1500)}catch(_){}})()</script>';
function transientPage(title, message, status) {
  const response = page(title, `<p>${message}</p>${RETRY_SCRIPT}`, status, 'no-store');
  response.headers.set('retry-after', '2');
  return response;
}
const busyPage = (title) => transientPage(title, 'The gateway is busy. Please retry shortly.', 503);
const rpcFailedPage = (title) => transientPage(title, 'Resolution failed (RPC).', 502);

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
async function resolveName(name, route, cache, ctx) {
  const key = new Request(`${CACHE_BASE}/resolve/${encodeURIComponent(name)}`);
  const cached = await cache.match(key);
  if (cached) {
    try { return await cached.json(); } catch (_) {}
  }

  // Transient RPC failures aren't cached, so a retry recovers. Meanwhile the last known site serves.
  const lkgKey = new Request(`${CACHE_BASE}/resolve-lkg/${encodeURIComponent(name)}`);
  const lastKnown = async () => {
    const hit = await cache.match(lkgKey);
    if (!hit) return null;
    try {
      const value = await hit.json();
      console.log(JSON.stringify({ event: 'resolve_stale', name }));
      return value;
    } catch (_) {
      return null;
    }
  };
  let result;
  try {
    result = await lookupName(name, route);
  } catch (error) {
    if (error instanceof RpcOverloadedError) {
      const stale = await lastKnown();
      if (stale) return stale;
    }
    throw error;
  }
  if (result.error) return (await lastKnown()) || result;

  const ttl = result.kind ? RESOLVE_TTL : RESOLVE_NEG_TTL;
  const store = (request, maxAge) => ctx.waitUntil(
    cache.put(
      request,
      new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` },
      }),
    ).catch(() => {}),
  );
  store(key, ttl);
  // The last-known-good copy only ever stands in for the latest answer: once a lookup says the name
  // has no website (expired, re-registered, cleared), an outage must not bring the old site back.
  if (result.kind) store(lkgKey, RESOLVE_LKG_TTL);
  else ctx.waitUntil(Promise.resolve().then(() => cache.delete(lkgKey)).catch(() => {}));
  return result;
}

async function lookupName(name, route) {
  const idRes = await ethCall(1, NAMENFT, encodeString(SEL_COMPUTEID, name), route);
  if (!idRes) return { error: 'rpc' };
  const tokenIdHex = idRes.slice(2);
  const chRes = await ethCall(1, NAMENFT, '0x' + SEL_CONTENTHASH + tokenIdHex, route);
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
    const ccRes = await ethCall(1, NAMENFT, encodeTextCall(tokenIdHex, CONTENTCONTRACT), route);
    if (!ccRes) return { error: 'rpc' };
    result = parseContentContract(readText(ccRes.slice(2), word(ccRes.slice(2), 0))) || { state: 'none' };
    // A name without a website gets a profile page from its records, read in one Multicall3 call;
    // resolve() also tells an unregistered (or expired) name from one without a site. If the call
    // fails, the page just shows the plain "no website" message.
    if (result.state === 'none') {
      try {
        const calls = [SEL_RESOLVE, SEL_OWNEROF, SEL_EXPIRESAT]
          .map((sel) => ({ target: NAMENFT, data: '0x' + sel + tokenIdHex }))
          .concat(PROFILE_TEXT_KEYS.map((key) => ({ target: NAMENFT, data: encodeTextCall(tokenIdHex, key) })));
        const res = await ethCall(1, MULTICALL3, encodeAggregate3(calls), route);
        const profile = res ? profileFromResults(decodeAggregate3(res)) : null;
        if (profile) {
          result.registered = profile.registered;
          if (profile.registered) {
            profile.seed = tokenIdHex; // generative avatar
            const ref = nftAvatarRef(profile.text.avatar);
            const bannerRef = nftAvatarRef(profile.text.header);
            const [image, banner, primary] = await Promise.all([
              ref ? nftImage(ref, route) : null,
              bannerRef ? nftImage(bannerRef, route) : null,
              ethCall(1, NAMENFT, '0x' + SEL_REVERSE + pad32(profile.address.slice(2)), route).catch(() => null),
            ]);
            if (image) profile.avatarImage = image;
            if (banner) profile.bannerImage = banner;
            if (primary) profile.primary = readText(primary.slice(2), word(primary.slice(2), 0))?.toLowerCase() === name.toLowerCase();
            result.profile = profile;
          }
        }
      } catch (_) {}
    }
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

  return result;
}

// An ENSIP-12 NFT avatar: the token's metadata (from tokenURI / uri) names its image. Every step is
// bounded (one eth_call, a 64 KB metadata document fetched within 4 s) and any failure means no avatar.
const NFT_METADATA_MAX_BYTES = 64 * 1024;
async function nftImage(ref, route) {
  try {
    const idHex = pad32(ref.tokenId.toString(16));
    const res = await ethCall(1, ref.contract, '0x' + (ref.standard === 'erc721' ? SEL_TOKENURI : SEL_URI) + idHex, route);
    if (!res) return null;
    let uri = readText(res.slice(2), word(res.slice(2), 0));
    if (!uri) return null;
    if (ref.standard === 'erc1155') uri = uri.replace('{id}', idHex);
    const meta = await nftMetadata(uri.trim(), route.env);
    const image = meta && typeof meta === 'object' ? meta.image || meta.image_url : null;
    return typeof image === 'string' && image.length <= 200000 ? image.trim() : null;
  } catch (_) {
    return null;
  }
}
async function nftMetadata(uri, env) {
  const inline = /^data:application\/json(;[^,]*)?,([\s\S]*)$/i.exec(uri);
  if (inline) {
    const text = /;base64/i.test(inline[1] || '')
      ? new TextDecoder().decode(Uint8Array.from(atob(inline[2]), (c) => c.charCodeAt(0)))
      : decodeURIComponent(inline[2]);
    return JSON.parse(text);
  }
  let response = null;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([a-zA-Z0-9]{46,100}(?:\/[^\s?#]*)?)$/.exec(uri);
  if (ipfs) {
    response = await retrieveContent(configuredGateways(env?.IPFS_GATEWAYS, IPFS_GATEWAYS), `/ipfs/${ipfs[1]}`, { accept: 'application/json' });
  } else if (/^https:\/\//i.test(uri)) {
    response = await fetch(uri, {
      headers: { accept: 'application/json', 'user-agent': 'gwei.domains profile pages' },
      signal: AbortSignal.timeout(4000),
    });
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > NFT_METADATA_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Read a contract's ERC-6860 resolve mode, caching it hard. A revert, an empty return, or an
// all-zero word all mean "auto" — that's what a contract with no `resolveMode()` at all looks like.
async function resolveMode(chainId, address, route, cache, ctx) {
  const key = new Request(`${CACHE_BASE}/mode/${chainId}/${address}`);
  const cached = await cache.match(key);
  if (cached) {
    try { return (await cached.json()).mode; } catch (_) {}
  }
  const r = await rpcCall(chainId, address, '0x' + SEL_RESOLVEMODE, route);
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
//   auto     — `/<method>/<arg>…` is an ABI call (web3-auto.js) and `/` is a call with empty calldata;
//              the return is ABI-encoded bytes, or JSON when a `returns` attribute is given. MIME types
//              follow ERC-7087.
async function serveWeb3(ref, name, url, cache, ctx, route) {
  const chain = CHAINS[ref.chainId];
  if (!chain) return page(name, '<p>This name points to a contract on an unsupported chain.</p>', 415);
  const rpcFailed = () => rpcFailedPage(name);

  const mode = await resolveMode(ref.chainId, ref.address, route, cache, ctx);
  if (!mode) return rpcFailed();

  let status = 200;
  let body;
  const headers = new Headers();

  if (mode === '5219') {
    let resource = url.pathname.split('/').filter(Boolean);
    try { resource = resource.map(decodeURIComponent); } catch (_) {} // keep raw if percent-decoding fails
    const params = [...new URLSearchParams(url.search)];
    const res = await ethCall(
      ref.chainId,
      ref.address,
      encodeRequestCall(resource, params),
      route,
      { long: true },
    );
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
      if (WEB3_HEADERS.has(k.toLowerCase())) {
        try {
          headers.set(k, v);
        } catch (_) {
          return page(name, '<p>This contract returned malformed HTTP headers.</p>', 502, 'no-store');
        }
      }
    }
  } else if (mode === 'manual') {
    // Calldata is the raw path+query bytes, with no selector — it lands in the contract's fallback.
    const pathQuery = (url.pathname || '/') + url.search;
    const res = await ethCall(
      ref.chainId,
      ref.address,
      '0x' + toHex(utf8(pathQuery)),
      route,
      { long: true },
    );
    if (!res) return rpcFailed();
    const hex = res.slice(2);
    body = readDynamic(hex, word(hex, 0));
    if (body === null) return page(name, '<p>This contract returned a malformed response.</p>', 502, 'no-store');
    headers.set('content-type', mimeFor(url.pathname) || 'text/html; charset=utf-8');
  } else if (mode === 'auto') {
    let call, query;
    try {
      call = encodeAutoCall(url.pathname);
      query = parseAutoQuery(url.search);
    } catch (error) {
      if (error instanceof AutoModeError) return page(name, `<p>${escapeHtml(error.message)}</p>`, error.status);
      throw error;
    }
    let res = await rpcCall(ref.chainId, ref.address, call.data, route, { long: true });
    if (!res) return rpcFailed();
    // Not part of ERC-6860: when the empty-calldata root call reverts or returns nothing, try `html()`
    // once, so a single-file site contract still has a front page at its name.
    if (call.root && !res.result && !query.returns) {
      const fallback = await rpcCall(ref.chainId, ref.address, '0x' + SEL_HTML, route, { long: true });
      if (!fallback) return rpcFailed();
      if (fallback.result) {
        res = fallback;
        headers.set('x-web3-auto-fallback', 'html()');
      }
    }
    if (res.reverted || (call.root && !res.result)) {
      return page(name, call.root
        ? '<p>This contract serves no page at its root: the call with empty calldata reverts.</p>'
        : '<p>This contract has no page here (the call reverted).</p>', 404);
    }

    if (query.returns) {
      try {
        body = utf8(encodeAutoReturn(res.result, query.returns));
      } catch (error) {
        if (error instanceof AutoModeError) return page(name, `<p>${escapeHtml(error.message)}</p>`, error.status, 'no-store');
        throw error;
      }
      headers.set('content-type', 'application/json');
    } else {
      const hex = (res.result || '0x').slice(2);
      body = hex.length >= 128 ? readDynamic(hex, word(hex, 0)) : null;
      if (body === null) return page(name, '<p>This contract returned a malformed response.</p>', 502, 'no-store');
      let contentType;
      if (query.mime?.content !== undefined) {
        if (!isMimeType(query.mime.content)) return page(name, '<p>Invalid <b>mime.content</b> value.</p>', 400);
        contentType = query.mime.content;
      } else if (query.mime?.type !== undefined) {
        contentType = MIME[query.mime.type.toLowerCase()];
        if (!contentType) return page(name, '<p>Unrecognized <b>mime.type</b> extension.</p>', 400);
      } else if (query.mime?.dataurl) {
        const parsed = parseDataUrl(body);
        if (!parsed) return page(name, '<p>This contract did not return a valid data URL.</p>', 502, 'no-store');
        ({ contentType, body } = parsed);
      } else if (call.lastArg?.type.kind === 'string') {
        contentType = mimeFor(call.lastArg.value);
      }
      headers.set('content-type', contentType || sniffMime(body));
    }
  } else {
    return page(
      name,
      `<p>This name points to a <b>${escapeHtml(mode)}</b>-mode contract. gwei.domains serves ` +
      'auto, manual, and resource-request (ERC-5219) mode.</p>',
      415,
    );
  }

  headers.set('cache-control', web3CacheControl(headers.get('cache-control')));
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
    const route = rpcRoute(request, env);

    // Name sites are only served over HTTPS; HSTS covers repeat visits, this covers the first one.
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    // The apex is the dapp; only its /api/* routes reach this Worker.
    if (host === DAPP_HOST && url.pathname.startsWith('/api/')) return handleApi(request, url, env, ctx);
    // Other apexes send visitors to the dapp, path and all (a #name fragment survives a redirect).
    if (host !== DAPP_HOST && NAME_DOMAINS.includes(host)) return Response.redirect(`https://${DAPP_HOST}${url.pathname}${url.search}`, 302);
    // Otherwise only subdomains of a name domain.
    const base = NAME_DOMAINS.find((domain) => host.endsWith('.' + domain));
    if (!base) return page('gwei gateway', '<p>Not a gwei name.</p>', 404);
    const sub = host.slice(0, -(base.length + 1)); // "donnoh", "diff", "a.b", …
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

    // 1. Resolve the name's records on-chain (cached).
    let r;
    try {
      r = await resolveName(name, route, cache, ctx);
    } catch (error) {
      if (error instanceof RpcOverloadedError) return busyPage(name);
      throw error;
    }
    if (r.error) return rpcFailedPage('gwei gateway');
    if (r.state === 'none') {
      const dappHash = encodeURIComponent(decodedSub);
      if (r.registered === false) return htmlResponse(renderUnregistered({ name, dappHash }), 404, undefined, PROFILE_CSP);
      if (url.pathname === AVATAR_PNG_PATH && r.profile?.seed) {
        // Only an accent-colour change alters the generated avatar, so a day of caching is fine.
        const headers = harden(new Headers({ 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }));
        return new Response(await avatarPng(r.profile.seed, 256, r.profile.page?.color), { status: 200, headers });
      }
      const pageUrl = `https://${host}/`;
      const index = postIndex(env);
      // Posts count for the name's current owner only, so a sold name doesn't carry its old posts.
      const token = r.profile?.seed && r.profile.owner ? '0x' + r.profile.seed : null;
      const postMatch = POST_PATH.exec(url.pathname);
      if (index && token && postMatch) {
        const post = await fromIndex(() => index.postForToken(token, r.profile.owner, postMatch[1]), null);
        if (post) {
          return htmlResponse(renderPostPage({ name, pageUrl, profile: r.profile, post }), 200, 'public, max-age=60', PROFILE_CSP);
        }
      }
      if (index && token && url.pathname === '/feed.xml') {
        const posts = await fromIndex(() => cachedPosts(index, token, r.profile.owner, 20, cache, ctx), []);
        const bodies = posts.length ? await fromIndex(() => index.bodies(posts.map((p) => p.hash)), []) : [];
        const feed = renderFeed({ name, pageUrl, posts: posts.map((p, i) => ({ ...p, body: bodies[i] || '' })) });
        const headers = harden(new Headers({ 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=300' }));
        return new Response(feed, { status: 200, headers });
      }
      if (url.pathname !== '/') {
        return page(name, `<p>This page doesn't exist on <b>${escapeHtml(name)}</b>.</p><p><a href="/">go to the home page →</a></p>`, 404);
      }
      if (r.profile) {
        const posts = index && token ? await fromIndex(() => cachedPosts(index, token, r.profile.owner, 50, cache, ctx), []) : [];
        const postsHtml = postListHtml(posts, postPath);
        return htmlResponse(renderProfile({ name, dappHash, pageUrl, profile: r.profile, postsHtml }), 200, undefined, PROFILE_CSP);
      }
      return page(name, `<p><b>${escapeHtml(name)}</b> has no website set.</p><p><a href="https://gwei.domains/#${dappHash}">set one →</a></p>`, 404);
    }
    if (r.state === 'unsupported') {
      return page(name, '<p>This name points to an unsupported contenthash (gwei.domains serves IPFS, IPNS, and Swarm).</p>', 415);
    }

    // A storage path must stay inside the name's content root. Gateways decode %2F and then resolve
    // '..', so /..%2F<other CID>/ would otherwise serve another CID on this name's origin.
    if (r.kind !== 'web3' && pathLeavesRoot(url.pathname)) {
      return page(name, '<p>That path isn\u2019t valid for this site.</p>', 400);
    }

    // Bind cached content to the resolved reference. Once the resolution entry expires, a repointed
    // name selects a different key even if an older page response still exists at the edge.
    const version = r.kind === 'web3' ? `web3:${r.chainId}:${r.address}` : `${r.kind}:${r.ref}`;
    const contentKey = new Request(
      `${CACHE_BASE}/content/${encodeURIComponent(name)}/${encodeURIComponent(version)}` +
      `?url=${encodeURIComponent(url.pathname + url.search)}`,
      { headers: request.headers },
    );
    if (request.method === 'GET') {
      const hit = await cache.match(contentKey);
      if (hit) {
        if (r.kind !== 'ipfs') return hit;
        const headers = new Headers(hit.headers);
        headers.set('cache-control', `public, max-age=${CONTENT_TTL}`);
        headers.delete('age');
        return new Response(hit.body, { status: hit.status, headers });
      }
    }

    // 2a. Contract-hosted site: call it over web3:// instead of proxying a storage gateway.
    if (r.kind === 'web3') {
      let resp;
      try {
        resp = await serveWeb3(r, name, url, cache, ctx, route);
      } catch (error) {
        if (error instanceof RpcOverloadedError) return busyPage(name);
        throw error;
      }
      if (request.method === 'GET' && resp.status === 200 && web3ResponseIsCacheable(resp)) {
        ctx.waitUntil(cache.put(contentKey, resp.clone()).catch(() => {}));
      }
      return resp;
    }

    const proto = PROTOCOLS[r.kind];

    // 2b. Reverse-proxy the content from the matching storage gateway (IPFS, IPNS, or Swarm).
    const gateways = configuredGateways(r.kind === 'swarm' ? env.SWARM_GATEWAYS : env.IPFS_GATEWAYS, proto.gateways);
    // Accept is not forwarded: gateways pick other representations from it (raw blocks, CAR, tar),
    // and the cache key doesn't vary on it, so one visitor's Accept would decide everyone's page.
    const root = `${proto.prefix}${r.ref}`;
    let upstream = await retrieveContent(gateways, `${root}${url.pathname}${url.search}`, { accept: '*/*' });
    // Redirects are followed (gateways add trailing slashes; subdomain gateways move the ref into the
    // host), but never out of the content root.
    const landed = upstream?.url ? new URL(upstream.url) : null;
    if (landed && !landed.pathname.startsWith(root) && !landed.hostname.startsWith(`${r.ref.toLowerCase()}.`)) {
      void upstream.body?.cancel().catch(() => {});
      upstream = new Response(null, { status: 404 });
    }
    if (upstream?.status === 404) {
      return page(name, `<p>This page doesn't exist on <b>${escapeHtml(name)}</b>.</p><p><a href="/">go to the home page →</a></p>`, 404);
    }
    if (upstream) {
      const headers = harden(new Headers(upstream.headers));
      if (r.kind === 'swarm') headers.delete('content-disposition');
      headers.set('cache-control', `public, max-age=${CONTENT_TTL}`);
      headers.delete('age');
      // Header values are ByteStrings; percent-encoding preserves non-ASCII names without
      // making the response construction throw. ASCII names remain unchanged.
      headers.set('x-gwei-name', encodeURIComponent(name));
      headers.set(proto.header, r.ref);
      const resp = new Response(upstream.body, { status: upstream.status, headers });
      // Only full 200 GETs are cacheable; failures and partials are not.
      if (request.method === 'GET' && upstream.status === 200) {
        const stored = resp.clone();
        if (r.kind === 'ipfs') stored.headers.set('cache-control', `public, max-age=${IPFS_CACHE_TTL}, immutable`);
        ctx.waitUntil(cache.put(contentKey, stored).catch(() => {}));
      }
      return resp;
    }
    return transientPage(name, 'Content is set but couldn’t be fetched right now.', 504);
  },

  // Daily check that every RPC and IPFS endpoint still answers Worker traffic. Public endpoints fail
  // silently (the October 2026 RPC outage was only noticed by visitors), so failures are logged at
  // error level, where Workers Logs keeps them.
  async scheduled(controller, env, ctx) {
    if (controller.cron === POSTS_CRON) {
      const index = postIndex(env);
      if (index) {
        ctx.waitUntil(index.sync().then(
          (result) => { if (result?.events || result?.blobs) console.log(JSON.stringify({ event: 'posts_sync', ...result })); },
          (error) => console.error(JSON.stringify({ event: 'posts_sync_failed', message: String(error?.message || error).slice(0, 200) })),
        ));
      }
      return;
    }
    ctx.waitUntil(checkEndpoints(env));
  },
};

async function probe(url, init = {}) {
  const host = new URL(url).host;
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    if (!response.ok) return `${host}: HTTP ${response.status}`;
    if (init?.method === 'POST' && !/"result"\s*:\s*"0x[0-9a-f]+"/i.test(text)) return `${host}: ${text.slice(0, 100)}`;
    return null;
  } catch (error) {
    return `${host}: ${error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error).slice(0, 100)}`;
  }
}

export async function checkEndpoints(env) {
  const rpc = (url, auth) => probe(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}',
  });
  const checks = [
    ...Object.keys(CHAINS).flatMap((id) => {
      const { endpoints, preferred, preferredAuth } = rpcEndpointConfig(Number(id), env);
      return endpoints.map((url) => ['rpc', url, rpc(url, url === preferred ? preferredAuth : null)]);
    }),
    // bafkqaaa is the empty identity CID: any gateway answers it without fetching content, so this
    // tests whether the gateway accepts our traffic, not whether a particular site is retrievable.
    ...configuredGateways(env.IPFS_GATEWAYS, IPFS_GATEWAYS).map((url) => ['ipfs', url, probe(`${url}/ipfs/bafkqaaa`)]),
  ];
  const failures = (await Promise.all(checks.map(([, , result]) => result))).filter(Boolean);
  const summary = { event: 'endpoint_health', checked: checks.length, failures };
  if (failures.length) summary.notified = await notifyFailures(env, summary);
  if (failures.length) console.error(JSON.stringify(summary));
  else console.log(JSON.stringify(summary));
  return summary;
}

// Failures are also pushed to ntfy, so a dead endpoint reaches a phone instead of waiting in the logs.
// NTFY_URL is the topic URL and NTFY_TOKEN a publish-only token; without both, nothing is sent.
// Cloudflare's bot protection in front of ntfy rejects requests without a recognizable user agent.
async function notifyFailures(env, { checked, failures }) {
  if (typeof env?.NTFY_URL !== 'string' || typeof env?.NTFY_TOKEN !== 'string' || !failures.length) return null;
  try {
    const response = await fetch(env.NTFY_URL.trim(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.NTFY_TOKEN.trim()}`,
        title: 'gwei.domains gateway: endpoint check failed',
        tags: 'warning',
        'user-agent': 'gwei-gateway health check (gwei.domains)',
      },
      body: `${failures.length} of ${checked} endpoints failed the daily check:\n${failures.join('\n')}\n\n` +
        'Public endpoints that stop answering Worker traffic should be replaced (gateway/rpc-config.js, IPFS_GATEWAYS).',
      signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch (error) {
    return `error: ${String(error?.message || error).slice(0, 100)}`;
  }
}
