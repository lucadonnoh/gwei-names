// Extensive tests for the gwei.domains gateway Worker (caching + security headers + resolution).
// Run: `node --test worker.test.js` (Node 18+; uses global fetch/Request/Response/Headers).
//
// Strategy: import the real worker and drive it with a faithful Cache API mock and a fetch mock
// that intercepts RPC / IPFS / IPNS / reserved upstreams, counts calls, and records URLs — so we can
// assert cache hits skip upstreams, failures aren't cached, and the CID decode is byte-correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { checkEndpoints, nameTokenId } from './worker.js';
import { PROFILE_TEXT_KEYS, SITE_CHECK_SCRIPT } from './profile-page.js';
import { POST_CSP, REPLY_SCRIPT, REPLY_SCRIPT_HASH } from './post-page.js';
import { createHash } from 'node:crypto';
import {
  RPCS,
  RPC_PAGE_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  SEPOLIA_RPCS,
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
const NAMENFT = '0x9d51d507bc7264d4fe8ad1cf7fe191933a0a81d6';
function rpcWeb3({ cc = CC_MAINNET, mode = MODE_5219, onCall = () => null } = {}) {
  return (data, _url, to) => {
    if (to?.toLowerCase() === NAMENFT) {
      if (data.startsWith(SEL.id)) return TOKEN_ID;
      if (data.startsWith(SEL.ch)) return CH_NONE;
      if (data.startsWith(SEL.text)) return cc;
      return null; // the profile's records, which a website never reaches
    }
    if (data.startsWith(SEL.mode)) return mode;
    return onCall(data);
  };
}

// ---- faithful-ish Cache API mock --------------------------------------------
// `browserTtl` mimics a zone's Browser Cache TTL, which raises a lower max-age on what match() returns.
function makeCache({ browserTtl } = {}) {
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
      const headers = new Headers(e.headers);
      const maxAge = /max-age=(\d+)/.exec(headers.get('cache-control') || '');
      if (browserTtl && maxAge && Number(maxAge[1]) < browserTtl) headers.set('cache-control', `public, max-age=${browserTtl}`);
      return new Response(e.body, { status: e.status, headers });
    },
    async delete(req) {
      return store.delete(typeof req === 'string' ? req : req.url);
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
// The worker reads a name's records in one Multicall3 aggregate3 call. The mock unpacks it and asks
// the rpc handler about each call on its own, so handlers answer by selector either way.
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
function aggregate3Calls(data) {
  const hex = data.slice(10);
  const at = (byte) => parseInt(hex.slice(byte * 2, byte * 2 + 64), 16);
  const base = at(0) + 32;
  return Array.from({ length: at(at(0)) }, (_, i) => {
    const element = base + at(base + i * 32);
    const bytesAt = element + at(element + 64);
    return { target: '0x' + hex.slice(element * 2 + 24, element * 2 + 64), data: '0x' + hex.slice((bytesAt + 32) * 2, (bytesAt + 32 + at(bytesAt)) * 2) };
  });
}
function aggregate3Return(items) { // [success, bare hex][]
  const elements = items.map(([ok, data]) => {
    let padded = data; while (padded.length % 64) padded += '0';
    return pad32(ok ? '1' : '0') + pad32('40') + pad32((data.length / 2).toString(16)) + padded;
  });
  let cursor = items.length * 32;
  const offsets = elements.map((e) => { const o = pad32(cursor.toString(16)); cursor += e.length / 2; return o; });
  return '0x' + pad32('20') + pad32(items.length.toString(16)) + offsets.join('') + elements.join('');
}
async function answerRpc(handlers, data, url, to, init) {
  if (!handlers.rpc) return null;
  if (to?.toLowerCase() !== MULTICALL || !data.startsWith('0x82ad56cb')) return handlers.rpc(data, url, to, init);
  const answers = await Promise.all(aggregate3Calls(data).map((call) => handlers.rpc(call.data, url, call.target, init)));
  // A transport failure (a thrown request, an HTTP error) fails the whole call, as it would on the wire.
  const failed = answers.find((a) => a === 'THROW' || a instanceof Response);
  if (failed) return failed;
  return aggregate3Return(answers.map((a) => (typeof a === 'string' && a.startsWith('0x') ? [true, a.slice(2)] : [false, ''])));
}

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
      const result = await answerRpc(handlers, data, url, call.to, init);
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
async function invoke(urlStr, { method = 'GET', headers = {}, body, env = {}, cache, fetchMock } = {}) {
  const ctx = { _p: [], waitUntil(p) { this._p.push(Promise.resolve(p)); } };
  globalThis.caches = { default: cache };
  globalThis.fetch = fetchMock;
  if (!env.RPC_BROKER) env.RPC_BROKER = makeRpcBrokerNamespace(fetchMock, env);
  const res = await worker.fetch(new Request(urlStr, { method, headers, body }), env, ctx);
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

// computeId(name) on mainnet, which the worker computes itself rather than asking for.
const ON_CHAIN_IDS = {
  'donnoh.gwei': '4af9471d1f0ffa0a3f725e0f0932984bb35187d5da3e24a9a55c9754aa9c0a01',
  'Sub.Donnoh.GWEI': '0b1b9185866e2c594b02a5963cbbdc0cfb0d520e68d5aad3aa1b39e4dbd167f6',
  'alice.zkpassport.gwei': 'f8f50fd1d3f16c66f888490c3a555959f9d4e57e460bea92cba082f98395d933',
  '🐳.gwei': '637d65e04637f3878f890959a1ee0c76806b71b5846bbeedcd1ab577de619f5f',
  'sub.🐳.gwei': 'f490de5a25a9d88854c60d29b11e94abe23e9d15dd3fc05579863ee5603bc92e',
};

test('token ids are computed as NameNFT.computeId does, without an RPC call', async () => {
  for (const [name, id] of Object.entries(ON_CHAIN_IDS)) assert.equal(nameTokenId(name), id, name);
  assert.equal(nameTokenId('a..b.gwei'), null, 'computeId rejects empty labels');

  // For those the contract is still asked, so its revert keeps meaning a failed lookup.
  let asked;
  const fetchMock = makeFetch({ rpc: (data) => { if (data.startsWith(SEL.id)) asked = decodeStringCall(data); return null; } });
  const res = await invoke('https://a..b.gwei.domains/', { cache: makeCache(), fetchMock });
  assert.equal(asked, 'a..b.gwei');
  assert.equal(res.status, 502);
});

test('emoji hostname is decoded from Punycode before its token id is computed', async () => {
  const cache = makeCache();
  let tokenId;
  const fetchMock = makeFetch({
    rpc: (data) => {
      if (data.startsWith('0xcb323d76')) {
        tokenId = data.slice(10);
        return CH_IPFS;
      }
      return data.startsWith(SEL.text) ? TEXT_NONE : null;
    },
    ipfs: () => new Response('<h1>whale</h1>', { status: 200 }),
  });

  // Request/URL normalizes the Unicode hostname to xn--7o8h before the Worker sees it.
  const res = await invoke('https://🐳.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(tokenId, ON_CHAIN_IDS['🐳.gwei']);
  assert.equal(decodeURIComponent(res.headers.get('x-gwei-name')), '🐳.gwei');
  assert.equal(await res.text(), '<h1>whale</h1>');
});

test('Punycode is decoded label-by-label for nested gwei names', async () => {
  const cache = makeCache();
  let tokenId;
  const fetchMock = makeFetch({
    rpc: (data) => {
      if (data.startsWith('0xcb323d76')) {
        tokenId = data.slice(10);
        return CH_IPFS;
      }
      return data.startsWith(SEL.text) ? TEXT_NONE : null;
    },
  });

  const res = await invoke('https://sub.xn--7o8h.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(tokenId, ON_CHAIN_IDS['sub.🐳.gwei']);
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
    rpc: (data, url) => url.includes('drpc') ? 'THROW' : rpcReturning(CH_IPFS)(data),
    ipfs: () => new Response('ok', { status: 200 }),
  });
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.ok(fetchMock.calls.rpcUrls.some((u) => u.includes('drpc')), 'tried the down endpoint');
  assert.ok(fetchMock.calls.rpcUrls.some((u) => u.includes('blastapi')), 'failed over to the next');
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

test('gwei.limo serves the same name sites as gwei.domains', async () => {
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('<h1>donnoh</h1>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  const res = await invoke('https://donnoh.gwei.limo/', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>donnoh</h1>');
  assert.equal(res.headers.get('x-gwei-name'), 'donnoh.gwei');
  assert.equal(res.headers.get('x-ipfs-cid'), DONNOH_CID);
  assert.ok(res.headers.get('content-security-policy') || res.headers.get('x-frame-options'), 'hardened like any name site');

  const reserved = makeFetch({ reserved: () => new Response('railway-app', { status: 200 }) });
  assert.equal(await (await invoke('https://diff.gwei.limo/x', { cache: makeCache(), fetchMock: reserved })).text(), 'railway-app');
  assert.equal((await invoke('https://evil.gwei.limo.example/', { cache: makeCache(), fetchMock: makeFetch({}) })).status, 404);
});

test('the gwei.limo apex redirects to the dapp, keeping the path; its /api/ is not served', async () => {
  for (const [from, to] of [['https://gwei.limo/', 'https://gwei.domains/'], ['https://gwei.limo/guide/?x=1', 'https://gwei.domains/guide/?x=1'],
    ['https://gwei.limo/api/posts/recent', 'https://gwei.domains/api/posts/recent']]) {
    const fetchMock = makeFetch({});
    const res = await invoke(from, { cache: makeCache(), fetchMock });
    assert.equal(res.status, 302, from);
    assert.equal(res.headers.get('location'), to);
    assert.equal(fetchMock.calls.rpc, 0);
  }
});

test('/api/version reports the deployed commit, uncached, with or without posts', async () => {
  for (const env of [{ GIT_COMMIT: 'abc123' }, {}]) {
    const res = await invoke('https://gwei.domains/api/version', { cache: makeCache(), fetchMock: makeFetch({}), env });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { commit: env.GIT_COMMIT || null });
  }
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

const rpcRevert = () => new Response(
  JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
  { headers: { 'content-type': 'application/json' } },
);
const SEL_HTML = '0x33c34ac3';

test('auto mode: the root is a call with empty calldata, and its bytes are served', async () => {
  for (const mode of [MODE_AUTO, '0x' + pad32('0')]) {
    const cache = makeCache();
    const seen = [];
    const fetchMock = makeFetch({
      rpc: rpcWeb3({ mode, onCall: (data) => { seen.push(data); return abiBytesReturn('<!doctype html><h1>auto</h1>'); } }),
    });
    const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<!doctype html><h1>auto</h1>');
    assert.deepEqual(seen, ['0x']);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', 'undefined MIME is sniffed');
    assert.equal(res.headers.get('x-web3-resolve-mode'), 'auto');
    assert.equal(res.headers.get('x-web3-auto-fallback'), null);
  }
});

test('auto mode: a root that reverts falls back to html() (privacypools.gwei)', async () => {
  const cache = makeCache();
  const seen = [];
  const page = '<!doctype html>\n<title>Privacy Pools v2</title>' + 'x'.repeat(5000);
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ mode: MODE_AUTO, onCall: (data) => {
      seen.push(data);
      return data === SEL_HTML ? abiBytesReturn(page) : rpcRevert();
    } }),
  });
  const res = await invoke('https://rock.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), page);
  assert.deepEqual(seen, ['0x', SEL_HTML]);
  assert.equal(res.headers.get('x-web3-auto-fallback'), 'html()');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');

  // The page itself stays reachable at its ERC-6860 path.
  const direct = await invoke('https://rock.gwei.domains/html', { cache: makeCache(), fetchMock });
  assert.equal(await direct.text(), page);
  assert.equal(direct.headers.get('x-web3-auto-fallback'), null);
});

test('auto mode: a root with no page and no html() is a 404', async () => {
  const fetchMock = makeFetch({ rpc: rpcWeb3({ mode: MODE_AUTO, onCall: () => rpcRevert() }) });
  const res = await invoke('https://rock.gwei.domains/', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /serves no page at its root/);
});

test('auto mode: methods and arguments become an ABI call; MIME follows the last string argument', async () => {
  const seen = [];
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ mode: MODE_AUTO, onCall: (data) => { seen.push(data); return abiBytesReturn('<svg/>'); } }),
  });
  const res = await invoke('https://rock.gwei.domains/file/string!logo.svg', { cache: makeCache(), fetchMock });
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  // file(string) = 0x69930d06, then offset 0x20 and the string tail.
  assert.equal(seen[0], '0x69930d06' + pad32('20') + pad32('8') + toHex(utf8('logo.svg')).padEnd(64, '0'));

  seen.length = 0;
  await invoke('https://rock.gwei.domains/renderBroker/9999', { cache: makeCache(), fetchMock });
  assert.equal(seen[0], '0x7ccdcaa1' + pad32('270f'));
});

