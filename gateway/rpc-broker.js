import { DurableObject } from 'cloudflare:workers';
import {
  CHAINS,
  RPC_PAGE_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  rpcEndpointConfig,
} from './rpc-config.js';
import { RpcPool } from './rpc-pool.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CALLDATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const MAX_CALLDATA_CHARS = 512 * 1024;

// RPC coordination lives here rather than in module globals in worker.js. Normal Worker isolates
// may serve unrelated request contexts and must not share I/O promises between them; a Durable
// Object is the platform primitive intended for exactly this kind of cross-request coordination.
export class RpcBroker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pools = new Map();
  }

  async rpc(input) {
    const chainId = Number(input?.chainId);
    const to = input?.to;
    const data = input?.data;
    if (!CHAINS[chainId] || !ADDRESS.test(to || '') || !CALLDATA.test(data || '') ||
        data.length > MAX_CALLDATA_CHARS) {
      return { failed: true };
    }

    const config = rpcEndpointConfig(chainId, this.env);
    if (!config?.endpoints.length) return { failed: true };
    let pool = this.pools.get(chainId);
    if (!pool) {
      pool = new RpcPool();
      this.pools.set(chainId, pool);
    }
    return pool.rpc({
      to,
      data,
      ...config,
      timeoutMs: input?.long ? RPC_PAGE_TIMEOUT_MS : RPC_TIMEOUT_MS,
    });
  }
}
