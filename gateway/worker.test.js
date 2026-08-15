// Extensive tests for the gwei.domains gateway Worker (caching + security headers + resolution).
// Run: `node --test worker.test.js` (Node 18+; uses global fetch/Request/Response/Headers).
//
// Strategy: import the real worker and drive it with a faithful Cache API mock and a fetch mock
// that intercepts RPC / IPFS / IPNS / reserved upstreams, counts calls, and records URLs — so we can
// assert cache hits skip upstreams, failures aren't cached, and the CID decode is byte-correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {
  RPC_PAGE_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  rpcEndpointConfig,
} from './rpc-config.js';
import { RpcPool } from './rpc-pool.js';

// ---- fixtures ---------------------------------------------------------------
const pad32 = (h) => h.padStart(64, '0');
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
function decodeStringCall(data) {
  const args = data.slice(10); // 0x + 4-byte selector
  const length = parseInt(args.slice(64, 128), 16);
  const bytes = Uint8Array.from(
    (args.slice(128, 128 + length * 2).match(/../g) || []).map((x) => parseInt(x, 16)),
  );
  return new TextDecoder().decode(bytes);
}
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
const CH_UNSUP = abiBytes('e6010102');               // unknown namespace codec
// Active mainnet IPNS records using both Peer ID encodings accepted by ENS content-hash tooling.
const XAV_IPNS = 'k2k4r8ng8uzrtqb5ham8kao889m8qezu96z4w3lpinyqghum43veb6n3';
const XAV_IPNS_BYTES = '01721220a1dc5d90d7272c0fd9150414f14c80c71de5d243c2f23165e2ddb495cbbcd05f';
const CH_IPNS_SHA256 = abiBytes('e501' + XAV_IPNS_BYTES);
const HASHFRIEND_IPNS = 'k51qzi5uqu5dm7u9ns1a5utzqrufm5p8znj2pwl38amnzmwkdmf52ntlg06m8d';
const HASHFRIEND_IPNS_BYTES = '0172002408011220f2209793528adf06812d942e80d68f34e37119cd305f9d05d1e20f5cc3b7860d';
const CH_IPNS_IDENTITY = abiBytes('e501' + HASHFRIEND_IPNS_BYTES);
const CH_IPNS_UNSAFE_IDENTITY = abiBytes('e5010172000408011220');
const CH_IPNS_TRUNCATED = abiBytes('e501');
// Swarm: e40101fa011b20 || 32-byte bzz hash. Conall's real conalloreilly.eth hash.
const SWARM_HASH = '28175db97b612938e66b21834ac6e1355e95602f9726d026b719c58d55880a4b';
const CH_SWARM = abiBytes('e40101fa011b20' + SWARM_HASH);
const TOKEN_ID = '0x' + pad32('1234');               // any 32-byte computeId() result
const RPC_RESPONSE_LIMIT = 4 * 1024 * 1024;

