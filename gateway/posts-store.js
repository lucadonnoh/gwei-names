// The gateway's index of GNS posts (posts/SPEC.md), rebuilt from public data only: the GnsPosts
// contract's events and the blobs they name. Every publisher's blobs count the same, ours included.
// Post bytes arrive either in a blob or through the upload API (anyone may upload; bytes are kept
// because their keccak-256 hash is what the name's owner authorized, so the source doesn't matter).
// Only blobs named by an authorized post are fetched and kept.
//
// The logic lives here, over a SQLite handle shaped like Durable Object storage (`sql.exec`), so it
// runs under Node in tests; posts-index.js wraps it in the Durable Object.

import { MAX_POST_BYTES, BLOB_BYTES, decodeBlob, parsePost, postHash } from './posts-format.js';
import { MULTICALL3, decodeAggregate3, encodeAggregate3 } from './profile-page.js';
import { readRpcJson } from './rpc-pool.js';
import { rpcEndpointConfig } from './rpc-config.js';
import { hexToBytes } from './web3-auto.js';

export const T_AUTHORIZED = '0x60bb4b36f4267731c8172311f0cc8b8b570684bb18146de3eecd621a3d2d6b99'; // PostAuthorized(uint256,bytes32,address,address,uint256)
export const T_PUBLISHED = '0xb6a6d902d5e84c31e56c5494561be47a4365c35aa01be024ce175b76f1e1312e'; // PostPublished(bytes32,bytes32,address)
export const T_REMOVED = '0xb436f9efc5db52a352858f3e68c0e4cf41e7c50b0ef72366bd2f05e7263df3ee'; // PostRemoved(uint256,bytes32,address)
const NAMENFT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
const SEL_GETFULLNAME = '465411c1'; // getFullName(uint256)
const SEL_OWNEROF = '6352211e'; // ownerOf(uint256)
const SEL_RESOLVE = '4f896d4f'; // resolve(uint256): zero unless active

const CONFIRMATIONS = 2; // index up to head - 2, so a one-block reorg can't leave a phantom event
const LOG_RANGE = 2000; // blocks per eth_getLogs (public RPCs cap ranges)
const LOG_RANGES_PER_SYNC = 5;
const BLOBS_PER_SYNC = 3;
const BLOB_MAX_TRIES = 60; // with the 6-hour backoff cap, about two weeks
const PENDING_SECONDS = 86400; // an authorized post shows for a day while it waits for its blob
const UPLOAD_TTL_SECONDS = 86400; // uploaded bytes no owner authorized are dropped after this
// Unclaimed uploads are capped by size. Bytes an owner already authorized skip every limit, so a
// flood of junk can delay posting but never block it: authorize first, then upload.
const MAX_UNCLAIMED_BYTES = 256 * 1024 * 1024;
const UPLOADS_PER_HOUR = 20; // per client IP (IPv6: per /64)
const OWNER_CACHE_SECONDS = 60;
const BEACON_GENESIS = 1606824023; // mainnet beacon genesis time; slots are 12 s
const RPC_TIMEOUT_MS = 10_000;
const BLOB_TIMEOUT_MS = 15_000;
export const DEFAULT_BLOB_SOURCES = {
  blobscan: 'https://api.blobscan.com',
  beacons: ['https://ethereum-beacon-api.publicnode.com'],
};

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL, title TEXT NOT NULL, time INTEGER, received INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS auth (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, ts INTEGER NOT NULL, token TEXT NOT NULL, hash TEXT NOT NULL, author TEXT NOT NULL, publisher TEXT NOT NULL, fee TEXT NOT NULL, PRIMARY KEY (block, idx))',
  'CREATE INDEX IF NOT EXISTS auth_token ON auth (token, author)',
  'CREATE INDEX IF NOT EXISTS auth_hash ON auth (hash)',
  'CREATE TABLE IF NOT EXISTS pub (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT NOT NULL, blob TEXT NOT NULL, publisher TEXT NOT NULL, PRIMARY KEY (block, idx))',
  'CREATE INDEX IF NOT EXISTS pub_hash ON pub (hash)',
  'CREATE INDEX IF NOT EXISTS pub_blob ON pub (blob)',
  'CREATE TABLE IF NOT EXISTS removal (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, token TEXT NOT NULL, hash TEXT NOT NULL, author TEXT NOT NULL, PRIMARY KEY (block, idx))',
  'CREATE INDEX IF NOT EXISTS removal_key ON removal (token, hash, author)',
  // A blob named by PostPublished: its bytes once fetched, and fetch retries until then.
  'CREATE TABLE IF NOT EXISTS blob (vh TEXT PRIMARY KEY, block INTEGER NOT NULL, ts INTEGER NOT NULL, bytes BLOB, tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0)',
  // Which post hashes a fetched blob really contains.
  'CREATE TABLE IF NOT EXISTS carried (vh TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (vh, hash))',
  'CREATE TABLE IF NOT EXISTS names (token TEXT PRIMARY KEY, name TEXT NOT NULL)',
];

