// gwei-mirror's logic (the command is gwei-mirror.mjs): keep every GNS post that is on Ethereum, and
// the blob that carries it, pinned on an IPFS node. posts/SPEC.md, "Mirroring".
//
// Ethereum says which posts exist: GnsPosts' events, read from any RPC. Nothing else is trusted. A
// post's bytes may come from anywhere (gwei.domains, IPFS, another mirror) because they must hash to
// the postHash on-chain, and a post counts as on Ethereum only once a published blob is shown to carry
// it: its own blob, rebuilt from the post and checked against the versioned hash with KZG, or a
// fetched blob checked the same way. The node then holds the post under the CID its hash gives (so
// anyone can find it from the chain alone) and the blob under the CID the publisher pins it with.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BLOB_BYTES, MAX_POST_BYTES, blobCid, decodeBlob, encodeBlob, parsePost, postCid, postHash } from '../gateway/posts-format.js';
import { RPCS } from '../gateway/rpc-config.js';
import { hexToBytes } from '../gateway/web3-auto.js';

export const CONTRACT = '0x73849f6f2785ba7fd2f41b5b4573b75554417981'; // GnsPosts on mainnet
export const FROM_BLOCK = 26268082; // its deployment block
export const T_AUTHORIZED = '0x521590a9cca024d1ff93e37c9ee8f521cee9c2da79903939763c3c34bdb7eb28';
export const T_BLOB_PUBLISHED = '0xb51cc50f0049ae8836824f5ee55fbae269ff6cf4ff8fc6390b721310d5ade99b';
export const DEFAULT_SOURCES = ['https://gwei.domains'];
export const BLOBSCAN = 'https://api.blobscan.com';
const LOG_RANGE = 2000; // blocks per eth_getLogs: public RPCs cap ranges
const RPC_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const IPFS_GET_SECONDS = 30;
const MAX_RETRY_SECONDS = 86400;
const PIN_CHECK_SECONDS = 86400;
const STATE_VERSION = 1;

// The node's RPC API (Kubo, which IPFS Desktop runs too).
export class Kubo {
  constructor(url, fetchImpl = fetch) {
    this.url = url.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async call(path, { file, timeoutMs = 60_000, binary = false } = {}) {
    const init = { method: 'POST', signal: AbortSignal.timeout(timeoutMs) };
    if (file) {
      init.body = new FormData();
      init.body.append('file', new Blob([file]));
    }
    const response = await this.fetchImpl(`${this.url}/api/v0/${path}`, init);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text;
      try { message = JSON.parse(text).Message || text; } catch (_) {}
      throw new Error(`IPFS ${path.split('?')[0]}: ${message.slice(0, 200) || 'HTTP ' + response.status}`);
    }
    return binary ? new Uint8Array(await response.arrayBuffer()) : response.json();
  }

  id() { return this.call('id', { timeoutMs: 10_000 }); }

  // Stores and pins a raw block; the CID comes from Kubo hashing it, so it's checked by the caller.
  async put(bytes, mhtype) {
    return (await this.call(`block/put?cid-codec=raw&mhtype=${mhtype}&pin=true`, { file: bytes })).Key;
  }

  async get(cid, seconds = IPFS_GET_SECONDS) {
    try {
      return await this.call(`block/get?arg=${cid}&timeout=${seconds}s`, { binary: true, timeoutMs: (seconds + 5) * 1000 });
    } catch (_) {
      return null;
    }
  }

  async pinned() {
    return new Set(Object.keys((await this.call('pin/ls?type=recursive&quiet=true', { timeoutMs: 300_000 })).Keys || {}));
  }
}