// ---- web3:// fixtures (ERC-6821 contentcontract + ERC-6944 resource request) -------------------
const utf8 = (s) => new TextEncoder().encode(s);
// ABI `string`/`bytes` tail: length word + right-padded data.
function tail(bytes) {
  let data = toHex(bytes); while (data.length % 64) data += '0';
  return pad32(bytes.length.toString(16)) + data;
}
const abiString = (s) => '0x' + pad32('20') + tail(utf8(s));   // a bare `returns (string)`
const TEXT_NONE = abiString('');                                // no contentcontract record set
// The real EthereumRock deployment, the contract this feature was built against.
const ROCK = '0x6485b8b75a8ad382340abe333e1f6ee10e39f818';
const ROCK_2 = '0x1111111111111111111111111111111111111111';
const CC_MAINNET = abiString(`eth:${ROCK}`);
const CC_MAINNET_2 = abiString(`eth:${ROCK_2}`);
const CC_SEPOLIA = abiString(`sep:${ROCK}`);
const CC_BARE = abiString(ROCK);                                // no chain prefix → mainnet per ERC-6821
const CC_UNKNOWN_CHAIN = abiString(`base:${ROCK}`);
const CC_MALFORMED = abiString('eth:0xdeadbeef');
// bytes32 resolveMode() answers.
const modeWord = (s) => { let h = toHex(utf8(s)); return '0x' + h.padEnd(64, '0'); };
const MODE_5219 = modeWord('5219');
const MODE_MANUAL = modeWord('manual');
const MODE_AUTO = modeWord('auto');
// Build an ERC-5219 `(uint16 status, string body, KeyValue[] headers)` return. `body` accepts bytes
// so tests can prove binary content survives the round trip untouched.
function abiRequestResult(status, body, headers = []) {
  const bodyBytes = typeof body === 'string' ? utf8(body) : body;
  const bodyTail = tail(bodyBytes);
  const tuples = headers.map(([k, v]) => {
    const kt = tail(utf8(k));
    return pad32('40') + pad32((64 + kt.length / 2).toString(16)) + kt + tail(utf8(v));
  });
  let cursor = headers.length * 32;
  const offsets = tuples.map((t) => { const at = pad32(cursor.toString(16)); cursor += t.length / 2; return at; });
  const headerBlock = pad32(headers.length.toString(16)) + offsets.join('') + tuples.join('');
  return '0x' + pad32(status.toString(16)) + pad32('60') +
    pad32((96 + bodyTail.length / 2).toString(16)) + bodyTail + headerBlock;
}
const abiBytesReturn = (body) => '0x' + pad32('20') + tail(typeof body === 'string' ? utf8(body) : body);

