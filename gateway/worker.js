// gwei.domains gateway — a Cloudflare Worker that turns `<name>.gwei.domains` into the website
// stored at that name's on-chain `contenthash`.
//
// For each request it: reads the label from the Host, asks the NameNFT contract for the name's
// contenthash, decodes the IPFS CID, and reverse-proxies the content from a public IPFS gateway.
// Resolved name→CID lookups and fetched content are cached at the edge (Cloudflare Cache API);
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
// Tried in order; ipfs.io's path gateway serves directly (no origin-isolation redirect for us).
const IPFS_GATEWAYS = ['https://ipfs.io', 'https://dweb.link'];
// Subdomains that are real services, not gwei names — proxied through so the wildcard route
// doesn't shadow them.
const RESERVED = {
  diff: 'https://gwei-diff-production.up.railway.app',
};

// How long resolved records / content stay cached at the edge. Contenthash edits become visible
// within RESOLVE_TTL. Negatives ("no website", "non-IPFS") expire faster so a freshly-set site
// shows up sooner. Transient RPC/IPFS failures are never cached.
const RESOLVE_TTL = 300;     // name → CID (seconds)
const RESOLVE_NEG_TTL = 60;  // name → "none"/"non-ipfs" (seconds)
const CONTENT_TTL = 300;     // proxied content (seconds)
const CACHE_BASE = 'https://gwei-cache.internal'; // synthetic keys for the resolution cache

const SEL_COMPUTEID = 'fb021939'; // computeId(string)
const SEL_CONTENTHASH = 'cb323d76'; // contenthash(uint256)
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

const pad32 = (h) => h.padStart(64, '0');
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

function encodeString(sel, str) {
  const bytes = new TextEncoder().encode(str);
  let data = toHex(bytes);
  while (data.length % 64) data += '0';
  return '0x' + sel + pad32('20') + pad32(bytes.length.toString(16)) + data;
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
// Tries each RPC in turn; returns the first non-empty result, or null if all fail.
async function ethCall(data, rpcs) {
  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: NAMENFT, data }, 'latest'] }),
      });
      const j = await r.json();
      if (j && j.result && j.result !== '0x') return j.result;
    } catch (_) {}
  }
  return null;
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

// Resolve a gwei name to its contenthash, caching the result. Returns one of:
//   { cid }                     — IPFS website
//   { state: 'none' }           — no contenthash set
//   { state: 'nonipfs' }        — contenthash present but not IPFS
//   { error: 'rpc' }            — RPC lookup failed (never cached; a retry recovers)
async function resolveName(name, rpcs, cache, ctx) {
  const key = new Request(`${CACHE_BASE}/resolve/${encodeURIComponent(name)}`);
  const cached = await cache.match(key);
  if (cached) {
    try { return await cached.json(); } catch (_) {}
  }

  // Transient RPC failures aren't cached, so a retry recovers.
  const idRes = await ethCall(encodeString(SEL_COMPUTEID, name), rpcs);
  if (!idRes) return { error: 'rpc' };
  const chRes = await ethCall('0x' + SEL_CONTENTHASH + idRes.slice(2), rpcs);
  if (!chRes) return { error: 'rpc' };

  // Decode the contenthash → IPFS CID. ENS contenthash for IPFS = e301 || <cidv1 bytes>.
  const b = chRes.slice(2);
  const len = parseInt(b.slice(64, 128), 16) || 0;
  let result;
  if (len === 0) {
    result = { state: 'none' };
  } else {
    const chHex = b.slice(128, 128 + len * 2);
    if (!chHex.startsWith('e301')) result = { state: 'nonipfs' };
    else result = { cid: 'b' + base32(hexToBytes(chHex.slice(4))) };
  }

  const ttl = result.cid ? RESOLVE_TTL : RESOLVE_NEG_TTL;
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

    const name = sub + '.gwei'; // gwei name this host maps to
    const cache = caches.default;

    // Content cache: serve a previously-proxied full response for this exact URL.
    if (request.method === 'GET') {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    // 1. Resolve the name's contenthash on-chain (cached).
    const r = await resolveName(name, rpcs, cache, ctx);
    if (r.error) return page('gwei gateway', '<p>Resolution failed (RPC).</p>', 502, 'no-store');
    if (r.state === 'none') {
      return page(name, `<p><b>${escapeHtml(name)}</b> has no website set.</p><p><a href="https://gwei.domains">set one →</a></p>`, 404);
    }
    if (r.state === 'nonipfs') {
      return page(name, '<p>This name points to a non-IPFS contenthash.</p>', 415);
    }
    const cid = r.cid;

    // 2. Reverse-proxy the content from an IPFS gateway.
    for (const gw of IPFS_GATEWAYS) {
      try {
        const upstream = await fetch(`${gw}/ipfs/${cid}${url.pathname}${url.search}`, {
          headers: { accept: request.headers.get('accept') || '*/*' },
          redirect: 'follow',
        });
        if (upstream.ok || upstream.status === 304) {
          const headers = harden(new Headers(upstream.headers));
          headers.set('cache-control', `public, max-age=${CONTENT_TTL}`);
          headers.set('x-gwei-name', name);
          headers.set('x-ipfs-cid', cid);
          const resp = new Response(upstream.body, { status: upstream.status, headers });
          // Only full 200 GETs are cacheable; failures and partials are not.
          if (request.method === 'GET' && upstream.status === 200) {
            ctx.waitUntil(cache.put(request, resp.clone()).catch(() => {}));
          }
          return resp;
        }
      } catch (_) {}
    }
    return page(name, '<p>Content is set but couldn’t be fetched from IPFS right now.</p>', 504, 'no-store');
  },
};
