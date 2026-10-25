# gwei-mirror

Keep a copy of every .gwei post on your IPFS node, so the posts stay online even if gwei.domains
doesn't.

Every post on a .gwei name is recorded on Ethereum by its hash, and IPFS can address data by that
same hash. So your copy is checked against Ethereum and identical to everyone else's: anyone, or any
website, that knows a post from the chain can fetch it from your node. You don't have to trust
gwei.domains, and nobody has to coordinate.

## Run it

**With Docker** (it brings its own IPFS node):

```sh
docker run -d --name gwei-mirror --restart unless-stopped \
  -p 4001:4001 -p 4001:4001/udp -v gwei-mirror:/data ghcr.io/lucadonnoh/gwei-mirror
```

**With IPFS Desktop or Kubo** already running:

```sh
npx gwei-mirror
```

That's it. It pins every post (and the blob that carried it to Ethereum), then checks for new ones
every 10 minutes. Follow it with `docker logs -f gwei-mirror`:

```
2026-10-25 16:07:11  gwei-mirror: pinning .gwei posts on IPFS node 12D3KooW… (kubo/0.43.1)
2026-10-25 16:07:13    pinned "Exploring the blobspace" (bafkrwih6ookadoq2v4ik7io7xysj2z7fwy7ptyguoy3nkjn6ikwd2g2spe)
2026-10-25 16:07:13  7 of 7 posts pinned (7 new) · Ethereum block 26270702
```

Posts are small (a few KB each, and a 128 KB blob), so this takes almost no disk. Keep your node
running so it can serve them, and let other IPFS nodes reach it: forward port 4001 (TCP and UDP) on
your router if you're at home. Without that your node still keeps a copy, it just serves fewer peers.

## Options

```
--ipfs <url>     your IPFS node's API (default: $IPFS_API or http://127.0.0.1:5001)
--rpc <url>      an Ethereum RPC to read posts from, e.g. your own node; repeat for more
--source <url>   a gwei.domains-style API to fetch posts from; repeat for more
--state <file>   where to keep progress (default: ~/.gwei-mirror/state.json)
--every <min>    minutes between checks (default: 10)
--once           check once and exit
```

With Docker, put options after the image name (`… ghcr.io/lucadonnoh/gwei-mirror --rpc https://…`).
By default it reads the chain from public RPCs. If you run an Ethereum node, pass `--rpc` to read
from your own: then nothing at all is taken on trust.

## What it checks

For each post the GnsPosts contract
([`0x7384…7981`](https://etherscan.io/address/0x73849f6f2785BA7fd2f41b5B4573B75554417981)) knows
about:

1. The post's bytes, from gwei.domains, IPFS or any `--source`, must hash (keccak-256) to the post
   hash on Ethereum. Anything else is thrown away.
2. A blob that was published on Ethereum must carry the post. The post's own blob is rebuilt from the
   post and checked against the blob's versioned hash with KZG; a blob holding several posts is
   fetched and checked the same way.
3. Your node stores the post under the CID its hash gives (`bafkrwi…`, a raw block hashed with
   keccak-256) and the blob under its sha-256 CID (`bafkrei…`), and pins both.

Anyone can work out a post's CID from Ethereum alone: it is the post hash from the `PostAuthorized`
event, as a CIDv1 with the raw codec and the keccak-256 multihash. See "Mirroring" in
[posts/SPEC.md](../posts/SPEC.md).

## From the repository

```sh
git clone https://github.com/lucadonnoh/gwei-names && node gwei-names/mirror/gwei-mirror.mjs
```

Node 20 or newer; no dependencies. `node --test *.test.mjs` runs the tests.