test('auto mode: returns gives JSON, and mime.* sets the content type', async () => {
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ mode: MODE_AUTO, onCall: (data) => {
      if (data.startsWith('0x70a08231')) return '0x' + pad32('2a'); // balanceOf(address)
      if (data.startsWith('0xc87b56dd')) return abiBytesReturn('data:application/json,%7B%22a%22%3A1%7D'); // tokenURI(uint256)
      return abiBytesReturn('<svg/>');
    } }),
  });
  const owner = '0x00000000000000000000000000000000DeaDBeef';
  let res = await invoke(`https://rock.gwei.domains/balanceOf/${owner}?returns=(uint256)`, { cache: makeCache(), fetchMock });
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(await res.text(), '["0x2a"]');

  res = await invoke(`https://rock.gwei.domains/balanceOf/${owner}?returns=()`, { cache: makeCache(), fetchMock });
  assert.equal(await res.text(), `["0x${pad32('2a')}"]`);

  res = await invoke('https://rock.gwei.domains/image/1?mime.content=image/svg%2Bxml', { cache: makeCache(), fetchMock });
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  res = await invoke('https://rock.gwei.domains/image/1?mime.type=svg', { cache: makeCache(), fetchMock });
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  res = await invoke('https://rock.gwei.domains/image/1?mime.content=bogus', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 400);

  res = await invoke('https://rock.gwei.domains/tokenURI/1?mime.dataurl', { cache: makeCache(), fetchMock });
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(await res.text(), '{"a":1}');
});

test('auto mode: bad paths are rejected without calling the contract, and reverts are 404s', async () => {
  const seen = [];
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ mode: MODE_AUTO, onCall: (data) => { seen.push(data); return rpcRevert(); } }),
  });
  let res = await invoke('https://rock.gwei.domains/favicon.ico', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 404);
  res = await invoke('https://rock.gwei.domains/balanceOf/vitalik.eth', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Name-service arguments/);
  assert.deepEqual(seen, [], 'neither request reached the contract');

  res = await invoke('https://rock.gwei.domains/missing', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /call reverted/);
});

