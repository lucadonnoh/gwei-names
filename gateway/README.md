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
- Names with no `contenthash` and no usable `contentcontract` record return a friendly 404. It says
  whether the name is unregistered (or expired) or just has no website, and links to the name in the
  dapp (`https://gwei.domains/#<name>`).
- Name sites are HTTPS-only: plain HTTP requests get a 301 to the same URL over HTTPS.
- Transient failures (RPC lookups, a busy broker, storage gateways that don't answer) return
  uncached error pages that reload themselves up to three times a minute.
- **Last known site.** Each successful website lookup is also kept for 7 days and used only when a
  fresh lookup fails, so an RPC outage serves the name's last known site (logged as
  `resolve_stale`) instead of an error page. A name repointed during an outage can serve its
  previous site until RPC recovers.
- **Health check.** A daily cron (`scheduled` in `worker.js`) probes every RPC endpoint and IPFS
  gateway from the Worker and logs an `endpoint_health` event, at error level when any fails.
  Workers Logs is enabled in `wrangler.toml`, so these and `rpc_failed` events can be read later in
  the dashboard. When `NTFY_URL` (topic URL) and `NTFY_TOKEN` (publish-only token) are set as
  secrets, failures are also pushed to ntfy. Public endpoints tend to start rejecting Worker
  traffic without notice.
- The NameNFT address lives at the top of `worker.js`; chain and endpoint pools live in
  `rpc-config.js`. A dedicated mainnet endpoint can be configured with
  `npx wrangler secret put RPC_URL`, and its credential with `npx wrangler secret put RPC_TOKEN`
  (sent as `Authorization: Bearer`, only to `RPC_URL`). It remains preferred while healthy, with the
  public pool as rotated fallback; a call whose result exceeds the endpoint's return-data limit moves
  to the public pool without benching it. Production uses the owner's Erigon through the token-scoped
  rpc-gateway at `rpc.slopo.net` (role `gns_gateway`: `eth_call`, `eth_blockNumber`, `eth_chainId`).
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
  auto mode (ERC-6860 method calls, `returns` JSON and ERC-7087 `mime.*` attributes, in
  `web3-auto.js`), manual mode and ERC-6944 resource-request (`"5219"`). In auto mode the root is a
  call with empty calldata; when that reverts or returns nothing, the gateway tries `html()` once
  (a gwei.domains addition outside ERC-6860, marked `x-web3-auto-fallback: html()`). Contract-supplied
  headers pass an allowlist, so a contract cannot set `set-cookie` or weaken the security headers on
  a name's origin. Chunked (`web3-next-chunk`) responses are refused with a 501 rather than served
  truncated. Contract cache directives are capped to the 5-minute name-resolution window, and cached
  pages are keyed by the resolved contract so repointing a name cannot revive stale content.
  `resolveMode` is cached for 24h since it's `pure` in practice.
- Bodies are served as raw bytes. ERC-5219 types the body as `string`, but contracts put images and
  fonts in it, so it never round-trips through a UTF-8 decode.
- IPFS and IPNS content uses the shared `IPFS_GATEWAYS` configuration. Production first tries the existing Kubo node through the HTTPS transport, with public gateways as opportunistic fallbacks. IPNS Peer IDs are
  validated and converted to canonical CIDv1 base36 names before they reach an upstream. Swarm content is fetched from
  `download.gateway.ethswarm.org`; its forced attachment header is removed so websites render
  inline. Responses are cached for 5 min, so an IPNS update may take up to 5 min to become visible.


## Shared content retrieval

`content-gateways.js` starts the preferred gateway immediately and another after
300 ms if needed. HTTP failures advance immediately. Each attempt has an 8-second
header deadline; losing requests are cancelled. Network errors, 429 and 5xx
responses temporarily cool down an upstream for 30 seconds. A 404 only misses
that content, and does not mark the gateway unhealthy; if no gateway has the
file and at least one answered 404, visitors get a 404 page rather than the
"couldn't be fetched" outage page. When every gateway is
cooling down, one is probed so recovery can be detected. Response bodies stream.
Immutable IPFS content is retained in the edge cache for up to one day, subject
to cache eviction. Browser caching remains five minutes, and name records are
still refreshed normally. Repointing a name selects a new CID/cache key. IPNS
and contract content keep their existing cache policy.

`IPFS_GATEWAYS` is a JSON array of HTTPS origins, shared by every IPFS/IPNS-backed
name. `SWARM_GATEWAYS` can override the Swarm origins separately. No name or CID
appears in the selection policy. The production node transport reuses
`https://test-chat.slopo.net/ipfs/<cid>/...` and `/ipns/<name>/...` through the
existing tunnel, backed by Kubo at 192.168.10.140:8082. Despite the existing host's
name, these routes are generic and are used for every site's content.

The transport is GET/HEAD-only, rate/concurrency limited, and never proxies the
Kubo admin API. Its CSP sandboxes direct browser visits so arbitrary IPFS HTML
cannot access the transport host's app storage. GNS applies its existing security
headers on the isolated per-name origin. No tunnel or Kubo restart was needed.

The public fallback is Filebase. ipfs.io and dweb.link (the code's built-in
defaults when `IPFS_GATEWAYS` is unset) are not configured in production: from
Cloudflare's shared egress they answered every request with 429 in October 2026.
Filebase is an opportunistic backup, not an uptime guarantee. Storacha w3s.link was
also tested but redirects this content to dweb.link, so it was not added as a
falsely independent backup.
The gateway list supports independent managed origins when configured; none was
purchased or claimed as available in this change. If all online providers lack a
CID and the only holder is offline, retrieval cannot succeed. See
`ops/SHARED-IPFS-DEPLOYMENT.md` for the live deployment and test evidence.
