import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcPool } from './rpc-pool.js';

const TO = '0x1111111111111111111111111111111111111111';
const ENDPOINTS = ['https://a.invalid', 'https://b.invalid', 'https://c.invalid'];

function resultResponse(result = '0x01') {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

async function waitFor(predicate, message = 'condition was not reached') {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

test('RpcPool rotates the first public endpoint while keeping a configured RPC preferred', async () => {
  const seen = [];
  const pool = new RpcPool({
    fetchImpl: async (url) => {
      seen.push(url);
      return resultResponse();
    },
  });

  for (const data of ['0x00', '0x01', '0x02']) {
    assert.deepEqual(await pool.rpc({ to: TO, data, endpoints: ENDPOINTS }), { result: '0x01' });
  }
  assert.deepEqual(seen, ENDPOINTS);

  seen.length = 0;
  for (const data of ['0x03', '0x04', '0x05']) {
    await pool.rpc({ to: TO, data, endpoints: ENDPOINTS, preferred: ENDPOINTS[0] });
  }
  assert.deepEqual(seen, [ENDPOINTS[0], ENDPOINTS[0], ENDPOINTS[0]]);
});

test('RpcPool benches a failed endpoint, then probes it again after cooldown', async () => {
  let now = 1_000;
  const seen = [];
  const pool = new RpcPool({
    now: () => now,
    cooldownMs: 30_000,
    fetchImpl: async (url) => {
      seen.push(url);
      return url === ENDPOINTS[0] ? new Response('down', { status: 500 }) : resultResponse();
    },
  });
  const endpoints = ENDPOINTS.slice(0, 2);

  await pool.rpc({ to: TO, data: '0x00', endpoints });
  await pool.rpc({ to: TO, data: '0x01', endpoints });
  await pool.rpc({ to: TO, data: '0x02', endpoints });
  assert.deepEqual(seen, [ENDPOINTS[0], ENDPOINTS[1], ENDPOINTS[1], ENDPOINTS[1]]);

  now += 30_001;
  await pool.rpc({ to: TO, data: '0x03', endpoints });
  await pool.rpc({ to: TO, data: '0x04', endpoints });
  assert.equal(seen.filter((url) => url === ENDPOINTS[0]).length, 2, 'cooled endpoint was re-probed');
});

test('RpcPool aborts a hung endpoint and fails over within the explicit timeout', async () => {
  const seen = [];
  const pool = new RpcPool({
    fetchImpl: (url, init) => {
      seen.push(url);
      if (url !== ENDPOINTS[0]) return Promise.resolve(resultResponse('0x02'));
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    },
  });

  const result = await pool.rpc({ to: TO, data: '0x00', endpoints: ENDPOINTS, timeoutMs: 10 });
  assert.deepEqual(result, { result: '0x02' });
  assert.deepEqual(seen, ENDPOINTS.slice(0, 2));
});

test('RpcPool invokes the runtime fetch host function without an object receiver', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function () {
    assert.equal(this, undefined);
    return Promise.resolve(resultResponse());
  };
  try {
    const pool = new RpcPool();
    assert.deepEqual(
      await pool.rpc({ to: TO, data: '0x00', endpoints: [ENDPOINTS[0]] }),
      { result: '0x01' },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RpcPool single-flights identical calls and releases the key after settlement', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pool = new RpcPool({
    fetchImpl: async () => {
      runs++;
      await gate;
      return resultResponse('0x03');
    },
  });
  const input = { to: TO, data: '0x00', endpoints: ENDPOINTS };

  const herd = Array.from({ length: 10 }, () => pool.rpc(input));
  await waitFor(() => runs === 1, 'the shared upstream call did not start');
  release();
  assert.deepEqual(await Promise.all(herd), Array(10).fill(null).map(() => ({ result: '0x03' })));
  assert.equal(runs, 1);
  assert.equal(pool.inflight.size, 0);

  await pool.rpc(input);
  assert.equal(runs, 2, 'single-flight does not memoize a completed call');
});

test('RpcPool enforces its concurrency ceiling and sheds calls beyond the bounded queue', async () => {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const pool = new RpcPool({
    maxInflight: 2,
    maxQueue: 1,
    maxQueueWaitMs: 1_000,
    fetchImpl: () => new Promise((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active--;
        resolve(resultResponse());
      });
    }),
  });

  const call = (n) => pool.rpc({ to: TO, data: `0x0${n}`, endpoints: [ENDPOINTS[0]] });
  const first = call(0);
  const second = call(1);
  const queued = call(2);
  const shed = call(3);

  assert.deepEqual(await shed, { overloaded: true });
  await waitFor(() => releases.length === 2, 'the first two calls did not occupy the pool');
  releases[0]();
  await waitFor(() => releases.length === 3, 'the queued call did not receive the released slot');
  releases[1]();
  releases[2]();

  assert.deepEqual(await Promise.all([first, second, queued]), [
    { result: '0x01' }, { result: '0x01' }, { result: '0x01' },
  ]);
  assert.equal(maxActive, 2);
  assert.equal(pool.active, 0);
  assert.equal(pool.waiting.length, 0);
});

test('RpcPool sheds a queued call that cannot start within the queue deadline', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pool = new RpcPool({
    maxInflight: 1,
    maxQueue: 1,
    maxQueueWaitMs: 10,
    fetchImpl: async () => {
      await gate;
      return resultResponse();
    },
  });

  const active = pool.rpc({ to: TO, data: '0x00', endpoints: [ENDPOINTS[0]] });
  const expired = pool.rpc({ to: TO, data: '0x01', endpoints: [ENDPOINTS[0]] });
  assert.deepEqual(await expired, { overloaded: true });
  assert.equal(pool.waiting.length, 0);
  release();
  assert.deepEqual(await active, { result: '0x01' });
});

test('an execution revert is definitive and does not fail over or bench the endpoint', async () => {
  const seen = [];
  const pool = new RpcPool({
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' },
      }));
    },
  });
  assert.deepEqual(
    await pool.rpc({ to: TO, data: '0x00', endpoints: ENDPOINTS }),
    { reverted: true },
  );
  assert.deepEqual(seen, [ENDPOINTS[0]]);
  assert.equal(pool.unhealthyUntil.size, 0);
});
