// Tests for the network stats index (stats-store.js) on node:sqlite with a scripted chain.
// Run: `node --test stats.test.js`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StatsStore } from './stats-store.js';
import { keccak256 } from './web3-auto.js';

const utf8 = (s) => new TextEncoder().encode(s);
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const topic = (sig) => '0x' + toHex(keccak256(utf8(sig)));
const NAMENFT = '0x9d51d507bc7264d4fe8ad1cf7fe191933a0a81d6';
const DEPLOY = 25403689;
const T_NAME = topic('NameRegistered(uint256,string,address,uint256)');
const T_CH = topic('ContenthashChanged(bytes32,bytes)');
const T_TEXT = topic('TextChanged(bytes32,string,string)');

function memorySql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...params) {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|WITH)/i.test(query)) {
        const rows = statement.all(...params);
        return { toArray: () => rows };
      }
      statement.run(...params);
      return { toArray: () => [] };
    },
  };
}

const node = (n) => '0x' + word(n);
const dynamic = (bytes) => word(bytes.length) + toHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, '0');
const base = (block, extra) => ({ address: NAMENFT, blockNumber: '0x' + block.toString(16), logIndex: '0x0', ...extra });
const registered = (block, id, label, top = true) => base(block, {
  topics: [T_NAME, node(id), '0x' + word(0xa11ce)], data: '0x' + word(0x40) + word(top ? 1893456000 : 0) + dynamic(utf8(label)),
});
const contenthash = (block, id, bytes) => base(block, { topics: [T_CH, node(id)], data: '0x' + word(0x20) + dynamic(bytes) });
const text = (block, id, key, value) => base(block, { topics: [T_TEXT, node(id), topic(key)], data: '0x' + word(0x20) + dynamic(utf8(value)) });

// A chain that serves `logs` by block range; `refuse` makes ranges wider than it allow fail.
function chain(logs, { head = DEPLOY + 1000, refuse = Infinity, balance = '0x6f05b59d3b20000' } = {}) {
  const calls = [];
  return {
    calls,
    head: async () => head,
    rpc: async (method) => { if (method === 'eth_getBalance') return balance; throw new Error(method); },
    async logs(filter) {
      const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
      calls.push([from, to]);
      if (to - from + 1 > refuse) throw new Error('range too wide');
      return logs.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to; });
    },
  };
}

test('the stats topics are the keccak of NameNFT event signatures, and contentcontract the keccak of its key', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./stats-store.js', import.meta.url), 'utf8');
  for (const t of [T_NAME, T_CH, T_TEXT, topic('contentcontract')]) assert.ok(src.includes(t), t);
});

test('stats count names and subdomains, bucket lengths, and list websites newest record first', async () => {
  const c = chain([
    registered(DEPLOY + 1, 1, 'alice'),
    registered(DEPLOY + 2, 2, 'bob'),
    registered(DEPLOY + 3, 3, 'free', false), // a free subdomain: no expiry
    registered(DEPLOY + 4, 4, 'x'.repeat(30)),
    registered(DEPLOY + 5, 5, '🦄'),
    contenthash(DEPLOY + 10, 1, [0xe3, 1, 2]),
    text(DEPLOY + 20, 2, 'contentcontract', 'eth:0x' + 'ab'.repeat(20)),
    text(DEPLOY + 21, 5, 'description', 'not a website'),
    contenthash(DEPLOY + 22, 3, [0xe3, 1]), // subdomains have no gateway host
    { ...contenthash(DEPLOY + 23, 4, [0xe3]), removed: true },
  ]);
  const store = new StatsStore(memorySql(), c);
  await store.sync();
  const stats = store.stats();
  assert.equal(stats.names, 4);
  assert.equal(stats.subdomains, 1);
  assert.deepEqual(stats.lengths, { 3: 1, 4: 1, 5: 1, 20: 1 }, 'bytes, with 20 and up in one bucket');
  assert.deepEqual(stats.sites, ['bob', 'alice'], 'the newest record first; removed logs and other text keys ignored');
  assert.equal(stats.burnedWei, '500000000000000000');
  assert.equal(stats.ready, true);
});

test('the record a site is dated by is the one the gateway serves, and clearing or re-registering drops it', async () => {
  const c = chain([
    registered(DEPLOY + 1, 1, 'both'),
    contenthash(DEPLOY + 2, 1, [0xe3, 1]),
    text(DEPLOY + 9, 1, 'contentcontract', 'eth:0x' + 'ab'.repeat(20)), // shadowed: dated by the contenthash
    registered(DEPLOY + 3, 2, 'newer'),
    contenthash(DEPLOY + 5, 2, [0xe3, 2]),
    registered(DEPLOY + 4, 3, 'cleared'),
    contenthash(DEPLOY + 6, 3, [0xe3, 3]),
    contenthash(DEPLOY + 7, 3, []),
    registered(DEPLOY + 8, 4, 'resold'),
    contenthash(DEPLOY + 9, 4, [0xe3, 4]),
    registered(DEPLOY + 10, 4, 'resold'), // a new registration: the old owner's site is gone
  ]);
  const store = new StatsStore(memorySql(), c);
  await store.sync();
  assert.deepEqual(store.stats().sites, ['newer', 'both']);
});

test('sync walks big ranges, halves a refused one, and only reports ready once caught up', async () => {
  const head = DEPLOY + 300_000;
  const c = chain([registered(head - 10, 1, 'late')], { head, refuse: 20_000 });
  const store = new StatsStore(memorySql(), c);
  await store.sync();
  assert.deepEqual(c.calls.slice(0, 3).map(([f, t]) => t - f + 1), [50_000, 25_000, 12_500], 'halved until accepted');
  assert.equal(store.stats().ready, false, 'still catching up after one sync');
  for (let i = 0; i < 5 && !store.stats().ready; i++) await store.sync();
  assert.equal(store.stats().ready, true);
  assert.equal(store.stats().names, 1);
  assert.equal(store.stats().block, head - 2, 'indexed to two blocks under the head');
});

test('a refused minimum range fails the sync without moving the cursor', async () => {
  const c = chain([], { head: DEPLOY + 10_000, refuse: 1000 });
  const store = new StatsStore(memorySql(), c);
  await assert.rejects(store.sync(), /range too wide/);
  assert.equal(store.stats().block, DEPLOY - 1);
});