const HASH = /^0x[0-9a-f]{64}$/;
const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
const toBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const word = (data, i) => '0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64);
const topicAddress = (t) => '0x' + t.slice(-40).toLowerCase();
const POS = 100000; // block * POS + log index orders events

export class PostStore {
  constructor(sql, env = {}, { fetchImpl = (input, init) => fetch(input, init), now = () => Math.floor(Date.now() / 1000) } = {}) {
    this.sql = sql;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.uploadsByIp = new Map();
    this.owners = new Map();
    this.syncing = null;
    for (const statement of SCHEMA) sql.exec(statement);
  }

  rows(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  get contract() {
    const value = typeof this.env.POSTS_CONTRACT === 'string' ? this.env.POSTS_CONTRACT.trim().toLowerCase() : '';
    return /^0x[0-9a-f]{40}$/.test(value) ? value : null;
  }

  meta(key) {
    return this.rows('SELECT v FROM meta WHERE k = ?', key)[0]?.v ?? null;
  }

  setMeta(key, value) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, String(value));
  }

  // --- uploads -------------------------------------------------------------------------------------
  upload(bytes, ip = '') {
    bytes = toBytes(bytes);
    if (bytes.length > MAX_POST_BYTES) return { status: 413, error: `A post is at most ${MAX_POST_BYTES} bytes.` };
    const post = parsePost(bytes);
    if (!post) return { status: 400, error: 'Not a v1 post: a JSON object with "v": 1, a "title" and a "body".' };
    const hash = postHash(bytes);
    if (this.rows('SELECT 1 FROM content WHERE hash = ?', hash).length) return { hash };
    if (this.rows('SELECT 1 FROM auth WHERE hash = ? LIMIT 1', hash).length) {
      this.storeContent(hash, bytes, post);
      return { hash };
    }

    const now = this.now();
    const client = clientKey(ip);
    const recent = (this.uploadsByIp.get(client) || []).filter((t) => now - t < 3600);
    if (recent.length >= UPLOADS_PER_HOUR) return { status: 429, error: 'Too many uploads from this address. Try again in an hour.' };
    const unclaimed = this.rows(
      'SELECT COALESCE(SUM(LENGTH(c.bytes)), 0) AS n FROM content c WHERE NOT EXISTS (SELECT 1 FROM auth a WHERE a.hash = c.hash)',
    )[0].n;
    if (unclaimed + bytes.length > MAX_UNCLAIMED_BYTES) return { status: 503, error: 'The upload queue is full. Authorize the post first, then upload it.' };
    recent.push(now);
    this.uploadsByIp.set(client, recent);
    this.storeContent(hash, bytes, post);
    return { hash };
  }

  storeContent(hash, bytes, post) {
    this.sql.exec(
      'INSERT OR IGNORE INTO content (hash, bytes, title, time, received) VALUES (?, ?, ?, ?, ?)',
      hash, toBuffer(bytes), post.title, post.time, this.now(),
    );
  }

  // --- reads ---------------------------------------------------------------------------------------
  raw(hash) {
    const row = this.rows('SELECT bytes FROM content WHERE hash = ?', hash)[0];
    return row ? toBytes(row.bytes) : null;
  }

  blobBytes(vh) {
    const row = this.rows('SELECT bytes FROM blob WHERE vh = ? AND bytes IS NOT NULL', vh)[0];
    return row ? toBytes(row.bytes) : null;
  }

  // The first blob that really carries the post, if any.
  onchain(hash) {
    const row = this.rows(
      'SELECT p.blob, p.tx, p.block, p.ts, p.publisher FROM pub p JOIN carried k ON k.vh = p.blob AND k.hash = p.hash ' +
      'WHERE p.hash = ? ORDER BY p.block, p.idx LIMIT 1', hash,
    )[0];
    return row ? { blob: row.blob, tx: row.tx, block: row.block, time: row.ts, publisher: row.publisher } : null;
  }

  detail(hash) {
    const row = this.rows('SELECT bytes, title, time FROM content WHERE hash = ?', hash)[0];
    if (!row) return null;
    const post = parsePost(toBytes(row.bytes));
    const authorizations = this.rows(
      'SELECT a.token, a.author, a.publisher, a.fee, a.tx, a.block, a.ts, n.name FROM auth a LEFT JOIN names n ON n.token = a.token ' +
      'WHERE a.hash = ? ORDER BY a.block, a.idx', hash,
    ).map((a) => ({ token: a.token, name: a.name || null, author: a.author, publisher: a.publisher, fee: a.fee, tx: a.tx, block: a.block, time: a.ts }));
    return { hash, title: post.title, body: post.body, time: post.time, authorizations, onchain: this.onchain(hash) };
  }

  // Posts shown for a name: authorized by its current owner, not withdrawn since, with known bytes,
  // and either carried by a blob or still inside the pending window.
  forToken(token, owner, limit = 50) {
    token = token.toLowerCase();
    owner = (owner || '').toLowerCase();
    const rows = this.rows(
      'WITH latest AS (SELECT hash, MAX(block * ? + idx) AS pos, MIN(ts) AS first_ts, MAX(ts) AS last_ts ' +
      'FROM auth WHERE token = ? AND author = ? GROUP BY hash) ' +
      'SELECT l.hash, l.first_ts, l.last_ts, c.title, c.time FROM latest l JOIN content c ON c.hash = l.hash ' +
      'WHERE NOT EXISTS (SELECT 1 FROM removal r WHERE r.token = ? AND r.hash = l.hash AND r.author = ? AND r.block * ? + r.idx > l.pos) ' +
      'ORDER BY COALESCE(c.time, l.first_ts) DESC LIMIT ?',
      POS, token, owner, token, owner, POS, Math.max(limit * 2, limit + 20),
    );
    const now = this.now();
    const posts = [];
    for (const row of rows) {
      const onchain = this.onchain(row.hash);
      if (!onchain && now - row.last_ts > PENDING_SECONDS) continue;
      posts.push({ hash: row.hash, title: row.title, time: row.time ?? row.first_ts, authorized: row.first_ts, onchain });
      if (posts.length >= limit) break;
    }
    return posts;
  }

  postForToken(token, owner, prefix) {
    const match = this.forToken(token, owner, 1000).find((p) => p.hash.slice(2, 2 + prefix.length) === prefix);
    if (!match) return null;
    const post = parsePost(this.raw(match.hash));
    return { ...match, body: post.body };
  }

  // Newest posts across all names, for gwei.domains. Owners are re-checked so a sold or expired
  // name's old posts drop out.
  async recent(limit = 20) {
    const candidates = this.rows(
      'SELECT a.token, a.author, a.hash, MAX(a.block * ? + a.idx) AS pos, n.name FROM auth a ' +
      'JOIN content c ON c.hash = a.hash JOIN names n ON n.token = a.token GROUP BY a.token, a.author, a.hash ORDER BY pos DESC LIMIT ?',
      POS, limit * 4,
    );
    const owners = await this.currentOwners([...new Set(candidates.map((c) => c.token))]);
    const out = [];
    for (const c of candidates) {
      if (owners.get(c.token) !== c.author) continue;
      const shown = this.forToken(c.token, c.author, 1000).find((p) => p.hash === c.hash);
      if (shown) out.push({ name: c.name, token: c.token, ...shown });
      if (out.length >= limit) break;
    }
    return out;
  }

  // token → owner for active names (inactive ones map to null), cached for a minute.
  async currentOwners(tokens) {
    const now = this.now();
    const result = new Map();
    const missing = [];
    for (const token of tokens) {
      const hit = this.owners.get(token);
      if (hit && now - hit.at < OWNER_CACHE_SECONDS) result.set(token, hit.owner);
      else missing.push(token);
    }
    for (let i = 0; i < missing.length; i += 30) {
      const chunk = missing.slice(i, i + 30);
      const calls = chunk.flatMap((token) => [SEL_RESOLVE, SEL_OWNEROF].map((sel) => ({ target: NAMENFT, data: '0x' + sel + token.slice(2) })));
      const decoded = decodeAggregate3(await this.rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest']));
      if (!decoded) continue;
      chunk.forEach((token, j) => {
        const [active, owner] = [decoded[j * 2], decoded[j * 2 + 1]];
        const live = active?.success && /[1-9a-f]/.test(active.data.slice(0, 64));
        const value = live && owner?.success && owner.data.length >= 64 ? '0x' + owner.data.slice(24, 64).toLowerCase() : null;
        this.owners.set(token, { owner: value, at: now });
        result.set(token, value);
      });
    }
    return result;
  }

  // --- indexing ------------------------------------------------------------------------------------
  sync() {
    if (!this.syncing) {
      this.lastSync = this.now();
      this.syncing = this.#sync().finally(() => { this.syncing = null; });
    }
    return this.syncing;
  }

  // A sync on request (the dapp asks after a post's transaction lands), at most every 10 seconds.
  poke() {
    if (this.syncing) return this.syncing;
    if (this.now() - (this.lastSync || 0) < 10) return { throttled: true };
    return this.sync();
  }

  async #sync() {
    const contract = this.contract;
    if (!contract) return { skipped: 'POSTS_CONTRACT is not set' };
    const head = Number(BigInt(await this.rpc('eth_blockNumber', [])));
    const safe = head - CONFIRMATIONS;
    // Without a recorded cursor, start at the contract's deployment block (or at the head, if unset).
    const start = Number(this.env.POSTS_FROM_BLOCK) > 0 ? Number(this.env.POSTS_FROM_BLOCK) - 1 : safe;
    let cursor = Number(this.meta('cursor') ?? start);
    let events = 0;
    for (let n = 0; n < LOG_RANGES_PER_SYNC && cursor < safe; n++) {
      const from = cursor + 1;
      const to = Math.min(safe, from + LOG_RANGE - 1);
      const logs = await this.rpc('eth_getLogs', [{
        address: contract,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics: [[T_AUTHORIZED, T_PUBLISHED, T_REMOVED]],
      }]);
      events += await this.ingest(Array.isArray(logs) ? logs : []);
      cursor = to;
      this.setMeta('cursor', cursor);
    }
    await this.fillNames();
    const blobs = await this.fetchBlobs();
    this.prune();
    return { head, cursor, events, blobs };
  }

  async ingest(logs) {
    const live = logs.filter((log) => !log.removed && log.address?.toLowerCase() === this.contract);
    // Logs don't always carry the block time; fetch it once per block when they don't.
    const times = new Map();
    for (const log of live) {
      const block = Number(BigInt(log.blockNumber));
      if (log.blockTimestamp) times.set(block, Number(BigInt(log.blockTimestamp)));
    }
    for (const block of new Set(live.map((log) => Number(BigInt(log.blockNumber))))) {
      if (times.has(block)) continue;
      const header = await this.rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
      times.set(block, Number(BigInt(header.timestamp)));
    }
    let count = 0;
    for (const log of live) {
      const block = Number(BigInt(log.blockNumber));
      const idx = Number(BigInt(log.logIndex));
      const ts = times.get(block);
      const [topic, a, b, c] = log.topics.map((t) => t.toLowerCase());
      if (topic === T_AUTHORIZED && log.topics.length === 4) {
        this.sql.exec(
          'INSERT OR IGNORE INTO auth (block, idx, tx, ts, token, hash, author, publisher, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          block, idx, log.transactionHash, ts, a, b, topicAddress(c), topicAddress(word(log.data, 0)), BigInt(word(log.data, 1)).toString(),
        );
      } else if (topic === T_PUBLISHED && log.topics.length === 4) {
        this.sql.exec(
          'INSERT OR IGNORE INTO pub (block, idx, tx, ts, hash, blob, publisher) VALUES (?, ?, ?, ?, ?, ?, ?)',
          block, idx, log.transactionHash, ts, a, b, topicAddress(c),
        );
        this.sql.exec('INSERT OR IGNORE INTO blob (vh, block, ts) VALUES (?, ?, ?)', b, block, ts);
      } else if (topic === T_REMOVED && log.topics.length === 4) {
        this.sql.exec(
          'INSERT OR IGNORE INTO removal (block, idx, tx, token, hash, author) VALUES (?, ?, ?, ?, ?, ?)',
          block, idx, log.transactionHash, a, b, topicAddress(c),
        );
      } else {
        continue;
      }
      count++;
    }
    return count;
  }

  // Full names for tokens that posted, via NameNFT.getFullName (a token's name never changes).
  async fillNames() {
    const tokens = this.rows('SELECT DISTINCT a.token FROM auth a LEFT JOIN names n ON n.token = a.token WHERE n.token IS NULL LIMIT 30').map((r) => r.token);
    if (!tokens.length) return;
    const calls = tokens.map((token) => ({ target: NAMENFT, data: '0x' + SEL_GETFULLNAME + token.slice(2) }));
    const decoded = decodeAggregate3(await this.rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest']));
    if (!decoded) return;
    tokens.forEach((token, i) => {
      const r = decoded[i];
      if (!r?.success || r.data.length < 128) return;
      const length = Number(BigInt('0x' + r.data.slice(64, 128)));
      const name = new TextDecoder().decode(hexToBytes(r.data.slice(128, 128 + length * 2)));
      if (name) this.sql.exec('INSERT OR IGNORE INTO names (token, name) VALUES (?, ?)', token, name);
    });
  }

  // Fetch the blobs authorized posts point at, record which posts each really carries, and keep
  // the bytes of any authorized post found there.
  async fetchBlobs() {
    const now = this.now();
    const due = this.rows(
      'SELECT b.vh, b.ts, b.tries FROM blob b WHERE b.bytes IS NULL AND b.tries < ? AND b.next_try <= ? ' +
      'AND EXISTS (SELECT 1 FROM pub p JOIN auth a ON a.hash = p.hash WHERE p.blob = b.vh) ORDER BY b.block LIMIT ?',
      BLOB_MAX_TRIES, now, BLOBS_PER_SYNC,
    );
    let fetched = 0;
    for (const { vh, ts, tries } of due) {
      const blob = await this.fetchBlob(vh, ts);
      if (!blob) {
        const wait = Math.min(60 * 2 ** tries, 6 * 3600);
        this.sql.exec('UPDATE blob SET tries = tries + 1, next_try = ? WHERE vh = ?', now + wait, vh);
        continue;
      }
      for (const entry of decodeBlob(blob)) {
        const hash = postHash(entry);
        this.sql.exec('INSERT OR IGNORE INTO carried (vh, hash) VALUES (?, ?)', vh, hash);
        const post = parsePost(entry);
        if (post) this.storeContent(hash, entry, post);
      }
      this.sql.exec('UPDATE blob SET bytes = ?, tries = tries + 1 WHERE vh = ?', toBuffer(blob), vh);
      fetched++;
    }
    return fetched;
  }

  async fetchBlob(vh, ts) {
    const sources = this.blobSources();
    const attempts = [];
    if (sources.blobscan) attempts.push(async () => this.getJson(`${sources.blobscan}/blobs/${vh}/data`));
    const slot = Math.floor((ts - BEACON_GENESIS) / 12);
    for (const beacon of sources.beacons) {
      attempts.push(async () => (await this.getJson(`${beacon}/eth/v1/beacon/blobs/${slot}?versioned_hashes=${vh}`))?.data?.[0]);
    }
    for (const attempt of attempts) {
      try {
        const hex = await attempt();
        if (typeof hex === 'string' && /^0x[0-9a-fA-F]+$/.test(hex) && hex.length === 2 + BLOB_BYTES * 2) return hexToBytes(hex.slice(2));
      } catch (_) {}
    }
    return null;
  }

  blobSources() {
    try {
      const configured = JSON.parse(this.env.BLOB_SOURCES || 'null');
      if (configured && typeof configured === 'object') return { blobscan: configured.blobscan || null, beacons: configured.beacons || [] };
    } catch (_) {}
    return DEFAULT_BLOB_SOURCES;
  }

  async getJson(url) {
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'gwei.domains posts indexer' },
      signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return readRpcJson(response);
  }

  // Uploads nobody authorized within UPLOAD_TTL_SECONDS are dropped.
  prune() {
    this.sql.exec(
      'DELETE FROM content WHERE received < ? AND NOT EXISTS (SELECT 1 FROM auth a WHERE a.hash = content.hash)',
      this.now() - UPLOAD_TTL_SECONDS,
    );
  }

  // JSON-RPC over the gateway's mainnet endpoints: the preferred one (with its token) first.
  async rpc(method, params) {
    const { endpoints, preferred, preferredAuth } = rpcEndpointConfig(1, this.env);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const failures = [];
    for (const url of endpoints) {
      try {
        const headers = { 'content-type': 'application/json' };
        if (preferredAuth && url === preferred) headers.authorization = preferredAuth;
        const response = await this.fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          failures.push(`${new URL(url).host}: HTTP ${response.status}`);
          continue;
        }
        const json = await readRpcJson(response);
        if (json && 'result' in json && json.result !== null) return json.result;
        failures.push(`${new URL(url).host}: ${String(json?.error?.message || 'no result').slice(0, 100)}`);
      } catch (error) {
        failures.push(`${new URL(url).host}: ${String(error?.message || error).slice(0, 100)}`);
      }
    }
    throw new Error(`${method} failed: ${failures.join('; ')}`);
  }
}

export const isPostHash = (value) => HASH.test(value || '');

// Rate limits apply per IPv4 address and per IPv6 /64, since one IPv6 host holds a whole /64.
export function clientKey(ip) {
  const value = String(ip || '').toLowerCase();
  if (!value.includes(':')) return value;
  const [head, tail = ''] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = value.includes('::') ? [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