export class Mirror {
  constructor({ ipfs, rpcs = RPCS, sources = DEFAULT_SOURCES, blobscan = BLOBSCAN, statePath, fetchImpl = fetch,
    now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
    this.ipfs = ipfs;
    this.rpcs = rpcs;
    this.sources = sources.map((s) => s.replace(/\/+$/, ''));
    this.blobscan = blobscan;
    this.statePath = statePath;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.state = this.load();
  }

  load() {
    let state = null;
    try { state = JSON.parse(readFileSync(this.statePath, 'utf8')); } catch (_) {}
    if (state?.v !== STATE_VERSION || state.contract !== CONTRACT) {
      state = { v: STATE_VERSION, contract: CONTRACT, cursor: FROM_BLOCK - 1, claims: {}, published: {}, done: {}, retry: {}, pinCheck: 0 };
    }
    return state;
  }

  save() {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.statePath);
  }

  // One pass: read new events, re-pin anything the node lost (once a day), pin what's missing.
  async round() {
    await this.readChain();
    if (this.now() - this.state.pinCheck >= PIN_CHECK_SECONDS) await this.checkPins();
    const now = this.now();
    const due = this.onEthereum().filter((hash) => !this.state.done[hash] && (this.state.retry[hash]?.next ?? 0) <= now);
    let added = 0;
    for (const hash of due) {
      if (await this.mirrorPost(hash)) added++;
      this.save();
    }
    const posts = this.onEthereum().filter((hash) => !this.state.done[hash]?.skipped);
    const pinned = posts.filter((hash) => this.state.done[hash]).length;
    return { posts: posts.length, pinned, added, waiting: posts.length - pinned, block: this.state.cursor };
  }

  // Posts some published blob was named for. The blob must still be shown to carry the post.
  onEthereum() {
    return Object.keys(this.state.claims).filter((hash) => this.state.claims[hash].some((vh) => this.state.published[vh]));
  }

  async readChain() {
    const head = await this.finalized();
    for (let n = 1; this.state.cursor < head; n++) {
      const from = this.state.cursor + 1;
      const to = Math.min(head, from + LOG_RANGE - 1);
      const logs = await this.rpc('eth_getLogs', [{
        address: CONTRACT, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [[T_AUTHORIZED, T_BLOB_PUBLISHED]],
      }]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs: not a list');
      for (const log of logs) this.ingest(log);
      this.state.cursor = to;
      if (n % 25 === 0 || to === head) this.save();
    }
  }

  ingest(log) {
    if (log.removed || log.address?.toLowerCase() !== CONTRACT) return;
    const topics = (log.topics || []).map((t) => t.toLowerCase());
    const data = (log.data || '').toLowerCase();
    if (topics[0] === T_AUTHORIZED && topics.length === 4 && /^0x[0-9a-f]{192}$/.test(data)) {
      const hash = topics[2], vh = '0x' + data.slice(2, 66);
      const claims = (this.state.claims[hash] ||= []);
      if (!claims.includes(vh)) claims.push(vh);
    } else if (topics[0] === T_BLOB_PUBLISHED && topics.length === 3) {
      this.state.published[topics[1]] = Number(BigInt(log.blockNumber));
    }
  }

  // The newest finalized block, so a reorg can't add or drop an event already read.
  async finalized() {
    try {
      const block = await this.rpc('eth_getBlockByNumber', ['finalized', false]);
      if (block?.number) return Number(BigInt(block.number));
    } catch (_) {}
    return Number(BigInt(await this.rpc('eth_blockNumber', []))) - 64;
  }

  async rpc(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const failures = [];
    const start = this.rpcAt || 0;
    for (let i = 0; i < this.rpcs.length; i++) {
      const at = (start + i) % this.rpcs.length;
      const url = this.rpcs[at];
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        const json = response.ok ? await response.json() : null;
        if (json && 'result' in json && json.result !== null) {
          this.rpcAt = at; // stay on an endpoint that works
          return json.result;
        }
        failures.push(`${new URL(url).host}: ${json?.error?.message || 'HTTP ' + response.status}`);
      } catch (error) {
        failures.push(`${new URL(url).host}: ${error.message}`);
      }
    }
    throw new Error(`${method} failed on every RPC (${failures.join('; ').slice(0, 300)})`);
  }

