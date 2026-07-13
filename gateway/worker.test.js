// Extensive tests for the gwei.domains gateway Worker (caching + security headers + resolution).
// Run: `node --test worker.test.js` (Node 18+; uses global fetch/Request/Response/Headers).
//
// Strategy: import the real worker and drive it with a faithful Cache API mock and a fetch mock
// that intercepts RPC / IPFS / reserved upstreams, counts calls, and records URLs — so we can
// assert cache hits skip upstreams, failures aren't cached, and the CID decode is byte-correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

// ---- fixtures ---------------------------------------------------------------
const pad32 = (h) => h.padStart(64, '0');
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32Decode(s) { // inverse of the worker's base32 encode
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Uint8Array.from(out);
}
// Build the raw `contenthash(uint256)` ABI return (offset + length + padded data) for a contenthash hex.
function abiBytes(chHex) {
  const lenHex = pad32((chHex.length / 2).toString(16));
  let data = chHex; while (data.length % 64) data += '0';
  return '0x' + pad32('20') + lenHex + data;
}
// donnoh.gwei's real IPFS website CID (verified on mainnet). Round-trip it into a contenthash.
const DONNOH_CID = 'bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644';
const DONNOH_CH = 'e301' + toHex(base32Decode(DONNOH_CID.slice(1))); // strip 'b' multibase prefix
const CH_IPFS = abiBytes(DONNOH_CH);                 // e301 || cidv1  → ipfs
const CH_NONE = abiBytes('');                        // zero-length    → no website
const CH_UNSUP = abiBytes('e5010172002408011220');   // e501...        → ipns (unsupported codec)
// Swarm: e40101fa011b20 || 32-byte bzz hash. Conall's real conalloreilly.eth hash.
const SWARM_HASH = '28175db97b612938e66b21834ac6e1355e95602f9726d026b719c58d55880a4b';
const CH_SWARM = abiBytes('e40101fa011b20' + SWARM_HASH);
const TOKEN_ID = '0x' + pad32('1234');               // any 32-byte computeId() result

// ---- faithful-ish Cache API mock --------------------------------------------
function makeCache() {
  const store = new Map(); // url -> { body:ArrayBuffer, status, headers:{}, expiresAt }
  let now = 1_000_000;
  return {
    _store: store,
    advance(sec) { now += sec * 1000; },
    async match(req) {
      const url = typeof req === 'string' ? req : req.url;
      const e = store.get(url);
      if (!e) return undefined;
      if (e.expiresAt != null && now > e.expiresAt) { store.delete(url); return undefined; }
      return new Response(e.body, { status: e.status, headers: new Headers(e.headers) });
    },
    async put(req, res) {
      const method = typeof req === 'string' ? 'GET' : (req.method || 'GET');
      if (method !== 'GET') throw new TypeError('Cache API: only GET responses can be cached');
      const cc = res.headers.get('cache-control') || '';
      if (/no-store|private/i.test(cc)) throw new TypeError('Cache API: response is not storable');
      const m = /max-age=(\d+)/.exec(cc);
      const ttl = m ? parseInt(m[1], 10) : null;
      const body = await res.arrayBuffer();
      const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
      const url = typeof req === 'string' ? req : req.url;
      store.set(url, { body, status: res.status, headers, expiresAt: ttl != null ? now + ttl * 1000 : null });
    },
  };
}

