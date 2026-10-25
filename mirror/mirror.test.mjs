// Tests for gwei-mirror against a fake chain, a fake Kubo (which names blocks the way Kubo does: a
// keccak-256 or sha2-256 raw CID of the bytes) and fake post sources. Run: `node --test *.test.mjs`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { blobCid, encodeBlob, encodePost, postCid, postHash } from '../gateway/posts-format.js';
import { T_AUTHORIZED as GATEWAY_AUTHORIZED, T_BLOB_PUBLISHED as GATEWAY_PUBLISHED } from '../gateway/posts-store.js';
import { blobVersionedHash } from '../dapp/vendor/kzg.bundle.mjs';
import { CONTRACT, FROM_BLOCK, Kubo, Mirror, T_AUTHORIZED, T_BLOB_PUBLISHED } from './mirror.mjs';

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const pad32 = (h) => h.padStart(64, '0');
const ALICE = '0x' + 'a1'.repeat(20);
const TOKEN = '0x' + pad32('a11ce');
const at = (n) => FROM_BLOCK + n;

function fakeWorld() {
  const world = { head: at(5000), logs: [], sources: {}, blobs: {}, blobscan: {}, network: {}, blocks: new Map(), pins: new Set(), calls: [] };
  world.fetch = async (url, init = {}) => {
    world.calls.push(url);
    if (url === 'https://rpc.test/') {
      const { method, params } = JSON.parse(init.body);
      const ok = (result) => Response.json({ jsonrpc: '2.0', id: 1, result });
      if (method === 'eth_getBlockByNumber') return ok({ number: '0x' + world.head.toString(16) });
      if (method === 'eth_getLogs') {
        const [{ fromBlock, toBlock, address }] = params;
        assert.equal(address, CONTRACT);
        return ok(world.logs.filter((l) => Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock)));
      }
      throw new Error('unexpected RPC ' + method);
    }
    const kubo = /^http:\/\/kubo\.test\/api\/v0\/([a-z/]+)\??(.*)$/.exec(url);
    if (kubo) {
      const [, command, query] = kubo;
      const q = new URLSearchParams(query);
      if (command === 'block/put') {
        const bytes = new Uint8Array(await init.body.get('file').arrayBuffer());
        const cid = q.get('mhtype') === 'keccak-256' ? postCid(postHash(bytes)) : await blobCid(bytes);
        world.blocks.set(cid, bytes);
        if (q.get('pin') === 'true') world.pins.add(cid);
        return Response.json({ Key: cid, Size: bytes.length });
      }
      if (command === 'block/get') {
        const bytes = world.blocks.get(q.get('arg')) || world.network[q.get('arg')];
        return bytes ? new Response(bytes) : Response.json({ Message: 'context deadline exceeded' }, { status: 500 });
      }
      if (command === 'pin/ls') return Response.json({ Keys: Object.fromEntries([...world.pins].map((cid) => [cid, { Type: 'recursive' }])) });
      throw new Error('unexpected IPFS call ' + command);
    }
    const raw = /^https:\/\/src\.test\/api\/posts\/(0x[0-9a-f]{64})\/raw$/.exec(url);
    if (raw) return world.sources[raw[1]] ? new Response(world.sources[raw[1]]) : new Response('no', { status: 404 });
    const blob = /^https:\/\/src\.test\/api\/blobs\/(0x[0-9a-f]{64})$/.exec(url);
    if (blob) return world.blobs[blob[1]] ? new Response(world.blobs[blob[1]]) : new Response('no', { status: 404 });
    const blobscan = /^https:\/\/blobscan\.test\/blobs\/(0x[0-9a-f]{64})\/data$/.exec(url);
    if (blobscan) return world.blobscan[blobscan[1]] ? Response.json('0x' + toHex(world.blobscan[blobscan[1]])) : new Response('no', { status: 404 });
    throw new Error('unexpected fetch ' + url);
  };
  return world;
}

const logOf = (block, idx, topics, data = '0x') => ({
  address: CONTRACT, blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16),
  transactionHash: '0x' + pad32(`${block}${idx}`), topics, data, removed: false,
});
const authorized = (block, hash, vh) => logOf(block, 0, [T_AUTHORIZED, TOKEN, hash, '0x' + pad32(ALICE.slice(2))], '0x' + vh.slice(2) + pad32('9b') + pad32('0'));
const published = (block, vh) => logOf(block, 1, [T_BLOB_PUBLISHED, vh, '0x' + pad32('9b')], '0x' + pad32('0'));
const post = (title, body = 'Body of ' + title) => { const bytes = encodePost({ title, body }); return { bytes, hash: postHash(bytes) }; };

function makeMirror(world, dir, extra = {}) {
  let now = 1_800_000_000;
  const mirror = new Mirror({
    ipfs: new Kubo('http://kubo.test', world.fetch), rpcs: ['https://rpc.test/'], sources: ['https://src.test'], blobscan: 'https://blobscan.test',
    statePath: join(dir, 'state.json'), fetchImpl: world.fetch, now: () => now, ...extra,
  });
  mirror.advance = (seconds) => { now += seconds; };
  return mirror;
}

