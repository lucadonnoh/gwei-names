# gwei gateway

A Cloudflare Worker that serves `<name>.gwei.domains` from the website stored at that name's
on-chain `contenthash`. Per request it reads the label from the `Host`, asks the NameNFT contract
for the name's `contenthash`, decodes its IPFS or Swarm reference, and reverse-proxies the content
from a public protocol gateway.

This is the one piece of off-chain infrastructure GNS relies on — the upstream wei-names repo
doesn't include a gateway (it's run, not open-sourced), so this is written from scratch and kept
here in the open. It follows the standard ENS-style contenthash-gateway pattern (the same idea as
`eth.limo` for `.eth`).

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
   npx wrangler deploy       # creates the worker + the *.gwei.domains/* route
   ```
   Or, via the dashboard: Workers & Pages → Create → paste `worker.js` → add a route
   `*.gwei.domains/*` on the `gwei.domains` zone.

3. **Test:** open a name that has a website set, e.g. `https://donnoh.gwei.domains/`.

## Notes

- **`diff.gwei.domains`** is a real service, not a gwei name, so the worker proxies it straight
  through to the Railway diff site (`RESERVED` in `worker.js`). Add more reserved subdomains there
  if you stand up other services under `gwei.domains`.
- Names with no `contenthash` set return a friendly 404 linking to the dapp.
- Network/contract addresses live at the top of `worker.js` — update `NAMENFT` (currently the
  Sepolia deployment) and `RPCS` when GNS moves to another network.
- IPFS content is fetched from `ipfs.io` (with `dweb.link` fallback). Swarm content is fetched from
  `download.gateway.ethswarm.org`; its forced attachment header is removed so websites render
  inline. Responses are cached for 5 min.