// ---- fetch mock -------------------------------------------------------------
// handlers: { rpc(data,url) -> resultHex|null, ipfs(url) -> Response,
//             swarm(url) -> Response, reserved(url) -> Response }
function makeFetch(handlers) {
  const calls = { rpc: 0, ipfs: 0, swarm: 0, reserved: 0, rpcUrls: [], ipfsUrls: [], swarmUrls: [] };
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (init && init.method === 'POST' && typeof init.body === 'string' && init.body.includes('eth_call')) {
      calls.rpc++; calls.rpcUrls.push(url);
      const data = JSON.parse(init.body).params[0].data;
      const result = handlers.rpc ? handlers.rpc(data, url) : null;
      if (result === 'THROW') throw new Error('rpc network error');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: result ?? null }),
        { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/ipfs/')) {
      calls.ipfs++; calls.ipfsUrls.push(url);
      return handlers.ipfs ? handlers.ipfs(url) : new Response('content', { status: 200 });
    }
    if (url.includes('/bzz/')) {
      calls.swarm++; calls.swarmUrls.push(url);
      return handlers.swarm ? handlers.swarm(url) : new Response('swarm-content', { status: 200 });
    }
    calls.reserved++;
    return handlers.reserved ? handlers.reserved(url) : new Response('reserved-origin', { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

// Default RPC handler: computeId → TOKEN_ID, contenthash → given fixture.
const rpcReturning = (chFixture) => (data) =>
  data.startsWith('0xfb021939') ? TOKEN_ID : (data.startsWith('0xcb323d76') ? chFixture : null);

// Drive the worker; awaits ctx.waitUntil so cache writes settle before the next call.
async function invoke(urlStr, { method = 'GET', headers = {}, env = {}, cache, fetchMock } = {}) {
  const ctx = { _p: [], waitUntil(p) { this._p.push(Promise.resolve(p)); } };
  globalThis.caches = { default: cache };
  globalThis.fetch = fetchMock;
  const res = await worker.fetch(new Request(urlStr, { method, headers }), env, ctx);
  await Promise.allSettled(ctx._p);
  return res;
}

const SEC_HEADERS = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'SAMEORIGIN'],
  ['content-security-policy', "frame-ancestors 'self';"],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['strict-transport-security', 'max-age=31536000'],
  ['cross-origin-resource-policy', 'cross-origin'],
];

// ---- tests ------------------------------------------------------------------

test('happy path: resolves, decodes the real CID, proxies content', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('<h1>donnoh</h1>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>donnoh</h1>');
  assert.equal(res.headers.get('x-gwei-name'), 'donnoh.gwei');
  assert.equal(res.headers.get('x-ipfs-cid'), DONNOH_CID);
  // CID decode is byte-correct: the upstream IPFS URL uses the real CID.
  assert.equal(fetchMock.calls.ipfsUrls[0], `https://ipfs.io/ipfs/${DONNOH_CID}/`);
});

test('security headers are applied and upstream CORS is overridden', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('x', { status: 200, headers: { 'access-control-allow-origin': 'https://evil.example' } }) });
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  for (const [k, v] of SEC_HEADERS) assert.equal(res.headers.get(k), v, `header ${k}`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*'); // upstream value stripped
  assert.match(res.headers.get('cache-control'), /max-age=300/);
});

test('content cache: identical GET is served from cache, skipping all upstreams', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('cached-body', { status: 200 }) });
  const a = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(await a.text(), 'cached-body');
  const rpc1 = fetchMock.calls.rpc, ipfs1 = fetchMock.calls.ipfs;
  const b = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(await b.text(), 'cached-body');
  assert.equal(fetchMock.calls.rpc, rpc1, 'no extra RPC calls on cache hit');
  assert.equal(fetchMock.calls.ipfs, ipfs1, 'no extra IPFS calls on cache hit');
  assert.equal(b.headers.get('x-ipfs-cid'), DONNOH_CID);
});

test('resolution cache is shared across paths under the same name', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: (u) => new Response(u, { status: 200 }) });
  await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  const rpcAfterFirst = fetchMock.calls.rpc; // 2 (computeId + contenthash)
  await invoke('https://donnoh.gwei.domains/about', { cache, fetchMock });
  assert.equal(fetchMock.calls.rpc, rpcAfterFirst, 'second path reuses cached name→CID (no eth_calls)');
  assert.equal(fetchMock.calls.ipfs, 2, 'but each distinct path is fetched + cached separately');
});

test('no contenthash → 404, escaped, negatively cached', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_NONE) });
  const res = await invoke('https://nobody.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /has no website set/);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN'); // error pages hardened too
  const rpc1 = fetchMock.calls.rpc;
  await invoke('https://nobody.gwei.domains/', { cache, fetchMock });
  assert.equal(fetchMock.calls.rpc, rpc1, 'negative result cached → no re-resolve');
  assert.equal(fetchMock.calls.ipfs, 0);
});

test('unsupported contenthash codec (e.g. IPNS) → 415', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_UNSUP) });
  const res = await invoke('https://ipnsy.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 415);
  assert.match(await res.text(), /unsupported/i);
});