const withDir = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gwei-mirror-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('the event topics and contract are the gateway’s', () => {
  assert.equal(T_AUTHORIZED, GATEWAY_AUTHORIZED);
  assert.equal(T_BLOB_PUBLISHED, GATEWAY_PUBLISHED);
  const toml = readFileSync(new URL('../gateway/wrangler.toml', import.meta.url), 'utf8');
  assert.equal(/POSTS_CONTRACT = '(0x[0-9a-fA-F]{40})'/.exec(toml)[1].toLowerCase(), CONTRACT);
  assert.equal(Number(/POSTS_FROM_BLOCK = '(\d+)'/.exec(toml)[1]), FROM_BLOCK);
});

test('every post on Ethereum is pinned, with its blob, by the CIDs Kubo gives them, and nothing else', withDir(async (dir) => {
  const world = fakeWorld();
  const a = post('On Ethereum');
  const blobA = encodeBlob([a.bytes]);
  const vhA = blobVersionedHash(blobA);
  const pending = post('Authorized, never published');
  const packed = post('Packed with another post');
  const blobP = encodeBlob([post('neighbour').bytes, packed.bytes]);
  const vhP = blobVersionedHash(blobP);
  world.sources = { [a.hash]: a.bytes, [pending.hash]: pending.bytes, [packed.hash]: packed.bytes };
  world.blobs = { [vhP]: blobP };
  world.logs.push(
    authorized(at(10), a.hash, vhA), published(at(11), vhA),
    authorized(at(2500), pending.hash, blobVersionedHash(encodeBlob([pending.bytes]))),
    authorized(at(4000), packed.hash, vhP), published(at(4000), vhP),
  );
  const mirror = makeMirror(world, dir);
  assert.deepEqual(await mirror.round(), { posts: 2, pinned: 2, added: 2, waiting: 0, block: world.head });
  assert.deepEqual([...world.pins].sort(), [postCid(a.hash), await blobCid(blobA), postCid(packed.hash), await blobCid(blobP)].sort());
  assert.equal(world.calls.filter((u) => u.includes(pending.hash)).length, 0, 'a post nobody published is not fetched');

  // Progress is saved: a restart reads no old blocks and pins nothing twice.
  const calls = world.calls.length;
  const again = makeMirror(world, dir);
  assert.deepEqual(await again.round(), { posts: 2, pinned: 2, added: 0, waiting: 0, block: world.head });
  assert.equal(world.calls.slice(calls).filter((u) => u.includes('kubo.test/api/v0/block')).length, 0);
}));

test('posts nobody else has come from IPFS, and only bytes that hash to the post are taken', withDir(async (dir) => {
  const world = fakeWorld();
  const a = post('Only on IPFS');
  const vh = blobVersionedHash(encodeBlob([a.bytes]));
  world.sources = { [a.hash]: post('Only on IPFS', 'tampered').bytes };
  world.logs.push(authorized(at(10), a.hash, vh), published(at(11), vh));
  const mirror = makeMirror(world, dir);
  assert.equal((await mirror.round()).waiting, 1, 'the source lied and IPFS has nothing yet');
  world.network[postCid(a.hash)] = a.bytes; // someone else pins it
  mirror.advance(600);
  assert.equal((await mirror.round()).pinned, 1);
  assert.ok(world.pins.has(postCid(a.hash)));
}));

test('a blob that is not the one published, or lacks the post, is not taken, and it is retried later', withDir(async (dir) => {
  const world = fakeWorld();
  const p = post('Packed');
  const real = encodeBlob([p.bytes, post('other').bytes]);
  const vh = blobVersionedHash(real);
  world.sources = { [p.hash]: p.bytes };
  world.blobs = { [vh]: encodeBlob([p.bytes, post('smuggled').bytes]) }; // carries the post, but isn't the blob
  world.logs.push(authorized(at(10), p.hash, vh), published(at(11), vh));
  const mirror = makeMirror(world, dir);
  assert.equal((await mirror.round()).waiting, 1);
  world.blobscan = { [vh]: real };
  mirror.advance(60);
  assert.equal((await mirror.round()).waiting, 1, 'it waits for its backoff');
  mirror.advance(600);
  assert.equal((await mirror.round()).pinned, 1, 'then Blobscan’s copy, checked, is taken');
  assert.ok(world.pins.has(await blobCid(real)));
}));

test('posts the node lost are pinned again at the daily check', withDir(async (dir) => {
  const world = fakeWorld();
  const a = post('Lost and found');
  const vh = blobVersionedHash(encodeBlob([a.bytes]));
  world.sources = { [a.hash]: a.bytes };
  world.logs.push(authorized(at(10), a.hash, vh), published(at(11), vh));
  const mirror = makeMirror(world, dir);
  await mirror.round();
  world.pins.clear(); // the IPFS repo was wiped
  mirror.advance(3600);
  assert.equal((await mirror.round()).added, 0, 'checked once a day');
  mirror.advance(86400);
  assert.equal((await mirror.round()).added, 1);
  assert.ok(world.pins.has(postCid(a.hash)));
}));

test('the command explains itself, and what to do without an IPFS node', async () => {
  const run = promisify(execFile);
  const script = new URL('./gwei-mirror.mjs', import.meta.url).pathname;
  const help = await run(process.execPath, [script, '--help']);
  assert.match(help.stdout, /Usage: gwei-mirror/);
  const error = await run(process.execPath, [script, '--ipfs', 'http://127.0.0.1:9', '--once']).catch((e) => e);
  assert.equal(error.code, 1);
  assert.match(error.stderr, /Can't reach an IPFS node[\s\S]*docker run/);
});
