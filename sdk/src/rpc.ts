import { GNS_CONTRACT } from './constants.js'

const DEFAULT_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://1rpc.io/sepolia',
  'https://sepolia.drpc.org',
]

const RPC_TIMEOUT = 5_000

export interface RpcConfig {
  rpc?: string | string[]
  contract?: `0x${string}`
}

export async function ethCall(data: string, config?: RpcConfig): Promise<string> {
  const contract = config?.contract ?? GNS_CONTRACT
  const endpoints = config?.rpc
    ? Array.isArray(config.rpc)
      ? config.rpc
      : [config.rpc]
    : DEFAULT_RPCS

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: contract, data }, 'latest'],
  })

  for (const url of endpoints) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const json = (await res.json()) as { result?: string; error?: unknown }
      if (json.error) continue
      return json.result ?? '0x'
    } catch {}
  }

  throw new Error('All RPC endpoints failed')
}