const SEL = { id: '0xfb021939', ch: '0xcb323d76', text: '0x308e3386', mode: '0xdd473fae', request: '0x1374c460' };
// RPC handler for a name whose website lives in a contract: no contenthash, a contentcontract record,
// then whatever the contract itself answers. `onCall` sees the web3:// calldata.
function rpcWeb3({ cc = CC_MAINNET, mode = MODE_5219, onCall = () => null } = {}) {
  return (data) => {
    if (data.startsWith(SEL.id)) return TOKEN_ID;
    if (data.startsWith(SEL.ch)) return CH_NONE;
    if (data.startsWith(SEL.text)) return cc;
    if (data.startsWith(SEL.mode)) return mode;
    return onCall(data);
  };
}

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
// handlers: { rpc(data,url,to) -> resultHex|Response|null, ipfs(url) -> Response, ipns(url) -> Response,
//             swarm(url) -> Response, reserved(url) -> Response }
function makeFetch(handlers) {
  const calls = {
    rpc: 0, ipfs: 0, ipns: 0, swarm: 0, reserved: 0,
    rpcUrls: [], ipfsUrls: [], ipnsUrls: [], swarmUrls: [],
  };
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (init && init.method === 'POST' && typeof init.body === 'string' && init.body.includes('eth_call')) {
      calls.rpc++; calls.rpcUrls.push(url);
      const call = JSON.parse(init.body).params[0];
      const data = call.data;
      const result = handlers.rpc ? await handlers.rpc(data, url, call.to, init) : null;
      if (result === 'THROW') throw new Error('rpc network error');
      if (result instanceof Response) return result;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: result ?? null }),
        { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/ipfs/')) {
      calls.ipfs++; calls.ipfsUrls.push(url);
      return handlers.ipfs ? handlers.ipfs(url) : new Response('content', { status: 200 });
    }
    if (url.includes('/ipns/')) {
      calls.ipns++; calls.ipnsUrls.push(url);
      return handlers.ipns ? handlers.ipns(url) : new Response('ipns-content', { status: 200 });
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

// Default RPC handler: computeId → TOKEN_ID, contenthash → given fixture, contentcontract → unset.
// (An unset text record still ABI-encodes to a real value, so it must not answer null — null means
// the lookup failed, which the worker surfaces as a 502 rather than "no website".)
const rpcReturning = (chFixture) => (data) =>
  data.startsWith(SEL.id) ? TOKEN_ID
    : data.startsWith(SEL.ch) ? chFixture
    : data.startsWith(SEL.text) ? TEXT_NONE
    : null;

// Faithful in-process stand-in for the Durable Object namespace. Each deterministic broker name
// owns one RpcPool, just as each real Durable Object shard does in production.
function makeRpcBrokerNamespace(fetchMock, env) {
  const brokers = new Map();
  return {
    getByName(name) {
      let stub = brokers.get(name);
      if (!stub) {
        const pools = new Map();
        stub = {
          rpc(input) {
            const config = rpcEndpointConfig(input.chainId, env);
            if (!config) return { failed: true };
            let pool = pools.get(input.chainId);
            if (!pool) {
              pool = new RpcPool({ fetchImpl: fetchMock });
              pools.set(input.chainId, pool);
            }
            return pool.rpc({
              to: input.to,
              data: input.data,
              ...config,
              timeoutMs: input.long ? RPC_PAGE_TIMEOUT_MS : RPC_TIMEOUT_MS,
            });
          },
        };
        brokers.set(name, stub);
      }
      return stub;
    },
  };
}

// Drive the worker; awaits ctx.waitUntil so cache writes settle before the next call.
async function invoke(urlStr, { method = 'GET', headers = {}, env = {}, cache, fetchMock } = {}) {
  const ctx = { _p: [], waitUntil(p) { this._p.push(Promise.resolve(p)); } };
  globalThis.caches = { default: cache };
  globalThis.fetch = fetchMock;
  if (!env.RPC_BROKER) env.RPC_BROKER = makeRpcBrokerNamespace(fetchMock, env);
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

test('emoji hostname is decoded from Punycode before computeId', async () => {
  const cache = makeCache();
  let computedName;
  const fetchMock = makeFetch({
    rpc: (data) => {
      if (data.startsWith('0xfb021939')) {
        computedName = decodeStringCall(data);
        return TOKEN_ID;
      }
      return data.startsWith('0xcb323d76') ? CH_IPFS : null;
    },
    ipfs: () => new Response('<h1>whale</h1>', { status: 200 }),
  });

  // Request/URL normalizes the Unicode hostname to xn--7o8h before the Worker sees it.
  const res = await invoke('https://🐳.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(computedName, '🐳.gwei');
  assert.equal(decodeURIComponent(res.headers.get('x-gwei-name')), '🐳.gwei');
  assert.equal(await res.text(), '<h1>whale</h1>');
});

test('Punycode is decoded label-by-label for nested gwei names', async () => {
  const cache = makeCache();
  let computedName;
  const fetchMock = makeFetch({
    rpc: (data) => {
      if (data.startsWith('0xfb021939')) {
        computedName = decodeStringCall(data);
        return TOKEN_ID;
      }
      return data.startsWith('0xcb323d76') ? CH_IPFS : null;
    },
  });

  const res = await invoke('https://sub.xn--7o8h.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(computedName, 'sub.🐳.gwei');
  assert.equal(decodeURIComponent(res.headers.get('x-gwei-name')), 'sub.🐳.gwei');
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

test('unsupported contenthash codec → 415', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_UNSUP) });
  const res = await invoke('https://ipnsy.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 415);
  assert.match(await res.text(), /unsupported/i);
});

test('IPNS sha2-256 Peer ID: decodes to canonical base36 and proxies content', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcReturning(CH_IPNS_SHA256),
    ipns: () => new Response('<h1>xav</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const res = await invoke('https://xav.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>xav</h1>');
  assert.equal(res.headers.get('x-gwei-name'), 'xav.gwei');
  assert.equal(res.headers.get('x-ipns-name'), XAV_IPNS);
  assert.equal(fetchMock.calls.ipnsUrls[0], `https://ipfs.io/ipns/${XAV_IPNS}/`);
  assert.equal(fetchMock.calls.ipfs, 0);
  assert.equal(fetchMock.calls.swarm, 0);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('IPNS inline-key Peer ID: decodes to base36 and preserves asset paths', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcReturning(CH_IPNS_IDENTITY),
    ipns: (url) => new Response(url, { status: 200 }),
  });
  const res = await invoke('https://hashfriend.gwei.domains/assets/app.js?version=1', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-ipns-name'), HASHFRIEND_IPNS);
  assert.equal(
    fetchMock.calls.ipnsUrls[0],
    `https://ipfs.io/ipns/${HASHFRIEND_IPNS}/assets/app.js?version=1`,
  );
});

test('IPNS gateway failover: dweb.link is used when ipfs.io fails', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcReturning(CH_IPNS_SHA256),
    ipns: (url) => url.startsWith('https://ipfs.io/')
      ? new Response('upstream error', { status: 500 })
      : new Response('fallback content', { status: 200 }),
  });
  const res = await invoke('https://xav.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'fallback content');
  assert.deepEqual(fetchMock.calls.ipnsUrls, [
    `https://ipfs.io/ipns/${XAV_IPNS}/`,
    `https://dweb.link/ipns/${XAV_IPNS}/`,
  ]);
});

test('malformed or insecure IPNS contenthash → 415 without a gateway request', async () => {
  for (const fixture of [CH_IPNS_UNSAFE_IDENTITY, CH_IPNS_TRUNCATED]) {
    const cache = makeCache();
    const fetchMock = makeFetch({ rpc: rpcReturning(fixture) });
    const res = await invoke('https://bad-ipns.gwei.domains/', { cache, fetchMock });
    assert.equal(res.status, 415);
    assert.match(await res.text(), /unsupported/i);
    assert.equal(fetchMock.calls.ipns, 0);
  }
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

// ---- web3:// (ERC-6821 contentcontract → ERC-6860 contract-hosted sites) ---------------------

test('contenthash wins when a name has both records set', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: (data) => data.startsWith(SEL.id) ? TOKEN_ID
      : data.startsWith(SEL.ch) ? CH_IPFS       // contenthash present …
      : data.startsWith(SEL.text) ? CC_MAINNET  // … and a contentcontract record too
      : null,
    ipfs: () => new Response('<h1>ipfs</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>ipfs</h1>');
  assert.equal(res.headers.get('x-ipfs-cid'), DONNOH_CID);
  assert.equal(res.headers.get('x-web3-contract'), null, 'never reached the web3 path');
});

test('5219 mode: serves the contract body and its own content-type', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, '<h1>on-chain</h1>', [
          ['Content-type', 'text/html; charset=utf-8'],
          ['Cache-control', 'public, max-age=31536000, immutable'],
        ])
      : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>on-chain</h1>');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(res.headers.get('x-web3-contract'), `eth:${ROCK}`);
  assert.equal(res.headers.get('x-web3-resolve-mode'), '5219');
  assert.equal(res.headers.get('x-gwei-name'), 'rock.gwei');
  for (const [k, v] of SEC_HEADERS) assert.equal(res.headers.get(k), v);
});

