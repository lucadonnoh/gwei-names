// RPC endpoint configuration shared by the request Worker and its Durable Object brokers.
//
// A dedicated mainnet endpoint remains the preferred endpoint when RPC_URL is set; RPC_TOKEN, if set,
// is sent to it (and only to it) as a Bearer token. Public
// endpoints are rotated behind it and take over while it is cooling down. Sepolia currently uses
// only the public pool because RPC_URL has historically meant the mainnet name-resolution RPC.
//
// Workers share egress IPs, so a public endpoint that works from a browser can still reject every
// Worker request (0xrpc.io answered 404 and Tenderly 429 from Workers in October 2026). Probe
// candidates from a Worker, not from a laptop, before adding them here.

export const RPCS = [
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
  'https://eth-pokt.nodies.app',
  'https://rpc.mevblocker.io',
  'https://eth.rpc.blxrbdn.com',
  'https://ethereum-rpc.publicnode.com',
];

export const SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
];

export const CHAINS = {
  1: { short: 'eth', rpcs: RPCS },
  11155111: { short: 'sep', rpcs: SEPOLIA_RPCS },
};

export const SHORT_TO_CHAIN = Object.fromEntries(
  Object.entries(CHAINS).map(([id, chain]) => [chain.short, Number(id)]),
);

export const RPC_BROKER_SHARDS = 4;
export const RPC_TIMEOUT_MS = 5_000;
export const RPC_PAGE_TIMEOUT_MS = 15_000;
export const RPC_COOLDOWN_MS = 30_000;
export const RPC_MAX_INFLIGHT_PER_SHARD = 6;
export const RPC_MAX_QUEUE_PER_SHARD = 50;
export const RPC_MAX_QUEUE_WAIT_MS = 5_000;

export function rpcEndpointConfig(chainId, env) {
  const chain = CHAINS[chainId];
  if (!chain) return null;

  const configured = chainId === 1 && typeof env?.RPC_URL === 'string'
    ? env.RPC_URL.trim()
    : '';
  const preferred = /^https?:\/\//i.test(configured) ? configured : null;
  const endpoints = [...new Set(preferred ? [preferred, ...chain.rpcs] : chain.rpcs)];
  const token = preferred && typeof env?.RPC_TOKEN === 'string' ? env.RPC_TOKEN.trim() : '';
  return { endpoints, preferred, preferredAuth: token ? `Bearer ${token}` : null };
}
