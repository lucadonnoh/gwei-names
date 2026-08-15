import {
  RPC_COOLDOWN_MS,
  RPC_MAX_INFLIGHT_PER_SHARD,
  RPC_MAX_QUEUE_PER_SHARD,
  RPC_MAX_QUEUE_WAIT_MS,
  RPC_TIMEOUT_MS,
} from './rpc-config.js';

// JSON-RPC wraps byte responses as hex, so this permits roughly 2 MiB of contract content while
// bounding the JSON string and decoder copies well below the Worker's per-isolate memory limit.
export const MAX_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function readRpcJson(response) {
  const declaredLength = response.headers.get('content-length');
  const declaredBytes = declaredLength && /^\d+$/.test(declaredLength) ? Number(declaredLength) : null;
  if (declaredBytes !== null && declaredBytes > MAX_RPC_RESPONSE_BYTES) {
    try { await response.body?.cancel('RPC response exceeds size limit'); } catch (_) {}
    throw new Error('RPC response exceeds size limit');
  }
  if (!response.body) throw new Error('RPC response has no body');

  const reader = response.body.getReader();
  let bytes = new Uint8Array(
    declaredBytes !== null && Number.isSafeInteger(declaredBytes) ? declaredBytes : 16 * 1024,
  );
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextTotal = total + value.byteLength;
      if (nextTotal > MAX_RPC_RESPONSE_BYTES) {
        try { await reader.cancel('RPC response exceeds size limit'); } catch (_) {}
        throw new Error('RPC response exceeds size limit');
      }
      if (nextTotal > bytes.byteLength) {
        const capacity = Math.min(
          MAX_RPC_RESPONSE_BYTES,
          Math.max(nextTotal, Math.max(16 * 1024, bytes.byteLength * 2)),
        );
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(value, total);
      total = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total)));
}

function isRateLimited(message) {
  return /rate|limit|429|too many|capacity|quota|exceeded/i.test(message || '');
}

function shouldBenchStatus(status) {
  return status === 401 || status === 403 || status === 404 || status === 408 ||
    status === 429 || status >= 500;
}

// One broker shard owns one RpcPool. Its mutable state is deliberately ephemeral: losing an
// endpoint cooldown or round-robin cursor on Durable Object eviction affects efficiency, never
// correctness. In-flight calls keep the object alive and are coalesced by exact call identity.
export class RpcPool {
  constructor({
    // Keep the runtime fetch call unbound. Calling a captured host function as an object property
    // can give it the wrong receiver in workerd even though Node's fetch tolerates that shape.
    fetchImpl = (input, init) => fetch(input, init),
    now = () => Date.now(),
    timeoutMs = RPC_TIMEOUT_MS,
    cooldownMs = RPC_COOLDOWN_MS,
    maxInflight = RPC_MAX_INFLIGHT_PER_SHARD,
    maxQueue = RPC_MAX_QUEUE_PER_SHARD,
    maxQueueWaitMs = RPC_MAX_QUEUE_WAIT_MS,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.maxInflight = maxInflight;
    this.maxQueue = maxQueue;
    this.maxQueueWaitMs = maxQueueWaitMs;
    this.active = 0;
    this.waiting = [];
    this.inflight = new Map();
    this.unhealthyUntil = new Map();
    this.rrCursor = 0;
  }

  rpc({ to, data, endpoints, preferred = null, timeoutMs = this.timeoutMs }) {
    // Include endpoint configuration and timeout class so a deployment/config change cannot join
    // an older call that happens to have identical calldata.
    const key = `${timeoutMs}\0${preferred || ''}\0${endpoints.join('\0')}\0${to}\0${data}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const task = this.#run({ to, data, endpoints, preferred, timeoutMs });
    this.inflight.set(key, task);
    const clear = () => {
      if (this.inflight.get(key) === task) this.inflight.delete(key);
    };
    task.then(clear, clear);
    return task;
  }

  async #run(input) {
    if (!await this.#acquire()) return { overloaded: true };
    try {
      return await this.#perform(input);
    } finally {
      this.#release();
    }
  }

  async #acquire() {
    if (this.active < this.maxInflight) {
      this.active++;
      return true;
    }
    if (this.waiting.length >= this.maxQueue) return false;

    return new Promise((resolve) => {
      const waiter = { resolve, settled: false, timer: null };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        resolve(false);
      }, this.maxQueueWaitMs);
      this.waiting.push(waiter);
    });
  }

  #release() {
    while (this.waiting.length) {
      const waiter = this.waiting.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      // Hand the occupied slot directly to the waiter; active stays unchanged.
      waiter.resolve(true);
      return;
    }
    this.active--;
  }

  #orderEndpoints(endpoints, preferred) {
    const unique = [...new Set(endpoints.filter(Boolean))];
    const fallback = preferred ? unique.filter((url) => url !== preferred) : unique;
    const start = fallback.length ? this.rrCursor++ % fallback.length : 0;
    const rotated = fallback.length
      ? [...fallback.slice(start), ...fallback.slice(0, start)]
      : [];
    const ordered = preferred && unique.includes(preferred) ? [preferred, ...rotated] : rotated;
    const healthy = [];
    const benched = [];
    const now = this.now();
    for (const url of ordered) {
      const until = this.unhealthyUntil.get(url) || 0;
      if (until > now) {
        benched.push(url);
      } else {
        if (until) this.unhealthyUntil.delete(url);
        healthy.push(url);
      }
    }
    // Benched endpoints remain last-resort probes if every healthy endpoint fails.
    return [...healthy, ...benched];
  }

  #bench(url) {
    this.unhealthyUntil.set(url, this.now() + this.cooldownMs);
  }

  async #perform({ to, data, endpoints, preferred, timeoutMs }) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    });

    for (const url of this.#orderEndpoints(endpoints, preferred)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch (_) {}
          if (shouldBenchStatus(response.status)) this.#bench(url);
          continue;
        }

        const json = await readRpcJson(response);
        if (typeof json?.result === 'string') {
          this.unhealthyUntil.delete(url);
          return json.result === '0x' ? { empty: true } : { result: json.result };
        }
        if (json?.error) {
          const message = json.error?.message || 'rpc error';
          if (/revert/i.test(message)) return { reverted: true };
          if (isRateLimited(message)) this.#bench(url);
          continue;
        }

        // A 2xx response that is not JSON-RPC is an endpoint failure, not a definitive answer.
        this.#bench(url);
      } catch (_) {
        // Transport errors, body timeouts, malformed JSON, and over-sized responses all implicate
        // this endpoint. Try the rest of the pool and deprioritize it for the next call.
        this.#bench(url);
      } finally {
        clearTimeout(timer);
      }
    }
    return { failed: true };
  }
}
