# gwei gateway

A Cloudflare Worker that serves `<name>.gwei.domains` from the website stored on that name. Per
request it reads the label from the `Host`, asks the NameNFT contract for the name's `contenthash`,
decodes its IPFS, IPNS, or Swarm reference, and reverse-proxies the content from a public protocol
gateway. If no `contenthash` is set it falls back to the ERC-6821 `contentcontract` text record and
serves the site straight out of a smart contract over web3:// (ERC-6860), with no storage network in
between.

This is the one piece of off-chain infrastructure GNS relies on. It follows the standard ENS-style
contenthash-gateway pattern (the same idea as `eth.limo` for `.eth`) and also serves contract-hosted
websites. The load-shaping design borrows the useful operational lessons from wei-names' open WNS
gateway while retaining GNS's IPFS, IPNS, Swarm, and `contentcontract` paths.

## Deploy

You need the Cloudflare account that manages the `gwei.domains` zone.

1. **Wildcard DNS.** Add a record so Cloudflare receives every subdomain:
   - Type `AAAA`, name `*`, content `100::`, **Proxied** (orange cloud).
     *(The address is a placeholder — the Worker answers before anything reaches an origin.)*
   - This does **not** affect the apex `gwei.domains` (the dapp) or the existing
     `diff.gwei.domains` record.

2. **Deploy the Worker** (from this `gateway/` directory):
   ```bash
   npx wrangler login        # one-time, opens the browser
   npx wrangler deploy       # creates the worker, RPC brokers, and wildcard route
   ```

   `wrangler.toml` declares the `RpcBroker` Durable Object as well as the route, so deploy this
   directory rather than pasting only `worker.js` into the dashboard editor.

3. **Test:** open a name that has a website set, e.g. `https://donnoh.gwei.domains/`.

## Notes

- **`diff.gwei.domains`** is a real service, not a gwei name, so the worker proxies it straight
  through to the Railway diff site (`RESERVED` in `worker.js`). Add more reserved subdomains there
  if you stand up other services under `gwei.domains`.
- Names with no `contenthash` and no usable `contentcontract` record return a friendly 404 linking
  to the dapp.
- The NameNFT address lives at the top of `worker.js`; chain and endpoint pools live in
  `rpc-config.js`. A dedicated mainnet endpoint can be configured with
  `npx wrangler secret put RPC_URL`. It remains preferred while healthy, with the public pool as
  rotated fallback.
- **RPC load shaping.** Normal Worker globals cannot safely share request-bound I/O promises. Four
  Durable Object broker shards per continent therefore coordinate identical calls, rotate public
  endpoints, cool down failing endpoints for 30 seconds, and apply explicit 5-second lookup and
  15-second page-read timeouts. Each shard permits 6 active RPCs and 50 queued calls (24 active and 200
  queued per regional pool); excess or overlong queue entries return a retryable, uncached 503.
  The existing Cloudflare Cache API remains the bounded response cache, so no document bodies are
  retained in broker memory.
- **web3:// sites.** `contenthash` wins when a name has both records, so nothing that works today
  changes. Chains a `contentcontract` record may name live in the `CHAINS` table in `rpc-config.js`
  (mainnet and Sepolia); adding one is a single entry. The gateway reads `resolveMode()` and serves
  ERC-6944 resource-request (`"5219"`) and manual mode; auto mode returns 415. Contract-supplied
  headers pass an allowlist, so a contract cannot set `set-cookie` or weaken the security headers on
  a name's origin. Chunked (`web3-next-chunk`) responses are refused with a 501 rather than served
  truncated. Contract cache directives are capped to the 5-minute name-resolution window, and cached
  pages are keyed by the resolved contract so repointing a name cannot revive stale content.
  `resolveMode` is cached for 24h since it's `pure` in practice.
- Bodies are served as raw bytes. ERC-5219 types the body as `string`, but contracts put images and
  fonts in it, so it never round-trips through a UTF-8 decode.
- IPFS and IPNS content is fetched from `ipfs.io` (with `dweb.link` fallback). IPNS Peer IDs are
  validated and converted to canonical CIDv1 base36 names before they reach an upstream. Swarm content is fetched from
  `download.gateway.ethswarm.org`; its forced attachment header is removed so websites render
  inline. Responses are cached for 5 min, so an IPNS update may take up to 5 min to become visible.