test('Swarm (bzz) contenthash: uses the raw endpoint and renders content inline', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcReturning(CH_SWARM),
    swarm: () => new Response('<h1>swarm site</h1>', {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-disposition': 'attachment',
      },
    }),
  });
  const res = await invoke('https://conall.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>swarm site</h1>');
  assert.equal(res.headers.get('x-gwei-name'), 'conall.gwei');
  assert.equal(res.headers.get('x-swarm-reference'), SWARM_HASH);
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.equal(res.headers.get('content-disposition'), null, 'forced download header is stripped');
  // Routed to the raw Swarm endpoint, never the sharing-app UI; no IPFS fetch.
  assert.equal(fetchMock.calls.swarmUrls[0], `https://download.gateway.ethswarm.org/bzz/${SWARM_HASH}/`);
  assert.equal(fetchMock.calls.ipfs, 0);
  // security headers apply to Swarm content too
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('Swarm asset paths retain their MIME type and render inline', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcReturning(CH_SWARM),
    swarm: () => new Response('export const ready = true;', {
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'content-disposition': 'attachment',
      },
    }),
  });
  const res = await invoke('https://conall.gwei.domains/assets/app.js', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), null);
  assert.equal(
    fetchMock.calls.swarmUrls[0],
    `https://download.gateway.ethswarm.org/bzz/${SWARM_HASH}/assets/app.js`,
  );
});

test('RPC failure → 502 no-store and is NOT cached (retry re-resolves)', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: () => null }); // every RPC returns empty
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 502);
  assert.match(res.headers.get('cache-control'), /no-store/);
  const rpc1 = fetchMock.calls.rpc;
  await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.ok(fetchMock.calls.rpc > rpc1, 'failed resolution not cached → retried on next request');
});

test('IPFS unreachable → 504 no-store; resolution still cached', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('err', { status: 500 }) });
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 504);
  assert.match(res.headers.get('cache-control'), /no-store/);
  const rpc1 = fetchMock.calls.rpc, ipfs1 = fetchMock.calls.ipfs;
  await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(fetchMock.calls.rpc, rpc1, 'resolution was cached (no re-resolve)');
  assert.ok(fetchMock.calls.ipfs > ipfs1, 'but content fetch is retried (both gateways each time)');
});

test('RPC failover: first endpoint down, second succeeds', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: (data, url) => url.includes('0xrpc') ? 'THROW' : rpcReturning(CH_IPFS)(data),
    ipfs: () => new Response('ok', { status: 200 }),
  });
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.ok(fetchMock.calls.rpcUrls.some((u) => u.includes('0xrpc')), 'tried the down endpoint');
  assert.ok(fetchMock.calls.rpcUrls.some((u) => u.includes('tenderly')), 'failed over to the next');
});

test('reserved subdomain (diff) is proxied through, not hardened/cached', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ reserved: () => new Response('railway-app', { status: 200, headers: { 'content-type': 'text/plain' } }) });
  const res = await invoke('https://diff.gwei.domains/x', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'railway-app');
  assert.equal(fetchMock.calls.reserved, 1);
  assert.equal(res.headers.get('x-frame-options'), null, 'reserved proxy is passed through untouched');
});

test('non-gwei host → 404', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({});
  const res = await invoke('https://example.com/', { cache, fetchMock });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Not a gwei name/);
  assert.equal(fetchMock.calls.rpc, 0);
});

test('apex gwei.domains is not treated as a name', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({});
  const res = await invoke('https://gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Not a gwei name/);
});

test('cache expiry: after TTL the name is re-resolved', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('v', { status: 200 }) });
  await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  const rpc1 = fetchMock.calls.rpc;
  cache.advance(301); // past RESOLVE_TTL and CONTENT_TTL (both 300s)
  await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.ok(fetchMock.calls.rpc > rpc1, 're-resolved after cache expiry');
});

test('non-GET requests are not served from / written to the content cache', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('p', { status: 200 }) });
  await invoke('https://donnoh.gwei.domains/', { method: 'POST', cache, fetchMock });
  // The content cache should hold nothing for this URL (only the resolution key exists).
  const contentHit = await cache.match(new Request('https://donnoh.gwei.domains/'));
  assert.equal(contentHit, undefined);
});