test('web3 cache entries follow the resolved contract when a name is repointed', async () => {
  const cache = makeCache();
  let contentcontract = CC_MAINNET;
  const fetchMock = makeFetch({
    rpc: (data, _url, to) => data.startsWith(SEL.id) ? TOKEN_ID
      : data.startsWith(SEL.ch) ? CH_NONE
      : data.startsWith(SEL.text) ? contentcontract
      : data.startsWith(SEL.mode) ? MODE_5219
      : data.startsWith(SEL.request)
        ? abiRequestResult(
            200,
            to.toLowerCase() === ROCK ? 'old contract' : 'new contract',
            [['Cache-control', 'public, max-age=31536000, immutable']],
          )
        : null,
  });

  await invoke('https://rock.gwei.domains/prime', { cache, fetchMock });
  cache.advance(250);
  const late = await invoke('https://rock.gwei.domains/late', { cache, fetchMock });
  assert.equal(await late.text(), 'old contract');

  // The /late response still has 249 seconds left, but the name resolution has now expired.
  contentcontract = CC_MAINNET_2;
  cache.advance(51);
  const repointed = await invoke('https://rock.gwei.domains/late', { cache, fetchMock });
  assert.equal(await repointed.text(), 'new contract');
  assert.equal(repointed.headers.get('x-web3-contract'), `eth:${ROCK_2}`);
});

