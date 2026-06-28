// gwei.domains gateway — a Cloudflare Worker that turns `<name>.gwei.domains` into the website
// stored at that name's on-chain `contenthash`.
//
// For each request it: reads the label from the Host, asks the NameNFT contract for the name's
// contenthash, decodes the IPFS CID, and reverse-proxies the content from a public IPFS gateway.
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

const SEL_COMPUTEID = 'fb021939'; // computeId(string)
const SEL_CONTENTHASH = 'cb323d76'; // contenthash(uint256)
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

const pad32 = (h) => h.padStart(64, '0');
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

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
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>body{background:#0a0a0a;color:#e8e8e0;font-family:Helvetica,Arial,sans-serif;` +
    `min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:24px;line-height:1.6}` +
    `a{color:#e8e8e0}p{color:#b8b8b0;max-width:380px;margin:0}</style>${body}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    // A dedicated RPC (set via `wrangler secret put RPC_URL`) is tried first, then the public pool.
    const rpcs = (env && env.RPC_URL) ? [env.RPC_URL, ...RPCS] : RPCS;

    // Only subdomains of gwei.domains; the apex (the dapp) is routed elsewhere.
    if (!host.endsWith('.gwei.domains')) return page('gwei gateway', '<p>Not a gwei name.</p>', 404);
    const sub = host.slice(0, -'.gwei.domains'.length); // "donnoh", "diff", "a.b", …
    if (!sub) return page('gwei gateway', '<p>Not a gwei name.</p>', 404);

    // Reserved service subdomains: transparently proxy to their real origin.
    if (RESERVED[sub]) {
      const upstream = await fetch(RESERVED[sub] + url.pathname + url.search, {
        method: request.method, headers: request.headers, body: request.body, redirect: 'follow',
      });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    }

    const name = sub + '.gwei'; // gwei name this host maps to

    // 1. Resolve the name's contenthash on-chain. Transient RPC failures aren't cached, so a retry recovers.
    const idRes = await ethCall(encodeString(SEL_COMPUTEID, name), rpcs);
    if (!idRes) return page('gwei gateway', '<p>Resolution failed (RPC).</p>', 502, 'no-store');
    const chRes = await ethCall('0x' + SEL_CONTENTHASH + idRes.slice(2), rpcs);
    if (!chRes) return page('gwei gateway', '<p>Resolution failed (RPC).</p>', 502, 'no-store');

    // 2. Decode the contenthash → IPFS CID.  ENS contenthash for IPFS = e301 || <cidv1 bytes>.
    const b = chRes.slice(2);
    const len = parseInt(b.slice(64, 128), 16) || 0;
    if (len === 0) {
      return page(name, `<p><b>${name}</b> has no website set.</p><p><a href="https://gwei.domains">set one →</a></p>`, 404);
    }
    const chHex = b.slice(128, 128 + len * 2);
    if (!chHex.startsWith('e301')) return page(name, '<p>This name points to a non-IPFS contenthash.</p>', 415);
    const cid = 'b' + base32(hexToBytes(chHex.slice(4)));

    // 3. Reverse-proxy the content from an IPFS gateway.
    for (const gw of IPFS_GATEWAYS) {
      try {
        const upstream = await fetch(`${gw}/ipfs/${cid}${url.pathname}${url.search}`, {
          headers: { accept: request.headers.get('accept') || '*/*' },
          redirect: 'follow',
        });
        if (upstream.ok || upstream.status === 304) {
          const headers = new Headers(upstream.headers);
          headers.set('cache-control', 'public, max-age=300');
          headers.set('x-gwei-name', name);
          headers.set('x-ipfs-cid', cid);
          return new Response(upstream.body, { status: upstream.status, headers });
        }
      } catch (_) {}
    }
    return page(name, '<p>Content is set but couldn’t be fetched from IPFS right now.</p>', 504, 'no-store');
  },
};
