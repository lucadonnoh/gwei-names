# Shipping

Main is production. Every push runs the tests it can affect; a green run on main deploys the gateway
and the dapp from that commit and checks that the live sites serve it.

| Part | Where it runs | How it ships | How to see what's live |
|---|---|---|---|
| Gateway (`gateway/`) | Cloudflare Worker `gwei-gateway` on `*.gwei.domains`, `*.gwei.limo`, `gwei.domains/api/*` | `deploy.yml` after CI on main | `https://gwei.domains/api/version` |
| Dapp (`dapp/`, `Dockerfile`) | Railway service `gwei-dapp` (nginx, `dapp/nginx.conf.template`), `gwei.domains` | `deploy.yml` after CI on main | `https://gwei.domains/version.txt` |
| Publisher (`posts/poster/`) | Docker on eth-node | `posts/poster/deploy.sh`, by hand | `gwei_poster.py status` on eth-node |
| Contracts (`src/`) | Ethereum | `forge script`, by hand; immutable | Etherscan, Sourcify |
| SDK, snap | npm | `pnpm pub`, `npm publish`, by hand | npm |

The dapp's network stats come from the gateway (`gwei.domains/api/stats`, `gateway/stats-store.js`),
which indexes NameNFT's events next to the post index; after a gateway deploy that resets the index,
the stats section stays hidden until it has caught up (a few minutes).

## Tests

`scripts/test-all.sh` runs every offline suite locally and says which it skipped. CI
(`.github/workflows/ci.yml`) has the same suites: contracts (minus the mainnet-fork suites), gateway,
dapp, SDK (checks and offline tests), snap (and that its committed manifest matches the build), and the
publisher (including its anvil end-to-end test). A nightly run adds the suites that need live networks:
the fork tests and the SDK's Sepolia tests.

A push or pull request runs only the suites whose inputs changed (`scripts/ci-changes.mjs` lists them
and follows imports across directories, so a change to `gateway/posts-format.js` also runs the dapp and
publisher tests). Changes are counted from the last commit that passed CI on the branch (main's, for a
branch's first push; the target branch, for a pull request), so a failing suite keeps running until it
passes. Nightly and manual runs, and any change to the workflows or to those rules, run everything. The
contracts' invariant test runs 256 runs on a push and the full 1000 nightly.

## Deploys

`.github/workflows/deploy.yml` runs when CI passes on main:

1. Skips itself if main has moved on (the newer commit's run deploys that one).
2. Skips a part whose files (`deploy-gateway` and `deploy-dapp` in `scripts/ci-changes.mjs`) are the
   same as at the commit it already runs, read from `/api/version` and `/version.txt`: production
   already runs main's code for it. That part keeps reporting its older commit. An unknown commit
   means deploy.
3. Deploys the Worker with `wrangler deploy`, tagged with the commit (`GIT_COMMIT`).
4. Deploys that commit of the dapp through Railway's API and waits for Railway to report it live.
   Railway's own deploy-on-push is off, so nothing ships before the tests pass.
5. Waits until each deployed part reports the commit, then smoke-tests the live pages
   (`scripts/verify-deploy.mjs`).
6. On any failure: a failed run (GitHub emails it) and, if configured, an ntfy alert.

Secrets live in the repository's `production` environment, readable only by jobs on main:
`CLOUDFLARE_API_TOKEN` (Workers Scripts edit, Workers Routes edit on both zones), `RAILWAY_TOKEN`
(project token, gwei-names / production), optional `NTFY_URL` and `NTFY_TOKEN`. The variable
`CLOUDFLARE_ACCOUNT_ID` names the account. A part whose secret is missing is skipped with a warning.

Run it again by hand from the Actions tab (Deploy, "Run workflow"): it redeploys both parts from
main's tip, changed or not.

### Without CI

- Gateway: `scripts/deploy-gateway.sh`. It refuses a dirty tree or a commit that isn't main's tip, so
  a laptop deploy can't roll back newer changes.
- Dapp: `RAILWAY_API_TOKEN=... node scripts/railway-deploy.mjs <sha>`.
- Check either with `node scripts/verify-deploy.mjs <sha> [--gateway] [--dapp]`.

## Changes that span parts

Gateway and dapp ship together from one commit. The publisher and contracts don't, so order matters:
switch to a new contract in the gateway and dapp first (one commit), and the publisher after
(`posts/poster/deploy.sh --contract <address> --from-block <block>`), because until the dapp points at
the new contract, payments still go to the old one and only the old publisher delivers them.

## Rolling back

Revert on main and push; the pipeline ships the revert. In a hurry, `npx wrangler rollback` (from
`gateway/`) restores the previous Worker version and Railway's dashboard can redeploy an earlier
deployment, but revert main too, or the next deploy undoes the rollback.