test('modes other than auto, manual and 5219 are reported as unsupported', async () => {
  const fetchMock = makeFetch({ rpc: rpcWeb3({ mode: modeWord('bogus'), onCall: () => 'SHOULD NOT BE CALLED' }) });
  const res = await invoke('https://rock.gwei.domains/', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 415);
  assert.match(await res.text(), /auto, manual, and resource-request/);
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
    rpc: (data, url, to) => { if (data.startsWith(SEL.mode)) modeCalls++; return inner(data, url, to); },
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
  assert.ok(fetchMock.calls.rpcUrls.length >= 3, 'records, resolveMode, request');
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
    rpc: (data, url, to) => {
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
      return inner(data, url, to);
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

test('cache hits are served with the cache-control they were stored for, not the zone\'s', async () => {
  // gwei.limo's zone raises a hit's max-age to its 4-hour Browser Cache TTL.
  const cache = makeCache({ browserTtl: 14400 });
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ onCall: (data) => data.startsWith(SEL.request)
      ? abiRequestResult(200, 'on-chain', [['Cache-control', 'public, max-age=60, must-revalidate']]) : null }),
  });
  const first = await invoke('https://rock.gwei.limo/', { cache, fetchMock });
  assert.equal(first.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
  const after = fetchMock.calls.rpc;
  const hit = await invoke('https://rock.gwei.limo/', { cache, fetchMock });
  assert.equal(fetchMock.calls.rpc, after, 'served from the content cache');
  assert.equal(await hit.text(), 'on-chain');
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
  assert.equal(hit.headers.get('x-gwei-cache-control'), null, 'the stored value stays internal');

  for (const [fixture, path] of [[CH_IPNS_SHA256, '/ipns/'], [CH_SWARM, '/bzz/'], [CH_IPFS, '/ipfs/']]) {
    const storage = makeFetch({ rpc: rpcReturning(fixture) });
    const zoneCache = makeCache({ browserTtl: 14400 });
    await invoke('https://site.gwei.limo/', { cache: zoneCache, fetchMock: storage });
    const cached = await invoke('https://site.gwei.limo/', { cache: zoneCache, fetchMock: storage });
    assert.equal(cached.headers.get('cache-control'), 'public, max-age=300', path);
  }
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
    rpc: async (data, url, to) => {
      // Keep every stage in flight long enough for all requests to join it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return inner(data, url, to);
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
    3,
    'the records multicall, resolveMode, and request each ran once for the whole herd',
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

test('configured IPFS gateway applies to every name and overrides transport CSP at the site origin', async () => {
  const env={IPFS_GATEWAYS:'["https://node.example","https://backup.example"]'};
  for (const name of ['alpha','beta']) {
    const fetchMock=makeFetch({rpc:rpcReturning(CH_IPFS),ipfs:()=>new Response('<h1>shared policy</h1>',{headers:{'content-security-policy':"sandbox; default-src 'none'",'content-type':'text/html'}})});
    const res=await invoke(`https://${name}.gwei.domains/`,{cache:makeCache(),fetchMock,env:{...env}});
    assert.equal(res.status,200);
    assert.ok(fetchMock.calls.ipfsUrls[0].startsWith('https://node.example/ipfs/'));
    assert.equal(res.headers.get('content-security-policy'),"frame-ancestors 'self';");
    assert.equal(res.headers.get('x-gwei-name'),`${name}.gwei`);
  }
});

test('immutable IPFS cache survives upstream outages while name changes select a new CID',async()=>{
 const cache=makeCache();let failing=false,changed=false;
 const replacement=CH_IPFS.replace(DONNOH_CH.slice(-8),DONNOH_CH.slice(-8)==='00000000'?'00000001':'00000000');
 const fetchMock=makeFetch({rpc:(...args)=>rpcReturning(changed?replacement:CH_IPFS)(...args),ipfs:()=>new Response(failing?'offline':'immutable content',{status:failing?503:200})});
 const env={IPFS_GATEWAYS:'["https://cache-test.example"]'};
 const first=await invoke('https://cached.gwei.domains/',{cache,fetchMock,env:{...env}});
 assert.equal(first.headers.get('cache-control'),'public, max-age=300');
 const entry=[...cache._store.entries()].find(([key])=>key.includes('/content/'))[1];
 assert.equal(entry.headers['cache-control'],'public, max-age=86400, immutable');
 cache.advance(3600);failing=true;
 const cached=await invoke('https://cached.gwei.domains/',{cache,fetchMock,env:{...env}});
 assert.equal(await cached.text(),'immutable content');assert.equal(fetchMock.calls.ipfs,1);
 assert.equal(cached.headers.get('cache-control'),'public, max-age=300');
 cache.advance(301);changed=true;
 const updated=await invoke('https://cached.gwei.domains/',{cache,fetchMock,env:{...env}});
 assert.equal(updated.status,504,'must not serve old CID after the name record changes');
});

// ---- QOL: redirects, 404s, self-retrying errors, registration hint, last known site, health ------

test('plain HTTP is redirected to HTTPS, path and query kept', async () => {
  const fetchMock = makeFetch({ rpc: () => 'SHOULD NOT BE CALLED' });
  const res = await invoke('http://donnoh.gwei.domains/a/b?c=1', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://donnoh.gwei.domains/a/b?c=1');
  assert.equal(fetchMock.calls.rpc, 0);
});

test('a page missing from the site is a 404, not the outage page', async () => {
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('no link named "nope"', { status: 404 }) });
  const res = await invoke('https://donnoh.gwei.domains/nope', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /doesn't exist on <b>donnoh\.gwei<\/b>/);
});

test('transient error pages retry themselves and are never cached', async () => {
  const fetchMock = makeFetch({ rpc: () => null }); // every endpoint answers garbage → RPC failure
  const res = await invoke('https://donnoh.gwei.domains/', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 502);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(res.headers.get('retry-after'), '2');
  const html = await res.text();
  assert.match(html, /Resolution failed \(RPC\)/);
  assert.match(html, /location\.reload\(\)/);
  assert.match(html, /t\.length>=3/, 'bounded to three retries a minute');

  const down = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('x', { status: 502 }) });
  const fetchFailed = await invoke('https://donnoh.gwei.domains/', { cache: makeCache(), fetchMock: down });
  assert.equal(fetchFailed.status, 504);
  assert.match(await fetchFailed.text(), /location\.reload\(\)/);
});

// A name without a website: resolve, ownerOf, expiresAt, its text records, and isAvailable / getFee /
// getPremium (what registering it would cost), each answered by selector.
const ABI_EMPTY_STRING = '0x' + pad32('20') + pad32('0');
const textKey = (data) => decodeStringCall('0x00000000' + data.slice(74)); // text(uint256 id, string key)
const rpcProfile = ({ address = '0', owner = address, expires = '0', text = {}, available = '0', fee = '1c6bf52634000', premium = '0' } = {}) => (data) => {
  if (data.startsWith(SEL.text)) return PROFILE_TEXT_KEYS.includes(textKey(data)) ? abiString(text[textKey(data)] || '') : TEXT_NONE;
  const word = { '0x4f896d4f': address, '0x6352211e': owner, '0x17c95709': expires, '0x8f8dc386': available, '0xfcee45f4': fee, '0x1bf1fffb': premium }[data.slice(0, 10)];
  if (word !== undefined) return '0x' + pad32(word);
  return data.startsWith('0x9af8b7aa') ? ABI_EMPTY_STRING // reverseResolve: no primary name
    : rpcReturning(CH_NONE)(data);
};

test('an unregistered name gets a register page; a registered one without a site gets its profile', async () => {
  let res = await invoke('https://nobody.gwei.domains/', { cache: makeCache(), fetchMock: makeFetch({ rpc: rpcProfile({ address: '0' }) }) });
  assert.equal(res.status, 200, 'link previews are only made for pages that answer 200');
  let html = await res.text();
  assert.match(html, /isn't registered, or has expired/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /href="https:\/\/gwei\.domains\/#nobody">Register it/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);

  const fetchMock = makeFetch({ rpc: rpcProfile({ address: 'a11ce', owner: 'b0b', expires: (1877108399).toString(16),
    text: { description: 'builds <things>', 'com.twitter': 'alice' } }) });
  res = await invoke('https://alice.gwei.domains/', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 200);
  html = await res.text();
  assert.match(html, /<div class="name">alice\.gwei<\/div>/);
  assert.match(html, /builds &lt;things&gt;/);
  assert.match(html, /href="https:\/\/x\.com\/alice"/);
  assert.match(html, /<meta property="og:url" content="https:\/\/alice\.gwei\.domains\/">/);
  assert.match(res.headers.get('content-security-policy'), /script-src|default-src 'none'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-eval|script-src 'unsafe-inline'/);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(fetchMock.calls.rpcUrls.length, 2, 'one multicall for every record, then the primary name');

  res = await invoke('https://alice.gwei.domains/favicon.ico', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 404, 'other paths are not the profile');
  assert.match(await res.text(), /doesn't exist on <b>alice\.gwei<\/b>/);

  res = await invoke('https://xn--ls8h.gwei.domains/', { cache: makeCache(), fetchMock: makeFetch({ rpc: rpcProfile({ address: '0' }) }) });
  assert.match(await res.text(), /href="https:\/\/gwei\.domains\/#%F0%9F%92%A9">Register it/);
});

test('a website that doesn’t load shows its profile instead of a dead end, then opens once it is back', async () => {
  let up = false;
  const records = rpcProfile({ address: 'a11ce', owner: 'b0b', expires: (1877108399).toString(16), text: { description: 'builds things' } });
  const fetchMock = makeFetch({
    rpc: (data) => (data.startsWith(SEL.ch) ? rpcReturning(CH_IPFS)(data) : records(data)),
    ipfs: () => (up ? new Response('<h1>the site</h1>', { headers: { 'content-type': 'text/html' } }) : new Response('x', { status: 504 })),
  });
  const cache = makeCache();
  let res = await invoke('https://alice.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('retry-after'), '10');
  assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
  const html = await res.text();
  assert.match(html, /The website of <b>alice\.gwei<\/b> isn\u2019t loading right now, so here is its profile/);
  assert.match(html, /builds things/);
  assert.match(html, /Websites on IPFS load while some node keeps a copy online/);
  assert.ok(html.includes(`<script>${SITE_CHECK_SCRIPT}</script>`), 'it checks for the site by itself');
  assert.doesNotMatch(html, /This is the default page/);

  res = await invoke('https://alice.gwei.domains/about.html', { cache, fetchMock });
  assert.equal(res.status, 504, 'other paths keep the retrying error page');

  up = true;
  res = await invoke('https://alice.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>the site</h1>');
});

test('when a fresh lookup fails, the last known site is served', async () => {
  const cache = makeCache();
  let rpcUp = true;
  const fetchMock = makeFetch({
    rpc: (data) => (rpcUp ? rpcReturning(CH_IPFS)(data) : null),
    ipfs: () => new Response('<h1>donnoh</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal((await invoke('https://donnoh.gwei.domains/', { cache, fetchMock })).status, 200);

  rpcUp = false;
  cache.advance(3600); // past the 5-minute resolution entry, within the 7-day last-known entry
  const res = await invoke('https://donnoh.gwei.domains/other', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>donnoh</h1>');
  assert.ok(fetchMock.calls.ipfsUrls.at(-1).includes(DONNOH_CID));

  cache.advance(8 * 86400); // past the last-known entry too
  assert.equal((await invoke('https://donnoh.gwei.domains/', { cache, fetchMock })).status, 502);
});

test('once a lookup says the website is gone, an outage does not bring the old site back', async () => {
  const cache = makeCache();
  let state = 'site';
  const fetchMock = makeFetch({
    rpc: (data) => (state === 'down' ? null : rpcReturning(state === 'site' ? CH_IPFS : CH_NONE)(data)),
    ipfs: () => new Response('<h1>previous owner</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal((await invoke('https://donnoh.gwei.domains/', { cache, fetchMock })).status, 200);
  state = 'gone'; // expired, re-registered or cleared: the chain now says there is no website
  cache.advance(301);
  const gone = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.notEqual(await gone.text(), '<h1>previous owner</h1>');
  state = 'down';
  cache.advance(61);
  const res = await invoke('https://donnoh.gwei.domains/', { cache, fetchMock });
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /previous owner/);
});

test('the daily health check reports each endpoint that no longer answers', async () => {
  const original = globalThis.fetch;
  const logged = [];
  const originalError = console.error;
  console.error = (line) => logged.push(line);
  globalThis.fetch = async (url) => {
    if (url.includes('blastapi')) return new Response('{"error":"rate limit exceeded"}', { status: 429 });
    if (url.includes('dweb.link')) throw new Error('connection reset');
    if (url.includes('/ipfs/bafkqaaa')) return new Response('');
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1909b77"}');
  };
  try {
    const summary = await checkEndpoints({ IPFS_GATEWAYS: '["https://node.example","https://dweb.link"]' });
    assert.deepEqual(summary.failures, ['eth-mainnet.public.blastapi.io: HTTP 429', 'dweb.link: connection reset']);
    assert.equal(summary.checked, RPCS.length + SEPOLIA_RPCS.length + 2);
    assert.match(logged[0], /endpoint_health/);
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
});

// ---- own RPC: the token stays with RPC_URL ---------------------------------------------------------

test('RPC_TOKEN is sent as a Bearer token to RPC_URL and never to the public endpoints', async () => {
  const privateRpc = 'https://rpc.example.invalid/';
  const seen = [];
  const fetchMock = makeFetch({
    rpc: (data, url, to, init) => {
      seen.push([url, init.headers.authorization ?? null]);
      // The own node is down for the contenthash call, so that call falls back to the public pool.
      if (url === privateRpc && data.startsWith(SEL.ch)) return new Response('down', { status: 503 });
      return rpcReturning(CH_IPFS)(data);
    },
    ipfs: () => new Response('ok', { status: 200 }),
  });
  const res = await invoke('https://donnoh.gwei.domains/', {
    cache: makeCache(), fetchMock, env: { RPC_URL: privateRpc, RPC_TOKEN: ' s3cret ' },
  });
  assert.equal(res.status, 200);
  assert.ok(seen.some(([url]) => url !== privateRpc), 'fell back to a public endpoint');
  for (const [url, auth] of seen) {
    assert.equal(auth, url === privateRpc ? 'Bearer s3cret' : null, url);
  }
});

test('an endpoint that caps result size is skipped for that call but not benched', async () => {
  const privateRpc = 'https://rpc.example.invalid/';
  const tooLarge = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000,
    message: 'call returned result on length 1293056 exceeding --rpc.returndata.limit 1048576' } }),
  { headers: { 'content-type': 'application/json' } });
  const urls = [];
  const fetchMock = makeFetch({
    rpc: rpcWeb3({ mode: MODE_AUTO, onCall: (data) => abiBytesReturn('<!doctype html>big') }),
  });
  const wrapped = async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (body.includes('eth_call')) {
      const url = typeof input === 'string' ? input : input.url;
      urls.push(url);
      if (url === privateRpc && body.includes('"0x"')) return tooLarge();
    }
    return fetchMock(input, init);
  };
  wrapped.calls = fetchMock.calls;
  const env = { RPC_URL: privateRpc };
  const res = await invoke('https://rock.gwei.domains/', { cache: makeCache(), fetchMock: wrapped, env });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<!doctype html>big');
  const pageCall = urls.lastIndexOf(privateRpc);
  assert.ok(urls.slice(pageCall + 1).some((u) => u !== privateRpc), 'the oversized call moved to a public endpoint');

  urls.length = 0;
  await invoke('https://rock.gwei.domains/', { cache: makeCache(), fetchMock: wrapped, env });
  assert.equal(urls[0], privateRpc, 'the own node is still tried first afterwards');
});

test('the health check authenticates to RPC_URL only', async () => {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push([url, init.headers?.authorization ?? null]);
    if (url.includes('/ipfs/bafkqaaa')) return new Response('');
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
  };
  try {
    const summary = await checkEndpoints({ RPC_URL: 'https://rpc.example.invalid/', RPC_TOKEN: 't0k', IPFS_GATEWAYS: '["https://node.example"]' });
    assert.deepEqual(summary.failures, []);
    for (const [url, auth] of sent) assert.equal(auth, url === 'https://rpc.example.invalid/' ? 'Bearer t0k' : null, url);
    assert.ok(sent.some(([url]) => url === 'https://rpc.example.invalid/'));
  } finally {
    globalThis.fetch = original;
  }
});

test('health-check failures are pushed to ntfy when configured, and only then', async () => {
  const original = globalThis.fetch;
  const posts = [];
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async (url, init = {}) => {
    if (url.startsWith('https://ntfy.example/')) {
      posts.push({ url, headers: init.headers, body: init.body });
      return new Response('{}', { status: 200 });
    }
    if (url.includes('blastapi')) return new Response('rate limited', { status: 429 });
    if (url.includes('/ipfs/bafkqaaa')) return new Response('');
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
  };
  try {
    const ntfy = { NTFY_URL: 'https://ntfy.example/homelab', NTFY_TOKEN: 'tk_test', IPFS_GATEWAYS: '["https://node.example"]' };
    const summary = await checkEndpoints(ntfy);
    assert.equal(summary.notified, 200);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].headers.authorization, 'Bearer tk_test');
    assert.match(posts[0].headers.title, /endpoint check failed/);
    assert.match(posts[0].headers['user-agent'], /gwei-gateway/);
    assert.match(posts[0].body, /eth-mainnet\.public\.blastapi\.io: HTTP 429/);

    posts.length = 0;
    await checkEndpoints({ IPFS_GATEWAYS: '["https://node.example"]' }); // not configured
    assert.equal(posts.length, 0);
    globalThis.fetch = async (url) => (url.startsWith('https://ntfy.example/')
      ? (posts.push(url), new Response('{}'))
      : url.includes('/ipfs/') ? new Response('') : new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}'));
    const healthy = await checkEndpoints(ntfy);
    assert.deepEqual(healthy.failures, []);
    assert.equal(posts.length, 0, 'nothing is sent when everything answers');
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
});

test('an NFT avatar is resolved through tokenURI and its metadata', async () => {
  const NFTC = '0xaa6612f03443517ced2bdcf27958c22353ceeab9';
  const metadata = 'data:application/json;base64,' + Buffer.from(JSON.stringify({ name: 'x', image: 'ipfs://bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644/7.png' })).toString('base64');
  const strTail = (v) => { let d = toHex(utf8(v)); while (d.length % 64) d += '0'; return '0x' + pad32('20') + pad32(utf8(v).length.toString(16)) + d; };
  const rpc = (data, url, to) => {
    if (to?.toLowerCase() === NFTC && data.startsWith('0xc87b56dd')) return strTail(metadata);
    return rpcProfile({ address: 'a11ce', text: { avatar: `eip155:1/erc721:${NFTC}/8977` } })(data, url, to);
  };
  const res = await invoke('https://geek.gwei.domains/', { cache: makeCache(), fetchMock: makeFetch({ rpc }) });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<img class="avatar" src="https:\/\/ipfs\.filebase\.io\/ipfs\/bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644\/7\.png"/);

  // A token whose tokenURI reverts just has no avatar.
  const broken = (data, url, to) => (to?.toLowerCase() === NFTC ? null : rpc(data, url, to));
  const plain = await invoke('https://geek.gwei.domains/', { cache: makeCache(), fetchMock: makeFetch({ rpc: broken }) });
  assert.equal(plain.status, 200);
  const plainHtml = await plain.text();
  assert.doesNotMatch(plainHtml, /<img class="avatar"/);
  assert.match(plainHtml, /<svg class="avatar"/, 'falls back to the generated avatar');
});

test('profiles: primary-name badge, the preview card, and the generated avatar PNG', async () => {
  const strTail = (v) => { let d = toHex(utf8(v)); while (d.length % 64) d += '0'; return '0x' + pad32('20') + pad32(utf8(v).length.toString(16)) + d; };
  const rpc = (data, url, to) => (data.startsWith('0x9af8b7aa') ? strTail('Alice.gwei') : rpcProfile({ address: 'a11ce' })(data, url, to));
  const fetchMock = makeFetch({ rpc });
  const cache = makeCache();
  let res = await invoke('https://alice.gwei.domains/', { cache, fetchMock });
  const html = await res.text();
  assert.match(html, /<span class="badge">Primary name<\/span>/);
  assert.match(html, /<svg class="avatar"/);
  assert.match(html, /og:image" content="https:\/\/alice\.gwei\.domains\/\.well-known\/gwei-card\.png\?v=[0-9a-f]{8}"/);
  assert.match(html, /<link rel="icon" type="image\/png" href="\/\.well-known\/gwei-avatar\.png">/, 'the generated PNG is still the favicon');
  assert.match(html, /href="https:\/\/x\.com\/intent\/post\?text=alice\.gwei&amp;url=https%3A%2F%2Falice\.gwei\.domains%2F"/);

  res = await invoke('https://alice.gwei.domains/.well-known/gwei-avatar.png', { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const png = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  // Not a profile (no records answer): the avatar path is just a missing page.
  res = await invoke('https://nobody.gwei.domains/.well-known/gwei-avatar.png', { cache: makeCache(), fetchMock: makeFetch({ rpc: rpcProfile({ address: '0' }) }) });
  assert.equal(res.status, 404);
});

// ---- posts ----------------------------------------------------------------------------------
// A stand-in for the PostIndex Durable Object namespace with canned answers; the index itself is
// tested in posts.test.js. `calls` records every method call.
const POST_A = { hash: '0x' + 'a1'.repeat(32), title: 'Exploring the blobspace', time: 1667844963,
  onchain: { blob: '0x01' + 'b1'.repeat(31), tx: '0x' + 'c1'.repeat(32), block: 26263300, time: 1792850000, publisher: '0x' + '9b'.repeat(20) } };
const POST_B = { hash: '0x' + 'a2'.repeat(32), title: 'Pending <one>', time: 1700000000, onchain: null };
const BODIES = { [POST_A.hash]: '## Hello\n\nSome **math**: $y_0$.', [POST_B.hash]: 'pending body' };
const REPLIES_A = { room: '0x' + 'ee'.repeat(20), replies: [
  { tx: '0x' + 'd1'.repeat(32), block: 26290000, time: 1792890000, from: '0x' + 'b0'.repeat(20), name: 'bob.gwei', system: 'gns', text: 'Great <post>\nsecond line' },
  { tx: '0x' + 'd2'.repeat(32), block: 26290001, time: 1792890012, from: '0x' + 'c0'.repeat(20), name: null, system: null, text: 'anon here' },
  { tx: '0x' + 'd3'.repeat(32), block: 26290002, time: 1792890024, from: '0x' + 'c1'.repeat(20), name: 'sub.team.gwei', system: 'gns', text: 'from a subname' },
  { tx: '0x' + 'd4'.repeat(32), block: 26290003, time: 1792890036, from: '0x' + 'c2'.repeat(20), name: 'carol.wei', system: 'wns', text: 'from wns' },
  { tx: '0x' + 'd5'.repeat(32), block: 26290004, time: 1792890048, from: '0x' + 'c3'.repeat(20), name: 'dave.eth', system: 'ens', text: 'from ens' },
  { tx: '0x' + 'd6'.repeat(32), block: 26290005, time: null, from: '0x' + 'c4'.repeat(20), name: '🦄.gwei', system: 'gns', text: 'time not looked up yet' },
] };
function fakePostIndex({ posts = [POST_A, POST_B], fail = false, postReplies } = {}) {
  const calls = [];
  const answer = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    if (fail) throw new Error('index down');
    return typeof value === 'function' ? value(...args) : value;
  };
  const stub = {
    forToken: answer('forToken', posts),
    postForToken: answer('postForToken', (token, owner, prefix) => {
      const p = posts.find((x) => x.hash.slice(2, 14) === prefix);
      return p ? { ...p, body: BODIES[p.hash], ...(postReplies === false ? { replies: false } : {}) } : null;
    }),
    bodies: answer('bodies', (hashes) => hashes.map((h) => BODIES[h] ?? null)),
    upload: answer('upload', (bytes) => (bytes.length ? { hash: '0x' + 'd1'.repeat(32) } : { status: 400, error: 'Not a v1 post.' })),
    detail: answer('detail', (hash) => (hash === POST_A.hash ? { hash, title: POST_A.title, body: BODIES[hash] } : null)),
    raw: answer('raw', (hash) => (hash === POST_A.hash ? utf8('{"v":1}') : null)),
    blobBytes: answer('blobBytes', (vh) => (vh === POST_A.onchain.blob ? new Uint8Array([1, 2, 3]) : null)),
    recent: answer('recent', [{ name: 'alice.gwei', ...POST_A }]),
    replies: answer('replies', (hash) => (hash === POST_A.hash ? REPLIES_A : { room: '0x' + 'ef'.repeat(20), replies: [] })),
    archive: answer('archive', (after) => ({ posts: after ? [] : [{ seq: 1, ...POST_A }], next: after || 1 })),
    forCurrentOwner: answer('forCurrentOwner', posts),
    paidBy: answer('paidBy', [{ hash: POST_A.hash, blob: POST_A.onchain.blob, publisher: '0x' + '9b'.repeat(20), token: TOKEN_HEX, block: 5, title: POST_A.title }]),
    poke: answer('poke', { throttled: true }),
    sync: answer('sync', { events: 2, blobs: 1 }),
    networkStats: answer('networkStats', { ready: true, block: 26270000, names: 4382, subdomains: 120, burnedWei: '1500000000000000000', lengths: { 3: 10 }, sites: ['donnoh'] }),
  };
  return { calls, getByName: (name) => { calls.push(['getByName', name]); return stub; } };
}
test('/api/posts lists the archive for mirrors, from a cursor, with a bounded page', async () => {
  const POST_INDEX = fakePostIndex();
  const api = (path) => invoke('https://gwei.domains' + path, { cache: makeCache(), fetchMock: makeFetch({}), env: { POST_INDEX } });
  let res = await api('/api/posts');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=30');
  assert.deepEqual(await res.json(), { posts: [{ seq: 1, ...POST_A }], next: 1 });
  res = await api('/api/posts?after=1&limit=5000');
  assert.deepEqual(await res.json(), { posts: [], next: 1 });
  await api('/api/posts?after=-4&limit=0');
  assert.deepEqual(POST_INDEX.calls.filter((c) => c[0] === 'archive'), [['archive', 0, 100], ['archive', 1, 200], ['archive', 0, 100]]);
});

test('/api/stats serves the network stats from the index, cached for a minute', async () => {
  const POST_INDEX = fakePostIndex();
  const res = await invoke('https://gwei.domains/api/stats', { cache: makeCache(), fetchMock: makeFetch({}), env: { POST_INDEX } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.names, 4382);
  assert.deepEqual(body.sites, ['donnoh']);
  assert.ok(POST_INDEX.calls.some(([name]) => name === 'networkStats'));
});

const aliceProfile = (text = {}) => makeFetch({ rpc: rpcProfile({ address: 'a11ce', owner: 'b0b', expires: (1877108399).toString(16), text }) });
const TOKEN_HEX = '0x9e0f6f68e7256d6a947a0578c7e746a0ff47e3b83c72fca64c940351d60da810'; // computeId('alice.gwei') on mainnet

test('a profile lists the owner’s posts, newest first, with a feed link', async () => {
  const POST_INDEX = fakePostIndex();
  const res = await invoke('https://alice.gwei.domains/', { cache: makeCache(), fetchMock: aliceProfile(), env: { POST_INDEX } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<div class="section">Posts<\/div>/);
  assert.match(html, /<a class="post-link" href="\/posts\/a1a1a1a1a1a1-exploring-the-blobspace"><span class="post-date">Nov 7, 2022<\/span><span class="post-name">Exploring the blobspace<\/span><\/a>/);
  assert.match(html, /<span class="post-name">Pending &lt;one&gt;<\/span><span class="badge">Publishing<\/span>/);
  assert.match(html, /<link rel="alternate" type="application\/atom\+xml" title="alice\.gwei" href="\/feed\.xml">/);
  assert.deepEqual(POST_INDEX.calls.find((c) => c[0] === 'forToken'), ['forToken', TOKEN_HEX, '0x' + pad32('b0b').slice(24), 50],
    'posts are read for the token and its current owner (ownerOf), not the resolved address');
});

test('a profile without posts has no posts section, and a broken index only drops the list', async () => {
  let res = await invoke('https://alice.gwei.domains/', { cache: makeCache(), fetchMock: aliceProfile(), env: { POST_INDEX: fakePostIndex({ posts: [] }) } });
  let html = await res.text();
  assert.doesNotMatch(html, /class="section">Posts/);
  assert.doesNotMatch(html, /feed\.xml/);
  res = await invoke('https://alice.gwei.domains/', { cache: makeCache(), fetchMock: aliceProfile(), env: { POST_INDEX: fakePostIndex({ fail: true }) } });
  assert.equal(res.status, 200);
  html = await res.text();
  assert.match(html, /<div class="name">alice\.gwei<\/div>/);
  assert.doesNotMatch(html, /class="section">Posts/);
});

test('a post page renders the body safely and shows where it lives on Ethereum', async () => {
  const POST_INDEX = fakePostIndex();
  let res = await invoke('https://alice.gwei.domains/posts/a1a1a1a1a1a1-whatever-slug', { cache: makeCache(), fetchMock: aliceProfile(), env: { POST_INDEX } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  let html = await res.text();
  assert.match(html, /<title>Exploring the blobspace · alice\.gwei<\/title>/);
  assert.match(html, /<h2 class="post-title">Exploring the blobspace<\/h2><div class="post-meta"><time datetime="2022-11-07">November 7, 2022<\/time><\/div>/);
  assert.match(html, /<div class="post-body"><h2 id="hello">Hello<\/h2><p>Some <strong>math<\/strong>: <math><msub><mi>y<\/mi><mn>0<\/mn><\/msub><\/math>\.<\/p><\/div>/);
  assert.match(html, /On Ethereum since block <a href="https:\/\/etherscan\.io\/block\/26263300">26263300<\/a>/);
  assert.match(html, /href="https:\/\/blobscan\.com\/blob\/0x01b1b1/);
  assert.match(html, /<meta property="og:type" content="article">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/alice\.gwei\.domains\/posts\/a1a1a1a1a1a1-exploring-the-blobspace">/);
  assert.deepEqual(POST_INDEX.calls.find((c) => c[0] === 'postForToken').slice(1), [TOKEN_HEX, '0x' + pad32('b0b').slice(24), 'a1a1a1a1a1a1']);

  res = await invoke('https://alice.gwei.domains/posts/a2a2a2a2a2a2', { cache: makeCache(), fetchMock: aliceProfile(), env: { POST_INDEX } });
  assert.match(await res.text(), /Authorized by the owner, waiting for its blob/);

  res = await invoke('https://alice.gwei.domains/posts/ffffffffffff-nope', { cache: makeCache(), fetchMock: aliceProfile(), env: { POST_INDEX } });
  assert.equal(res.status, 404);
});

test('the Atom feed carries rendered, escaped post bodies', async () => {
  const res = await invoke('https://alice.gwei.domains/feed.xml', { cache: makeCache(), fetchMock: aliceProfile(), env: { POST_INDEX: fakePostIndex() } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
  const xml = await res.text();
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?><feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"><title>alice\.gwei<\/title>/);
  assert.match(xml, /<entry><title>Exploring the blobspace<\/title><link href="https:\/\/alice\.gwei\.domains\/posts\/a1a1a1a1a1a1-exploring-the-blobspace"\/><id>urn:gwei-post:0xa1a1/);
  assert.match(xml, /<content type="html">&lt;h2 id=&quot;hello&quot;&gt;Hello&lt;\/h2&gt;/);
  assert.match(xml, /<title>Pending &lt;one&gt;<\/title>/);
});

test('posts only exist on profile pages: a name with a website serves its own /posts paths', async () => {
  const POST_INDEX = fakePostIndex();
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('site page', { status: 200 }) });
  const res = await invoke('https://donnoh.gwei.domains/posts/a1a1a1a1a1a1', { cache: makeCache(), fetchMock, env: { POST_INDEX } });
  assert.equal(await res.text(), 'site page');
  assert.equal(POST_INDEX.calls.length, 0);
});

test('the posts API: uploads, reads, CORS and sandboxing', async () => {
  const POST_INDEX = fakePostIndex();
  const env = { POST_INDEX };
  const fetchMock = makeFetch({});
  const api = (path, opts = {}) => invoke('https://gwei.domains' + path, { cache: makeCache(), fetchMock, env, ...opts });

  let res = await api('/api/posts', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);

  res = await api('/api/posts', { method: 'POST', body: '{"v":1,"title":"t","body":"b"}', headers: { 'cf-connecting-ip': '203.0.113.7' } });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { hash: '0x' + 'd1'.repeat(32) });
  const upload = POST_INDEX.calls.find((c) => c[0] === 'upload');
  assert.equal(new TextDecoder().decode(upload[1]), '{"v":1,"title":"t","body":"b"}');
  assert.equal(upload[2], '203.0.113.7');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  res = await api('/api/posts', { method: 'POST', body: '' });
  assert.equal(res.status, 400);
  res = await api('/api/posts', { method: 'POST', body: 'x'.repeat(130000) });
  assert.equal(res.status, 413);

  res = await api('/api/posts/preview', { method: 'POST', body: '{"v":1,"title":"T","body":"<b>hi</b> *there*"}' });
  assert.deepEqual(await res.json(), { title: 'T', html: '<p>&lt;b&gt;hi&lt;/b&gt; <em>there</em></p>' });
  res = await api('/api/posts/preview', { method: 'POST', body: 'nope' });
  assert.equal(res.status, 400);

  res = await api('/api/posts/' + POST_A.hash.toUpperCase().replace('0X', '0x'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).title, POST_A.title);
  res = await api('/api/posts/' + POST_B.hash);
  assert.equal(res.status, 404);

  res = await api(`/api/posts/${POST_A.hash}/raw`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(await res.text(), '{"v":1}');

  res = await api(`/api/blobs/${POST_A.onchain.blob}`);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');

  res = await api(`/api/names/${TOKEN_HEX}/posts`);
  assert.equal((await res.json()).posts.length, 2);
  res = await api('/api/authors/0x' + 'A1'.repeat(20) + '/paid');
  assert.equal((await res.json()).authorizations[0].blob, POST_A.onchain.blob);
  assert.deepEqual(POST_INDEX.calls.find((c) => c[0] === 'paidBy'), ['paidBy', '0x' + 'a1'.repeat(20), 100]);
  res = await api('/api/authors/0x1234/paid');
  assert.equal(res.status, 404);
  res = await api('/api/posts/recent?limit=500');
  assert.equal((await res.json()).posts[0].name, 'alice.gwei');
  assert.deepEqual(POST_INDEX.calls.find((c) => c[0] === 'recent'), ['recent', 50], 'limit is capped');

  res = await api('/api/sync', { method: 'POST' });
  assert.deepEqual(await res.json(), { throttled: true });
  res = await api('/api/nothing');
  assert.equal(res.status, 404);
  res = await api('/api/posts/' + POST_A.hash, { method: 'DELETE' });
  assert.equal(res.status, 405);

  res = await invoke('https://gwei.domains/api/posts/recent', { cache: makeCache(), fetchMock, env: { POST_INDEX: fakePostIndex({ fail: true }) } });
  assert.equal(res.status, 503);
  res = await invoke('https://gwei.domains/api/posts/recent', { cache: makeCache(), fetchMock, env: {} });
  assert.equal(res.status, 503);
});

test('the every-minute cron syncs the post index; the daily one checks endpoints', async () => {
  const POST_INDEX = fakePostIndex();
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    await worker.scheduled({ cron: '* * * * *' }, { POST_INDEX }, ctx);
    await Promise.all(waits);
  } finally {
    console.log = log;
  }
  assert.deepEqual(POST_INDEX.calls.map((c) => c[0]), ['getByName', 'sync']);
  assert.match(logged.join('\n'), /"event":"posts_sync","events":2,"blobs":1/);
});

test('storage paths cannot leave the name\'s content root (encoded slashes, encoded dot segments)', async () => {
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('<h1>other cid</h1>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  for (const path of ['/..%2Fbafyattacker/evil.html', '/%2e%2e%2fbafyattacker/x', '/a/..%5Cb', '/x%2fy']) {
    const res = await invoke(`https://donnoh.gwei.domains${path}`, { cache: makeCache(), fetchMock });
    assert.equal(res.status, 400, path);
  }
  assert.equal(fetchMock.calls.ipfs, 0, 'nothing was fetched upstream');
  const ok = await invoke('https://donnoh.gwei.domains/a%20b/c.html', { cache: makeCache(), fetchMock });
  assert.equal(ok.status, 200, 'ordinary percent-encoding still works');
  assert.ok(fetchMock.calls.ipfsUrls.at(-1).endsWith(`/ipfs/${DONNOH_CID}/a%20b/c.html`), fetchMock.calls.ipfsUrls.at(-1));
});

test('a gateway redirect out of the content root is not served', async () => {
  const away = new Response('<h1>other cid</h1>', { status: 200 });
  Object.defineProperty(away, 'url', { value: 'https://ipfs.io/ipfs/bafyattacker/evil.html' });
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => away });
  const res = await invoke('https://donnoh.gwei.domains/x.html', { cache: makeCache(), fetchMock });
  assert.equal(res.status, 404);
  const sub = new Response('<h1>donnoh</h1>', { status: 200 });
  Object.defineProperty(sub, 'url', { value: `https://${DONNOH_CID}.ipfs.dweb.link/x.html` });
  const ok = await invoke('https://donnoh.gwei.domains/x.html', { cache: makeCache(), fetchMock: makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => sub }) });
  assert.equal(ok.status, 200, 'a subdomain gateway redirect for the same CID is fine');
});

test('the visitor\'s Accept header is not forwarded to storage gateways', async () => {
  let seen;
  const fetchMock = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('ok', { status: 200 }) });
  const wrapped = async (input, init = {}) => {
    if (String(typeof input === 'string' ? input : input.url).includes('/ipfs/')) seen = new Headers(init.headers).get('accept');
    return fetchMock(input, init);
  };
  wrapped.calls = fetchMock.calls;
  await invoke('https://donnoh.gwei.domains/', { cache: makeCache(), fetchMock: wrapped, headers: { accept: 'application/vnd.ipld.raw' } });
  assert.equal(seen, '*/*');
});

// ---- link-preview cards ---------------------------------------------------------------------------
const pngSize = (bytes) => {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
};
const ogImage = (html) => /<meta property="og:image" content="([^"]+)">/.exec(html)[1];
const cardKeys = (cache) => [...cache._store.keys()].filter((k) => k.includes('/card/'));

test('cards: drawn once per version of the records, kept at the edge, never redrawn for a query string', async () => {
  const cache = makeCache();
  let description = 'builds things';
  const fetchMock = makeFetch({ rpc: (...args) => rpcProfile({ address: 'a11ce', text: { description } })(...args) });
  const html = await (await invoke('https://alice.gwei.limo/', { cache, fetchMock })).text();
  const image = ogImage(html);
  assert.match(image, /^https:\/\/alice\.gwei\.limo\/\.well-known\/gwei-card\.png\?v=[0-9a-f]{8}$/, 'on the host the page was asked for');
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);

  const rpcBefore = fetchMock.calls.rpc;
  let res = await invoke(image, { cache, fetchMock });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400', 'the current version may be kept a day');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(pngSize(new Uint8Array(await res.arrayBuffer())), [1200, 630]);
  assert.equal(fetchMock.calls.rpc, rpcBefore, 'the records come from the resolution cache');
  assert.equal(cardKeys(cache).length, 1);

  for (const query of ['', '?v=deadbeef', '?v=1&x=2', '?nonce=' + Math.random()]) {
    res = await invoke('https://alice.gwei.limo/.well-known/gwei-card.png' + query, { cache, fetchMock });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300', `a stale or missing version is kept briefly (${query})`);
    assert.deepEqual(pngSize(new Uint8Array(await res.arrayBuffer())), [1200, 630]);
  }
  assert.equal(cardKeys(cache).length, 1, 'queries never make the Worker draw again');

  // A records change shows up once the resolution entry expires: a new version, a new card.
  description = 'builds other things';
  cache.advance(301);
  const next = ogImage(await (await invoke('https://alice.gwei.limo/', { cache, fetchMock })).text());
  assert.notEqual(next, image);
  assert.equal((await invoke(next, { cache, fetchMock })).headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(cardKeys(cache).length, 2);

  // The same name on gwei.domains has its own URLs (and card, which shows that host).
  const other = ogImage(await (await invoke('https://alice.gwei.domains/', { cache, fetchMock })).text());
  assert.match(other, /^https:\/\/alice\.gwei\.domains\/\.well-known\/gwei-card\.png\?v=/);
});

test('cards: an unregistered name shows its price; only its root page answers 200', async () => {
  const cache = makeCache();
  const fetchMock = makeFetch({ rpc: rpcProfile({ address: '0', available: '1' }) });
  const res = await invoke('https://nobody.gwei.limo/', { cache, fetchMock });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<meta property="og:description" content="nobody\.gwei is available for 0\.0005 ETH a year\. Register it on gwei\.domains\.">/);
  const card = await invoke(ogImage(html), { cache, fetchMock });
  assert.equal(card.status, 200);
  assert.deepEqual(pngSize(new Uint8Array(await card.arrayBuffer())), [1200, 630]);
  assert.equal((await invoke('https://nobody.gwei.limo/elsewhere', { cache, fetchMock })).status, 404);
  // isAvailable(label, 0), getFee and getPremium ride in the profile's Multicall3 call: no extra round trip.
  assert.equal(fetchMock.calls.rpc, 1, 'one multicall for every record');

  const lapsed = await invoke('https://lapsed.gwei.limo/', { cache: makeCache(), fetchMock: makeFetch({ rpc: rpcProfile({ address: '0' }) }) });
  assert.match(await lapsed.text(), /content="lapsed\.gwei isn&#39;t registered, or has expired\./, 'no price while it can’t be registered');
});

test('cards: a post’s card names the post; unknown posts and named websites are left alone', async () => {
  const cache = makeCache();
  const env = { POST_INDEX: fakePostIndex() };
  const html = await (await invoke('https://alice.gwei.domains/posts/a1a1a1a1a1a1-exploring-the-blobspace', { cache, fetchMock: aliceProfile(), env })).text();
  const image = ogImage(html);
  assert.match(image, /^https:\/\/alice\.gwei\.domains\/\.well-known\/gwei-card\/a1a1a1a1a1a1\.png\?v=[0-9a-f]{8}$/);
  assert.match(html, /<meta property="og:title" content="Exploring the blobspace · alice\.gwei">/);
  const res = await invoke(image, { cache, fetchMock: aliceProfile(), env });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(pngSize(new Uint8Array(await res.arrayBuffer())), [1200, 630]);
  assert.equal((await invoke('https://alice.gwei.domains/.well-known/gwei-card/ffffffffffff.png', { cache, fetchMock: aliceProfile(), env })).status, 404);

  // A name with its own website serves its own files there; the gateway adds nothing to it.
  const site = makeFetch({ rpc: rpcReturning(CH_IPFS), ipfs: () => new Response('site file', { status: 200 }) });
  const own = await invoke('https://donnoh.gwei.limo/.well-known/gwei-card.png', { cache: makeCache(), fetchMock: site });
  assert.equal(await own.text(), 'site file');
});


test('a post page shows every reply under its sender’s name, takes replies, and says when they are off', async () => {
  const page = async (path, opts = {}) => {
    const res = await invoke('https://alice.gwei.domains' + path, { cache: makeCache(), fetchMock: aliceProfile(opts.text), env: { POST_INDEX: fakePostIndex(opts) } });
    assert.equal(res.status, 200);
    return { html: await res.text(), csp: res.headers.get('content-security-policy') };
  };
  let { html, csp } = await page('/posts/a1a1a1a1a1a1-exploring-the-blobspace');
  assert.match(html, /<div class="section">Replies \(6\)<\/div>/, 'every reply, as in ethchat');
  assert.match(html, /<a href="https:\/\/gwei\.domains\/#%F0%9F%A6%84" rel="nofollow noopener">🦄\.gwei<\/a><a class="reply-date"[^>]*>just now<\/a>/, 'a label that isn’t plain ASCII links to gwei.domains, not a host built from it');
  assert.match(html, /<a href="https:\/\/bob\.gwei\.domains\/" rel="nofollow noopener">bob\.gwei<\/a>/);
  assert.match(html, /<div class="reply-text">Great &lt;post&gt;\nsecond line<\/div>/, 'text, never markup');
  assert.match(html, /<a href="https:\/\/gwei\.domains\/#sub\.team" rel="nofollow noopener">sub\.team\.gwei<\/a>/, 'a subname has no gateway host');
  assert.match(html, /<a href="https:\/\/etherscan\.io\/address\/0x(c0){20}" rel="nofollow noopener">0xc0c0…c0c0<\/a>[\s\S]*anon here/, 'no name: the address');
  assert.match(html, /<a href="https:\/\/wei\.domains\/#carol" rel="nofollow noopener">carol\.wei<\/a>/);
  assert.match(html, /<a href="https:\/\/app\.ens\.domains\/dave\.eth" rel="nofollow noopener">dave\.eth<\/a>/);
  assert.match(html, /<div class="reply-form" data-hash="0x(a1){32}" data-name="alice\.gwei"><textarea[^>]*><\/textarea>[\s\S]*?<\/div><script>/, 'the reply box, then its script');
  assert.match(html, /<div class="actions reply-link"><a class="btn secondary" href="https:\/\/gwei\.domains\/#reply\/0x(a1){32}\/alice\.gwei">Reply<\/a><\/div>/, 'and a link without scripts');
  assert.equal(csp, POST_CSP);
  assert.equal(`'sha256-${createHash('sha256').update(REPLY_SCRIPT).digest('base64')}'`, REPLY_SCRIPT_HASH, 'the policy allows exactly the reply script');
  assert.doesNotMatch(REPLY_SCRIPT, /ethereum|eip6963|request\(|innerHTML/, 'the page script never touches a wallet, nor writes markup');
  assert.match(POST_CSP, /^default-src 'none'; script-src 'sha256-[^']+' 'sha256-[^']+'; img-src https: data:;/, 'no connect-src: the page makes no requests');
  ({ html } = await page('/posts/a1a1a1a1a1a1', { postReplies: false }));
  assert.match(html, /Replies are off for this post\./);
  assert.doesNotMatch(html, /Great &lt;post&gt;|#reply\/|class="reply-form"|<script>\(\(\)=>\{const f=/);
  ({ html } = await page('/posts/a1a1a1a1a1a1', { postReplies: false, text: { 'gwei-replies': 'a1a1a1a1a1a1:on' } }));
  assert.match(html, /Replies \(6\)/, 'the name’s record overrides the post');
  ({ html } = await page('/posts/a1a1a1a1a1a1', { text: { 'gwei-replies': 'a1a1a1a1a1a1:off' } }));
  assert.match(html, /Replies are off for this post\./);
  const many = Array.from({ length: 40 }, (_, i) => `${i.toString(16).padStart(12, '0')}:off`).join(' ');
  ({ html } = await page('/posts/a1a1a1a1a1a1', { text: { 'gwei-replies': many + ' a1a1a1a1a1a1:off' } }));
  assert.match(html, /Replies are off for this post\./, 'however many posts the record lists (it isn’t clipped like text)');
});

test('/api/posts/<hash>/replies lists every reply, whatever the author’s setting', async () => {
  const POST_INDEX = fakePostIndex();
  const res = await invoke('https://gwei.domains/api/posts/' + POST_A.hash + '/replies', { cache: makeCache(), fetchMock: makeFetch({}), env: { POST_INDEX } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json()).replies.length, 6);
});