  async mirrorPost(hash) {
    const bytes = await this.postBytes(hash);
    if (!bytes) return this.later(hash);
    const post = parsePost(bytes);
    if (!post) { // an authorized hash whose bytes aren't a post: nothing to keep
      this.state.done[hash] = { skipped: 'not a post' };
      return false;
    }
    const carrier = await this.carrier(hash, bytes);
    if (!carrier) return this.later(hash);
    const cid = await this.ipfs.put(bytes, 'keccak-256');
    if (cid !== postCid(hash)) throw new Error(`IPFS stored post ${hash} as ${cid}, expected ${postCid(hash)}`);
    const blobCidExpected = await blobCid(carrier.blob);
    const blobPinned = await this.ipfs.put(carrier.blob, 'sha2-256');
    if (blobPinned !== blobCidExpected) throw new Error(`IPFS stored blob ${carrier.vh} as ${blobPinned}, expected ${blobCidExpected}`);
    this.state.done[hash] = { cid, blob: carrier.vh, blobCid: blobPinned, title: post.title };
    delete this.state.retry[hash];
    this.log(`pinned "${post.title}" (${cid})`);
    return true;
  }

  // Not found yet (the post's bytes or a blob that carries it): try again later, backing off to a day.
  later(hash) {
    const tries = (this.state.retry[hash]?.tries ?? 0) + 1;
    this.state.retry[hash] = { tries, next: this.now() + Math.min(600 * 2 ** (tries - 1), MAX_RETRY_SECONDS) };
    return false;
  }

  // The post's bytes from any source, kept only if they hash to the post.
  async postBytes(hash) {
    for (const source of this.sources) {
      const bytes = await this.fetchBytes(`${source}/api/posts/${hash}/raw`, MAX_POST_BYTES);
      if (bytes && postHash(bytes) === hash) return bytes;
    }
    const bytes = await this.ipfs.get(postCid(hash));
    return bytes && postHash(bytes) === hash ? bytes : null;
  }

  // A published blob the post was named for that carries it, checked against its versioned hash.
  async carrier(hash, bytes) {
    const { blobVersionedHash } = await import('../dapp/vendor/kzg.bundle.mjs');
    const named = this.state.claims[hash].filter((vh) => this.state.published[vh]);
    const own = encodeBlob([bytes]);
    const ownVh = blobVersionedHash(own);
    if (named.includes(ownVh)) return { vh: ownVh, blob: own };
    // A blob with other posts in it (self-publishers can pack several): fetch it.
    for (const vh of named) {
      for (const url of [...this.sources.map((s) => `${s}/api/blobs/${vh}`), `${this.blobscan}/blobs/${vh}/data`]) {
        let blob = await this.fetchBytes(url, BLOB_BYTES * 2 + 4);
        if (blob && blob.length !== BLOB_BYTES) { // Blobscan answers a JSON hex string
          try { const hex = JSON.parse(new TextDecoder().decode(blob)); blob = /^0x[0-9a-fA-F]+$/.test(hex) ? hexToBytes(hex.slice(2)) : null; } catch (_) { blob = null; }
        }
        if (blob?.length === BLOB_BYTES && blobVersionedHash(blob) === vh && decodeBlob(blob).some((entry) => postHash(entry) === hash)) {
          return { vh, blob };
        }
      }
    }
    return null;
  }

  // A response body, or null on any failure or once it passes `max` bytes.
  async fetchBytes(url, max) {
    try {
      const response = await this.fetchImpl(url, { headers: { 'user-agent': 'gwei-mirror' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > max) return null;
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      return bytes;
    } catch (_) {
      return null;
    }
  }

  // Posts whose pins the node no longer has (a wiped repo, a manual unpin) are mirrored again.
  async checkPins() {
    const pinned = await this.ipfs.pinned();
    let lost = 0;
    for (const [hash, done] of Object.entries(this.state.done)) {
      if (done.skipped || (pinned.has(done.cid) && pinned.has(done.blobCid))) continue;
      delete this.state.done[hash];
      lost++;
    }
    if (lost) this.log(`${lost} post(s) are no longer pinned on this node; pinning them again`);
    this.state.pinCheck = this.now();
    this.save();
  }
}