test('restrictive contract cache directives are preserved and skip the edge cache', async () => {
  const cache = makeCache();
  let resourceCalls = 0;
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => {
      if (!data.startsWith(SEL.request)) return null;
      resourceCalls++;
      return abiRequestResult(200, 'private', [['Cache-control', 'private, max-age=31536000, immutable']]);
    } }),
  });

  const first = await invoke('https://rock.gwei.domains/private', { cache, fetchMock });
  assert.equal(first.headers.get('cache-control'), 'private, max-age=300');
  await invoke('https://rock.gwei.domains/private', { cache, fetchMock });
  assert.equal(resourceCalls, 2, 'private responses are never stored in the shared edge cache');
});

test('5219 mode: path and query encode exactly as w3link sends them', async () => {
  const cache = makeCache();
  let seen = null;
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => {
      if (!data.startsWith(SEL.request)) return null;
      seen = data;
      return abiRequestResult(200, 'ok', [['Content-type', 'text/plain']]);
    } }),
  });
  await invoke('https://rock.gwei.domains/foo/bar?page=1', { cache, fetchMock });
  // Captured from `curl -I https://<rock>.1.w3link.io/foo/bar?page=1` (its web3-calldata header).
  const W3LINK = '0x1374c460' +
    pad32('40') + pad32('120') +
    pad32('2') + pad32('40') + pad32('80') +
    pad32('3') + toHex(utf8('foo')).padEnd(64, '0') +
    pad32('3') + toHex(utf8('bar')).padEnd(64, '0') +
    pad32('1') + pad32('20') +
    pad32('40') + pad32('80') +
    pad32('4') + toHex(utf8('page')).padEnd(64, '0') +
    pad32('1') + toHex(utf8('1')).padEnd(64, '0');
  assert.equal(seen, W3LINK);
});

test('5219 mode: root path sends an empty resource array', async () => {
  const cache = makeCache();
  let seen = null;
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => {
      if (!data.startsWith(SEL.request)) return null;
      seen = data; return abiRequestResult(200, 'ok');
    } }),
  });
  await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(seen, '0x1374c460' + pad32('40') + pad32('60') + pad32('0') + pad32('0'));
});

test('5219 mode: binary bodies survive without UTF-8 mangling', async () => {
  const cache = makeCache();
  // A 1x1 GIF: has bytes that are invalid UTF-8, so any text round-trip would corrupt it.
  const gif = Uint8Array.from([0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0xff,0x00,0xc0,0xc0,0xc0]);
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, gif, [['Content-type', 'image/gif']]) : null }),
  });
  const res = await invoke('https://rock.gwei.domains/pixel.gif', { cache, fetchMock });
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), gif);
});

test('5219 mode: contract status codes and redirects pass through', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(302, '', [['Location', '/elsewhere']]) : null }),
  });
  const res = await invoke('https://rock.gwei.domains/old', { cache, fetchMock });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/elsewhere');
});

test('a contract cannot set set-cookie or weaken the security headers', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, 'hi', [
          ['Set-cookie', 'session=stolen'],
          ['X-frame-options', 'ALLOWALL'],
          ['Access-control-allow-origin', 'https://evil.example'],
          ['Content-security-policy', "frame-ancestors *;"],
          ['Content-type', 'text/html'],
        ])
      : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.headers.get('set-cookie'), null, 'set-cookie is dropped entirely');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self';");
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('content-type'), 'text/html', 'but content-type is honoured');
});

test('malformed allowlisted header values become a controlled 502', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, 'bad', [['Content-type', 'text/html\r\nx-injected: yes']]) : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 502);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.match(await res.text(), /malformed HTTP headers/);
});

