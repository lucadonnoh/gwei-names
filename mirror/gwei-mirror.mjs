#!/usr/bin/env node
// gwei-mirror: keep a copy of every .gwei post on your IPFS node, so the posts stay online whatever
// happens to gwei.domains. Run it next to IPFS Desktop or Kubo (`npx gwei-mirror`), or use the Docker
// image, which brings its own node. README.md says more; mirror.mjs has the logic.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SOURCES, Kubo, Mirror } from './mirror.mjs';

const HELP = `gwei-mirror: keep a copy of every .gwei post on your IPFS node.

Reads the posts from Ethereum, fetches each one (from gwei.domains, IPFS or any
source you add), checks it against the hash on Ethereum, and pins it, with the
blob that carries it. Then checks again every few minutes.

Usage: gwei-mirror [options]

  --ipfs <url>     your IPFS node's API (default: $IPFS_API or http://127.0.0.1:5001)
  --rpc <url>      an Ethereum RPC to read posts from, e.g. your own node; repeat for
                   more (default: public RPCs)
  --source <url>   a gwei.domains-style API to fetch posts from; repeat for more
                   (default: https://gwei.domains). Anything fetched is checked.
  --state <file>   where to keep progress (default: ~/.gwei-mirror/state.json)
  --every <min>    minutes between checks (default: 10)
  --once           check once and exit
  -h, --help       this help
`;

const list = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);
let args;
try {
  ({ values: args } = parseArgs({
    options: {
      ipfs: { type: 'string' }, rpc: { type: 'string', multiple: true }, source: { type: 'string', multiple: true },
      state: { type: 'string' }, every: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (error) {
  console.error(`${error.message}\n\n${HELP}`);
  process.exit(2);
}
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const ipfsUrl = args.ipfs || process.env.IPFS_API || 'http://127.0.0.1:5001';
const rpcs = args.rpc?.length ? args.rpc : list(process.env.GWEI_MIRROR_RPC);
const sources = args.source?.length ? args.source : list(process.env.GWEI_MIRROR_SOURCE);
const every = Math.max(Number(args.every || process.env.GWEI_MIRROR_EVERY || 10), 1);
const ipfs = new Kubo(ipfsUrl);
const say = (line) => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')}  ${line}`);

let node;
try {
  node = await ipfs.id();
} catch (error) {
  console.error(`Can't reach an IPFS node at ${ipfsUrl} (${error.cause?.code || error.message}).

Start IPFS Desktop (https://docs.ipfs.tech/install/ipfs-desktop/) or a Kubo daemon
(\`ipfs daemon\`) and run this again, or point --ipfs at your node's API. Or run
the Docker image, which brings its own node:

  docker run -d --name gwei-mirror --restart unless-stopped -p 4001:4001 -p 4001:4001/udp \\
    -v gwei-mirror:/data ghcr.io/lucadonnoh/gwei-mirror`);
  process.exit(1);
}

const mirror = new Mirror({
  ipfs,
  ...(rpcs.length ? { rpcs } : {}),
  sources: sources.length ? sources : DEFAULT_SOURCES,
  statePath: args.state || process.env.GWEI_MIRROR_STATE || join(homedir(), '.gwei-mirror', 'state.json'),
  log: (line) => say(`  ${line}`),
});
say(`gwei-mirror: pinning .gwei posts on IPFS node ${node.ID} (${node.AgentVersion})`);
if (!Object.keys(mirror.state.claims).length) say('reading the posts from Ethereum (the first run takes a minute)');

// Progress is saved as it goes (atomically), and pinning twice is harmless, so stopping is just exiting.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { say('stopped'); process.exit(0); });

let last = '';
for (;;) {
  try {
    const { posts, pinned, added, waiting, block } = await mirror.round();
    const line = `${pinned} of ${posts} posts pinned` + (added ? ` (${added} new)` : '') +
      (waiting ? `, ${waiting} not found yet (retrying)` : '') + ` · Ethereum block ${block}`;
    if (line !== last || added) say(line);
    last = line;
  } catch (error) {
    if (args.once) {
      say(`the check failed: ${error.message}`);
      process.exit(1);
    }
    say(`this check failed, retrying in ${every} min: ${error.message}`);
    last = '';
  }
  if (args.once) break;
  await new Promise((resolve) => setTimeout(resolve, every * 60_000));
}
say('done. Keep your IPFS node running so it can serve the posts.');
