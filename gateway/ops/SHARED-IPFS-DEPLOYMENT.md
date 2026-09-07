# Shared IPFS retrieval repair — 2026-09-07

Scope: every GNS IPFS/IPNS site, with no name/CID selection exceptions.
The current chat contenthash and frontend files are unchanged.

The shared HTTPS transport uses the existing test-chat.slopo.net tunnel and
forwards GET/HEAD /ipfs/* and /ipns/* to the existing Kubo gateway at
192.168.10.140:8082. It has separate rate/concurrency limits and an 8-second
upstream read timeout. It rejects writes and does not expose /api/v0/*.
Direct browser visits are sandboxed. The GNS Worker replaces transport security
headers with its existing per-name policy. Kubo and cloudflared were not restarted;
nginx received a graceful reload. RPC handling and other tunnel routes are unchanged.

The shared Worker reads IPFS_GATEWAYS from configuration. Primary is the Kubo
transport; public backups are ipfs.io and dweb.link. It hedges after 300ms,
advances immediately on failed status/network response, and imposes an 8-second
header deadline per attempt. It cancels losing requests and cools down 429/5xx
and network failures for 30 seconds. The two public backup hosts share an operator;
they are opportunistic fallback capacity, not an independent managed SLA.
Storacha w3s.link was tested but redirects this CID to dweb.link, so it was not
misrepresented as another independent backend. Pinata/4EVERLAND public gateways
refuse HTML, and Lighthouse's tested endpoint requires payment; none was added.
No new paid provider, pinning subscription or off-site replica was created.

Immutable IPFS responses may remain in the edge cache for 24 hours, subject to
normal eviction. Name-resolution and browser cache policies remain short. The
resolved CID is included in the content key, so a record change cannot select an
old CID's cached body. Mutable IPNS and contract responses retain their policies.

Validation:
- 67 gateway, RPC-pool and content-fetch unit tests passed.
- Shared configuration used for two unrelated names; all prior protocol handlers
  still pass (IPFS, IPNS, Swarm, contract-hosted content).
- Hedged hanging primary, cancelled loser, immediate error fallback, cooldown,
  recovery, missing content and all-hung deadlines covered.
- Cached content serves during a simulated upstream outage, but a changed name
  record must fetch the new CID instead of returning the old cached site.
- Public node transport returned both the chat CID and donnoh's unrelated CID.
- Direct transport HTML SHA256 matches the pinned build exactly.
- Transport POST:403 and administrative route:404. CSP sandbox is present.
- With a simulated unavailable home endpoint, actual public gateway retrieval
  returned the chat HTML in 511–704ms during these probes. This tests fallback
  routing and live remote retrieval, not a physical outage of the sole pinning node.
- Live GNS cold-query probes returned HTTP200 for ethchat.gwei.domains and
  donnoh.gwei.domains after the initial shared-path deployment.

Previous Worker: e8f36727-f110-43b9-b539-3146be61476d.
Initial shared path: bb14611e-6d24-4041-a728-7340f5660a30.
Final upload (with immutable cache retention): e8b30740-b480-4f62-ade3-935bf5bec41a.
Check deployments before rollback. The nginx original was backed up to
/root/service-backups/gns-shared-ipfs-20260907/test-chat.conf on rpi.
Source worktree: /Users/donnoh/hobby/gwei-gateway-fallback.

Final version e8b30740-b480-4f62-ade3-935bf5bec41a was deployed at 100%.
67 final tests passed. Three fresh-query browser visits to the live chat each
returned HTTP200 and the correct CID, displayed gmgm, and had no uncaught errors.
Observed document TTFB: 167ms, 261ms, 153ms. First browser DOM readiness still
included local network/asset delay (3.18s); the subsequent visits were 275ms and
165ms. These are observations, not an uptime or end-to-end latency guarantee.
The live app.js checksum matches the user's published candidate. A second GNS
site returned200 in0.86s, and the unchanged RPC route returned the correct chain.