test('manual mode: raw path is the calldata, "/" at the root', async () => {
  const cache = makeCache();
  const seen = [];
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ mode: MODE_MANUAL, onCall: (data) => {
      seen.push(data); return abiBytesReturn('<h1>manual</h1>');
    } }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(await res.text(), '<h1>manual</h1>');
  assert.equal(seen[0], '0x2f', 'root sends "/" as calldata');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('x-web3-resolve-mode'), 'manual');

  const cache2 = makeCache();
  seen.length = 0;
  await invoke('https://rock.gwei.domains/a/b?c=d', { cache: cache2, fetchMock });
  assert.equal(seen[0], '0x' + toHex(utf8('/a/b?c=d')));
});

test('manual mode: MIME comes from the path extension', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ mode: MODE_MANUAL, onCall: () => abiBytesReturn('<svg/>') }),
  });
  const res = await invoke('https://rock.gwei.domains/logo.svg', { cache, fetchMock });
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
});

test('auto mode is reported as unsupported, not served', async () => {
  for (const mode of [MODE_AUTO, '0x' + pad32('0')]) {
    const cache = makeCache();
    const fetchMock = makeFetch({ rpc: rpcWeb3({ mode, onCall: () => 'SHOULD NOT BE CALLED' }) });
    const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
    assert.equal(res.status, 415);
    assert.match(await res.text(), /resource-request/);
  }
});

test('chunked (web3-next-chunk) responses are refused rather than truncated', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, 'first half', [['web3-next-chunk', '/chunk/2']]) : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 501);
  assert.match(await res.text(), /chunks/);
});

test('resolveMode is cached: a second request skips the resolveMode call', async () => {
  const cache = makeCache();
  let modeCalls = 0;
  const inner = rpcWeb3({ onCall: (d) => d.startsWith(SEL.request) ? abiRequestResult(200, 'ok') : null });
  const fetchMock = makeFetch({
    rpc: (data) => { if (data.startsWith(SEL.mode)) modeCalls++; return inner(data); },
  });
  // Two different paths, so the content cache can't mask the effect — only the mode cache can.
  await invoke('https://rock.gwei.domains/one', { cache, fetchMock });
  assert.equal(modeCalls, 1);
  await invoke('https://rock.gwei.domains/two', { cache, fetchMock });
  assert.equal(modeCalls, 1, 'mode came from cache the second time');
});

test('bare address record resolves on mainnet (ERC-6821 default)', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ cc: CC_BARE, onCall: (data) => data.startsWith(SEL.request) ? abiRequestResult(200, 'ok') : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-web3-contract'), `eth:${ROCK}`);
});

test('sepolia record calls the sepolia RPC pool, not mainnet', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ cc: CC_SEPOLIA, onCall: (data) => data.startsWith(SEL.request) ? abiRequestResult(200, 'ok') : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-web3-contract'), `sep:${ROCK}`);
  assert.ok(fetchMock.calls.rpcUrls.some((u) => u.includes('sepolia')), 'used a sepolia endpoint');
});

test('custom RPC_URL is used for mainnet contract calls as well as name resolution', async () => {
  const cache = makeCache();
  const privateRpc = 'https://rpc.example.invalid/private';
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, 'private rpc') : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', {
    cache,
    fetchMock,
    env: { RPC_URL: privateRpc },
  });
  assert.equal(res.status, 200);
  assert.ok(fetchMock.calls.rpcUrls.length >= 5);
  assert.deepEqual([...new Set(fetchMock.calls.rpcUrls)], [privateRpc]);
});

test('oversized streamed RPC responses fail over before JSON buffering', async () => {
  const cache = makeCache();
  let oversizedCalls = 0;
  let fallbackCalls = 0;
  let sentOversized = false;
  const inner = rpcWeb3({
    onCall: (data) => data.startsWith(SEL.request) ? abiRequestResult(200, 'fallback') : null,
  });
  const fetchMock = makeFetch({
    rpc: (data) => {
      if (data.startsWith(SEL.request) && !sentOversized) {
        sentOversized = true;
        oversizedCalls++;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(RPC_RESPONSE_LIMIT));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (data.startsWith(SEL.request)) fallbackCalls++;
      return inner(data);
    },
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'fallback');
  assert.equal(oversizedCalls, 1);
  assert.equal(fallbackCalls, 1);
});

test('unknown chain or malformed address reads as no website, with no contract call', async () => {
  for (const cc of [CC_UNKNOWN_CHAIN, CC_MALFORMED, abiString('not a record')]) {
    const cache = makeCache();
    const fetchMock = makeFetch({ rpc: rpcWeb3({ cc, onCall: () => 'SHOULD NOT BE CALLED' }) });
    const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /has no website set/);
    assert.ok(!fetchMock.calls.rpcUrls.some((u) => u.includes('sepolia')));
  }
});

