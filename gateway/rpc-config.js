// RPC endpoint configuration shared by the request Worker and its Durable Object brokers.
//
// A dedicated mainnet endpoint remains the preferred endpoint when RPC_URL is set. Public
// endpoints are rotated behind it and take over while it is cooling down. Sepolia currently uses
// only the public pool because RPC_URL has historically meant the mainnet name-resolution RPC.

export const RPCS = [
  'https://0xrpc.io/eth',
  'https://gateway.tenderly.co/public/mainnet',
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
  return { endpoints, preferred };
}