test('contentcontract lookup failure → 502 no-store, not a cached 404', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: (data) => data.startsWith(SEL.id) ? TOKEN_ID
      : data.startsWith(SEL.ch) ? CH_NONE
      : null, // every endpoint fails on the text() lookup
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 502);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(await cache.match(new Request('https://gwei-cache.internal/resolve/rock.gwei')), undefined);
});

test('web3 content is cached: a repeat GET makes no RPC calls at all', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request) ? abiRequestResult(200, 'cached') : null }),
  });
  await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  const after = fetchMock.calls.rpc;
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(await res.text(), 'cached');
  assert.equal(fetchMock.calls.rpc, after, 'served entirely from the content cache');
});

test('a malformed ERC-5219 return is reported, not served', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request) ? '0x' + pad32('c8') : null }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 502);
  assert.match(await res.text(), /malformed/);
});

test('contract status codes Response cannot represent become a 502, not a crash', async () => {
  for (const status of [100, 199, 600, 0]) {
    const cache = makeCache();
    const fetchMock = makeFetch({
      rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
        ? abiRequestResult(status, 'body', [['Content-type', 'text/html']]) : null }),
    });
    const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
    assert.equal(res.status, 502, `status ${status} should degrade to 502`);
  }
});

test('bodiless statuses are returned without a body', async () => {
  for (const status of [204, 205, 304]) {
    const cache = makeCache();
    const fetchMock = makeFetch({
      rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
        ? abiRequestResult(status, 'ignored') : null }),
    });
    const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
    assert.equal(res.status, status);
    assert.equal(await res.text(), '');
  }
});

// Header values are ByteStrings, so a decoded emoji name throws on the way out unless it's
// percent-encoded. The IPFS path already does this; the contract path needs it for the same reason,
// and nothing else here would catch it, since every other web3 test uses an ASCII name.
test('an emoji name is served from a contract, with its name header percent-encoded', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, '<h1>whale</h1>', [['content-type', 'text/html']]) : null }),
  });
  const res = await invoke('https://🐳.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>whale</h1>');
  assert.equal(decodeURIComponent(res.headers.get('x-gwei-name')), '🐳.gwei');
});

test('a cold request herd shares each identical RPC call through the broker', async () => {
  const cache = makeCache();
  const inner = rpcWeb3({
    onCall: (data) => data.startsWith(SEL.request) ? abiRequestResult(200, 'coalesced') : null,
  });
  const fetchMock = makeFetch({
    rpc: async (data) => {
      // Keep every stage in flight long enough for all requests to join it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return inner(data);
    },
  });
  const env = { RPC_BROKER: makeRpcBrokerNamespace(fetchMock, {}) };

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => invoke('https://rock.gwei.domains/', { cache, fetchMock, env })),
  );
  assert.deepEqual(responses.map((response) => response.status), Array(10).fill(200));
  assert.deepEqual(await Promise.all(responses.map((response) => response.text())), Array(10).fill('coalesced'));
  assert.equal(
    fetchMock.calls.rpc,
    5,
    'computeId, contenthash, text, resolveMode, and request each ran once for the whole herd',
  );
});

test('a full RPC broker queue sheds load as a retryable 503', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS) });
  const env = {
    RPC_BROKER: {
      getByName: () => ({ rpc: async () => ({ overloaded: true }) }),
    },
  };
  const res = await invoke('https://busy.gwei.domains/', { cache, fetchMock, env });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '2');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await cache.match(new Request('https://gwei-cache.internal/resolve/busy.gwei')), undefined);
});
