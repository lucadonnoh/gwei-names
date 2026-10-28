// The gateway's index of GNS posts (posts/SPEC.md), rebuilt from public data only: the GnsPosts
// contract's events and the blobs they name. Every publisher's blobs count the same, ours included.
// Post bytes arrive either in a blob or through the upload API (anyone may upload; bytes are kept
// because their keccak-256 hash is what the name's owner authorized, so the source doesn't matter).
//
// Everything an outsider can add is bounded by what it costs them on-chain or by a cap: only blobs
// that claim an authorized post are fetched, only the claimed entries in them are stored, and bytes
// that never make it into a blob expire. Posts carried by a blob and the blobs that carry them are
// kept for good (blobs without their zero padding), and listed for mirrors in the order they were
// found (archive()). Lost ones come back from IPFS, where anyone can pin a post under its hash.
//
// The logic lives here, over a SQLite handle shaped like Durable Object storage (`sql.exec`), so it
// runs under Node in tests; posts-index.js wraps it in the Durable Object.

import { MAX_POST_BYTES, BLOB_BYTES, blobCid, decodeBlob, encodeBlob, parsePost, postCid, postHash } from './posts-format.js';
import { MULTICALL3, decodeAggregate3, encodeAggregate3 } from './profile-page.js';
import { configuredGateways } from './content-gateways.js';
import { replyRoom, replyText } from './replies-format.js';
import { readRpcJson } from './rpc-pool.js';
import { rpcEndpointConfig } from './rpc-config.js';
import { hexToBytes } from './web3-auto.js';
import { ens_normalize } from './ens-normalize.js';

export const T_AUTHORIZED = '0x521590a9cca024d1ff93e37c9ee8f521cee9c2da79903939763c3c34bdb7eb28'; // PostAuthorized(uint256,bytes32,address,bytes32,address,uint256)
export const T_BLOB_PUBLISHED = '0xb51cc50f0049ae8836824f5ee55fbae269ff6cf4ff8fc6390b721310d5ade99b'; // BlobPublished(bytes32,address,uint256)
export const T_REMOVED = '0xb436f9efc5db52a352858f3e68c0e4cf41e7c50b0ef72366bd2f05e7263df3ee'; // PostRemoved(uint256,bytes32,address)
const NAMENFT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
const SEL_GETFULLNAME = '465411c1'; // getFullName(uint256)
const SEL_OWNEROF = '6352211e'; // ownerOf(uint256)
const SEL_RESOLVE = '4f896d4f'; // resolve(uint256): zero unless active
const SEL_REVERSE = '9af8b7aa'; // reverseResolve(address): the address's primary name, if active and it resolves back
const WNS = '0x0000000000696760E15f265e828DB644A0c242EB'; // Wei Name Service, the contract GNS was forked from
const ENS_UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const SEL_ENS_REVERSE = '5d78a217'; // reverse(bytes,uint256): the primary ENS name; reverts unless it resolves back

const CONFIRMATIONS = 2; // index up to head - 2, so a one-block reorg can't leave a phantom event
const LOG_RANGE = 2000; // blocks per eth_getLogs (public RPCs cap ranges)
const LOG_RANGES_PER_SYNC = 5;
const BLOBS_PER_SYNC = 6;
const BLOB_MAX_TRIES = 60; // with the 6-hour backoff cap, about two weeks
const PENDING_SECONDS = 86400; // an authorized post shows for a day while it waits for its blob
const UPLOAD_TTL_SECONDS = 86400; // uploaded bytes no owner authorized are dropped after this
const AUTHORIZED_TTL_SECONDS = 3 * 86400; // authorized bytes that never reach a blob, after this
// Uploads not yet in a blob are capped by size. Bytes an owner already authorized skip the per-IP
// limit and the unclaimed cap, so junk uploads can delay posting but not block it.
const MAX_UNCLAIMED_BYTES = 256 * 1024 * 1024;
const MAX_UNPUBLISHED_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOADS_PER_HOUR = 20; // per client IP (IPv6: per /64)
const OWNER_CACHE_SECONDS = 60;
const RECENT_CACHE_SECONDS = 30;
const RECENT_PER_NAME = 2;
const NAME_RETRY_SECONDS = 86400;
const MAX_LIST = 200;
// Replies (replies-format.js) are found with trace_filter on the owner's node until EIP-7708 gives every
// ETH transfer a log: a range of blocks, for every room at once, in batches of rooms.
const REPLY_RANGE = 200;
const REPLY_RANGES_PER_SYNC = 10;
const ROOMS_PER_QUERY = 200;
const ROOM_CATCHUPS_PER_SYNC = 5;
const MAX_REPLIES = 500; // per post: the newest
const REPLY_CALLS_PER_SYNC = 40; // RPC calls the reply scan may make per sync, splits and retries included
const CATCHUP_RANGE = 2000; // blocks per trace_filter for one room catching up
const REPLY_BLOCK_TRIES = 3; // syncs a block that can't be read at all is tried in before it is skipped
const REPLY_TIMES_PER_SYNC = 20; // blocks whose time is looked up per sync, for replies found without one
// A block read in full to find its replies: up to about 9 MB of JSON for a block of zero-byte calldata.
const FULL_BLOCK_MAX_BYTES = 16 * 1024 * 1024;
const PRIMARY_CACHE_SECONDS = 600;
const BEACON_GENESIS = 1606824023; // mainnet beacon genesis time; slots are 12 s
const RPC_TIMEOUT_MS = 10_000;
const BLOB_TIMEOUT_MS = 15_000;
const IPFS_TIMEOUT_MS = 8_000; // as the website gateway allows
const REBUILD_CLAIMS = 3; // posts tried per blob when rebuilding one (each try is a KZG commitment)
const CIDS_PER_SYNC = 20;
export const DEFAULT_BLOB_SOURCES = {
  blobscan: 'https://api.blobscan.com',
  beacons: ['https://ethereum-beacon-api.publicnode.com'],
};
// IPFS gateways for posts the index lost: the ones the Worker serves websites from (IPFS_GATEWAYS),
// else Filebase, which answers Worker traffic (ipfs.io and dweb.link rate-limit it). A post is a raw
// block, so any gateway's answer is the bytes themselves, checked against the post hash here.
export const DEFAULT_IPFS_GATEWAYS = ['https://ipfs.filebase.io'];

// Bumped whenever the tables change shape; a different version (or a different contract) starts the
// index over from the contract's deployment block.
const SCHEMA_VERSION = '3';
const TABLES = ['content', 'auth', 'pub', 'blobpub', 'removal', 'blob', 'carried', 'checked', 'names', 'blobcid', 'room', 'reply'];
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL, title TEXT NOT NULL, time INTEGER, received INTEGER NOT NULL)',
  // PostAuthorized: `blob` is the blob the author built for the post (its versioned hash).
  'CREATE TABLE IF NOT EXISTS auth (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, ts INTEGER NOT NULL, token TEXT NOT NULL, hash TEXT NOT NULL, author TEXT NOT NULL, blob TEXT NOT NULL, publisher TEXT NOT NULL, fee TEXT NOT NULL, PRIMARY KEY (block, idx))',
  'CREATE INDEX IF NOT EXISTS auth_blob ON auth (blob)',
  'CREATE INDEX IF NOT EXISTS auth_token ON auth (token, author)',
  'CREATE INDEX IF NOT EXISTS auth_hash ON auth (hash)',
  'CREATE INDEX IF NOT EXISTS auth_author ON auth (author)',
  // BlobPublished, and from it a claim per post an author named that blob for: `pub` says "this blob,
  // published here, should carry this post", which fetching the blob then checks.
  'CREATE TABLE IF NOT EXISTS blobpub (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, ts INTEGER NOT NULL, vh TEXT NOT NULL, publisher TEXT NOT NULL, PRIMARY KEY (block, idx))',
  'CREATE INDEX IF NOT EXISTS blobpub_vh ON blobpub (vh)',
  'CREATE TABLE IF NOT EXISTS pub (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT NOT NULL, blob TEXT NOT NULL, publisher TEXT NOT NULL, PRIMARY KEY (block, idx, hash))',
  'CREATE INDEX IF NOT EXISTS pub_hash ON pub (hash)',
  'CREATE INDEX IF NOT EXISTS pub_blob ON pub (blob)',
  'CREATE TABLE IF NOT EXISTS removal (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, token TEXT NOT NULL, hash TEXT NOT NULL, author TEXT NOT NULL, PRIMARY KEY (block, idx))',
  'CREATE INDEX IF NOT EXISTS removal_key ON removal (token, hash, author)',
  // A blob named by PostPublished. status: 'due' (not fetched yet), 'kept' (some claim held; bytes
  // kept, without the trailing zeros) or 'rejected' (no claim held; nothing kept).
  "CREATE TABLE IF NOT EXISTS blob (vh TEXT PRIMARY KEY, block INTEGER NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'due', bytes BLOB, fetched INTEGER, tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0)",
  // Claimed posts a fetched blob really contains. Rows are never deleted, so the rowid orders posts by
  // when the index found them (archive()).
  'CREATE TABLE IF NOT EXISTS carried (vh TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (vh, hash))',
  'CREATE INDEX IF NOT EXISTS carried_hash ON carried (hash)',
  // Claims a fetched blob was checked against, held or not. A claim not in here sends the blob back
  // to 'due', so an early junk claim can't keep a later real one from ever being checked.
  'CREATE TABLE IF NOT EXISTS checked (vh TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (vh, hash))',
  // A token's full name; '' while unknown (retried after NAME_RETRY_SECONDS).
  'CREATE TABLE IF NOT EXISTS names (token TEXT PRIMARY KEY, name TEXT NOT NULL, checked INTEGER NOT NULL)',
  // A kept blob's IPFS CID (sha-256 of its bytes, as the publisher pins it).
  'CREATE TABLE IF NOT EXISTS blobcid (vh TEXT PRIMARY KEY, cid TEXT NOT NULL)',
  // A post's reply room (replies-format.js), watched from its first authorization: `scanned` is the
  // block its own catch-up reached; once it meets the replies cursor the room joins the shared scan.
  'CREATE TABLE IF NOT EXISTS room (room TEXT PRIMARY KEY, hash TEXT NOT NULL, since INTEGER NOT NULL, scanned INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS room_hash ON room (hash)',
  // A reply: a top-level 1-wei transaction to a room with 0x01 + UTF-8 text as input.
  'CREATE TABLE IF NOT EXISTS reply (tx TEXT PRIMARY KEY, block INTEGER NOT NULL, pos INTEGER NOT NULL, ts INTEGER, room TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS reply_room ON reply (room, block, pos)',
];

const HASH = /^0x[0-9a-f]{64}$/;
const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
const toBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
// A short post's blob is mostly zero padding, so blobs are stored without their trailing zeros.
function trimBlob(blob) {
  let n = blob.length;
  while (n && blob[n - 1] === 0) n--;
  return blob.subarray(0, n);
}
function padBlob(stored) {
  if (stored.length === BLOB_BYTES) return stored;
  const blob = new Uint8Array(BLOB_BYTES);
  blob.set(stored);
  return blob;
}
const word = (data, i) => '0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64);
const topicAddress = (t) => '0x' + t.slice(-40).toLowerCase();
// Events are ordered by block * 2^32 + log index, however many logs a block has. The constant is an
// SQL integer literal: bound as a JS number it can turn the product into a REAL, which rounds at mainnet
// block heights and makes a same-block removal look no later than the authorization.
const POS = '4294967296';
// The first blob that really carries a post, as one string column (a correlated subquery).
// A post's date: the block of the first blob that carries it, else its first authorization.
// A post whose bytes say "replies": false (posts-format.js parsePost), read without parsing every row in JS.
const REPLIES_OFF = "(CASE WHEN json_valid(CAST(c.bytes AS TEXT)) AND json_type(CAST(c.bytes AS TEXT), '$.replies') = 'false' THEN 1 ELSE 0 END)";
const ONCHAIN_TS = '(SELECT p.ts FROM pub p JOIN carried k ON k.vh = p.blob AND k.hash = p.hash WHERE p.hash = l.hash ORDER BY p.block, p.idx LIMIT 1)';
const ONCHAIN = "(SELECT p.blob || '|' || p.tx || '|' || p.block || '|' || p.ts || '|' || p.publisher FROM pub p " +
  'JOIN carried k ON k.vh = p.blob AND k.hash = p.hash WHERE p.hash = l.hash ORDER BY p.block, p.idx LIMIT 1)';
function parseOnchain(value) {
  if (!value) return null;
  const [blob, tx, block, time, publisher] = value.split('|');
  return { blob, tx, block: Number(block), time: Number(time), publisher };
}

export class PostStore {
  constructor(sql, env = {}, { fetchImpl = (input, init) => fetch(input, init), now = () => Math.floor(Date.now() / 1000) } = {}) {
    this.sql = sql;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.uploadsByIp = new Map();
    this.owners = new Map();
    this.primaries = new Map();
    this.recentCache = null;
    this.syncing = null;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const version = `${SCHEMA_VERSION}:${this.contract || ''}`;
    if (this.meta('schema') !== version) {
      for (const table of TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
      sql.exec("DELETE FROM meta WHERE k = 'cursor'");
      this.setMeta('schema', version);
    }
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
    const unpublished = (authorizedOnly) => this.rows(
      'SELECT COALESCE(SUM(LENGTH(c.bytes)), 0) AS n FROM content c WHERE NOT EXISTS (SELECT 1 FROM carried k WHERE k.hash = c.hash) ' +
      `AND ${authorizedOnly ? '' : 'NOT '}EXISTS (SELECT 1 FROM auth a WHERE a.hash = c.hash)`,
    )[0].n;
    if (this.rows('SELECT 1 FROM auth WHERE hash = ? LIMIT 1', hash).length) {
      if (unpublished(true) + bytes.length > MAX_UNPUBLISHED_BYTES) {
        console.error(JSON.stringify({ event: 'posts_upload_cap', kind: 'authorized' }));
        return { status: 503, error: 'The post index is full right now. Try again later.' };
      }
      this.storeContent(hash, bytes, post);
      return { hash };
    }

    const now = this.now();
    const client = clientKey(ip);
    const recent = (this.uploadsByIp.get(client) || []).filter((t) => now - t < 3600);
    if (recent.length >= UPLOADS_PER_HOUR) return { status: 429, error: 'Too many uploads from this address. Try again in an hour.' };
    if (unpublished(false) + bytes.length > MAX_UNCLAIMED_BYTES) {
      console.error(JSON.stringify({ event: 'posts_upload_cap', kind: 'unclaimed' }));
      return { status: 503, error: 'The upload queue is full. Authorize the post first, then upload it.' };
    }
    recent.push(now);
    this.uploadsByIp.set(client, recent);
    this.storeContent(hash, bytes, post);
    return { hash };
  }

  storeContent(hash, bytes, post) {
    this.sql.exec(
      'INSERT OR IGNORE INTO content (hash, bytes, title, time, received) VALUES (?, ?, ?, ?, ?)',
      hash, toBuffer(bytes), post.title, null, this.now(),
    );
  }

  // --- reads ---------------------------------------------------------------------------------------
  raw(hash) {
    const row = this.rows('SELECT bytes FROM content WHERE hash = ?', hash)[0];
    return row ? toBytes(row.bytes) : null;
  }

  body(hash) {
    const bytes = this.raw(hash);
    return bytes ? parsePost(bytes)?.body ?? null : null;
  }

  blobBytes(vh) {
    const row = this.rows('SELECT bytes FROM blob WHERE vh = ? AND bytes IS NOT NULL', vh)[0];
    return row ? padBlob(toBytes(row.bytes)) : null;
  }

  blobCidOf(vh) {
    return this.rows('SELECT cid FROM blobcid WHERE vh = ?', vh)[0]?.cid ?? null;
  }

  withCid(onchain) {
    return onchain && { ...onchain, cid: this.blobCidOf(onchain.blob) };
  }

  onchain(hash) {
    return parseOnchain(this.rows(`SELECT ${ONCHAIN} AS onchain FROM (SELECT ? AS hash) l`, hash)[0]?.onchain);
  }

  detail(hash) {
    const row = this.rows('SELECT bytes FROM content WHERE hash = ?', hash)[0];
    if (!row) return null;
    const post = parsePost(toBytes(row.bytes));
    // Anyone can authorize anyone's hash for their own name, so the list is capped.
    const authorizations = this.rows(
      'SELECT a.token, a.author, a.blob, a.publisher, a.fee, a.tx, a.block, a.ts, n.name FROM auth a LEFT JOIN names n ON n.token = a.token ' +
      'WHERE a.hash = ? ORDER BY a.block, a.idx LIMIT 50', hash,
    ).map((a) => ({ token: a.token, name: a.name || null, author: a.author, blob: a.blob, publisher: a.publisher, fee: a.fee, tx: a.tx, block: a.block, time: a.ts }));
    const onchain = this.withCid(this.onchain(hash));
    return { hash, cid: postCid(hash), title: post.title, body: post.body, ...(post.replies === false && { replies: false }), time: onchain?.time ?? authorizations[0]?.time ?? null, authorizations, onchain };
  }

  // Every post a blob carries, in the order the index found them, for mirrors and other frontends.
  // A post found later always comes after every `seq` handed out before (a late claim can make an
  // old blob carry a post), so reading on from the last `seq` sees each post once. Nothing is
  // filtered: whether a removed post or a sold name's post shows is the reader's call (posts/SPEC.md).
  archive(after = 0, limit = 100) {
    const rows = this.rows(
      `SELECT l.rowid AS seq, l.hash, c.title, ${ONCHAIN} AS onchain FROM carried l JOIN content c ON c.hash = l.hash ` +
      'WHERE l.rowid > ? AND NOT EXISTS (SELECT 1 FROM carried e WHERE e.hash = l.hash AND e.rowid < l.rowid) ORDER BY l.rowid LIMIT ?',
      Math.max(Number(after) || 0, 0), Math.min(Math.max(limit, 1), MAX_LIST),
    );
    const posts = rows.map((row) => {
      const onchain = this.withCid(parseOnchain(row.onchain));
      const authorizations = this.rows(
        'SELECT a.token, a.author, n.name, MIN(a.block) AS block FROM auth a LEFT JOIN names n ON n.token = a.token ' +
        'WHERE a.hash = ? GROUP BY a.token, a.author ORDER BY block LIMIT 10', row.hash,
      ).map((a) => ({ token: a.token, name: a.name || null, author: a.author }));
      return { seq: row.seq, hash: row.hash, cid: postCid(row.hash), title: row.title, time: onchain?.time ?? null, authorizations, onchain };
    });
    return { posts, next: posts.length ? posts[posts.length - 1].seq : Math.max(Number(after) || 0, 0) };
  }

  // Fees one address put in escrow, latest per (blob, publisher), for the dapp's refund list. Only a
  // hint for finding them: the contract's deposits() says whether a fee is still there.
  paidBy(author, limit = 100) {
    return this.rows(
      'SELECT a.hash, a.blob, a.publisher, a.token, MAX(a.block) AS block, c.title FROM auth a LEFT JOIN content c ON c.hash = a.hash ' +
      "WHERE a.author = ? AND a.fee != '0' GROUP BY a.blob, a.publisher ORDER BY block DESC LIMIT ?",
      String(author).toLowerCase(), Math.min(Math.max(limit, 1), MAX_LIST),
    ).map((r) => ({ hash: r.hash, blob: r.blob, publisher: r.publisher, token: r.token, block: r.block, title: r.title ?? null }));
  }

  // Posts shown for a name: authorized by its current owner, not withdrawn since, with known bytes,
  // and either carried by a blob or still inside the pending window. One query, newest first.
  forToken(token, owner, limit = 50, prefix = null) {
    token = token.toLowerCase();
    owner = (owner || '').toLowerCase();
    const rows = this.rows(
      `WITH latest AS (SELECT hash, MAX(block * ${POS} + idx) AS pos, MIN(ts) AS first_ts, MAX(ts) AS last_ts ` +
      'FROM auth WHERE token = ? AND author = ? GROUP BY hash) ' +
      `SELECT * FROM (SELECT l.hash, l.first_ts, l.last_ts, c.title, ${REPLIES_OFF} AS replies_off, ${ONCHAIN_TS} AS onchain_ts, ${ONCHAIN} AS onchain FROM latest l JOIN content c ON c.hash = l.hash ` +
      `WHERE NOT EXISTS (SELECT 1 FROM removal r WHERE r.token = ? AND r.hash = l.hash AND r.author = ? AND r.block * ${POS} + r.idx > l.pos) ` +
      (prefix ? 'AND substr(l.hash, 3, ?) = ? ' : '') +
      ') WHERE onchain IS NOT NULL OR last_ts > ? ORDER BY COALESCE(onchain_ts, first_ts) DESC LIMIT ?',
      token, owner, token, owner, ...(prefix ? [prefix.length, prefix] : []),
      this.now() - PENDING_SECONDS, Math.min(Math.max(limit, 1), MAX_LIST),
    );
    return rows.map((row) => ({
      hash: row.hash, title: row.title, time: row.onchain_ts ?? row.first_ts, authorized: row.first_ts, onchain: parseOnchain(row.onchain),
      ...(row.replies_off && { replies: false }),
    }));
  }

  postForToken(token, owner, prefix) {
    const [match] = this.forToken(token, owner, 1, prefix);
    if (!match) return null;
    const post = parsePost(this.raw(match.hash) || new Uint8Array());
    return { ...match, body: post?.body ?? null, ...(post?.replies === false ? { replies: false } : {}), replyCount: this.replyCount(match.hash) };
  }

  // A post's newest replies, oldest first, each with its sender's name as senderNames finds it (or null),
  // and `total`, the number there are.
  async replies(hash) {
    // The newest MAX_REPLIES, oldest first: replies sent early can't hold the thread.
    const rows = this.rows(
      'SELECT r.tx, r.block, r.ts, r.sender, r.text FROM reply r JOIN room m ON m.room = r.room WHERE m.hash = ? ORDER BY r.block DESC, r.pos DESC LIMIT ?',
      hash, MAX_REPLIES,
    ).reverse();
    const names = rows.length ? await this.senderNames([...new Set(rows.map((r) => r.sender))]).catch(() => new Map()) : new Map();
    const room = this.rows('SELECT room FROM room WHERE hash = ?', hash)[0]?.room ?? await replyRoom(hash);
    return {
      room,
      total: rows.length < MAX_REPLIES ? rows.length : this.replyCount(hash),
      replies: rows.map((r) => {
        const found = names.get(r.sender);
        return { tx: r.tx, block: r.block, time: r.ts, from: r.sender, name: found?.name ?? null, system: found?.system ?? null, text: r.text };
      }),
    };
  }

  replyCount(hash) {
    return this.rows('SELECT COUNT(*) AS n FROM reply r JOIN room m ON m.room = r.room WHERE m.hash = ?', hash)[0].n;
  }

  // address -> { name, system } or nothing: the name ethchat shows for a sender. Its primary GNS name, else
  // WNS, else ENS, each only if it resolves back to the address: GNS's and WNS's reverseResolve check
  // that themselves, ENS's Universal Resolver reverts otherwise. Every name must also be exactly its
  // ENSIP-15 normalization, so look-alikes don't show, and offchain (CCIP-Read) names aren't followed.
  // Cached for ten minutes.
  async senderNames(addresses) {
    const now = this.now();
    const result = new Map();
    const missing = [];
    for (const a of addresses) {
      const hit = this.primaries.get(a);
      if (hit && now - hit.at < PRIMARY_CACHE_SECONDS) { if (hit.found) result.set(a, hit.found); }
      else missing.push(a);
    }
    for (let i = 0; i < missing.length; i += 21) {
      const chunk = missing.slice(i, i + 21); // 3 calls each; decodeAggregate3 reads at most 64
      const calls = chunk.flatMap((a) => {
        const raw = a.slice(2).toLowerCase();
        return [
          { target: NAMENFT, data: '0x' + SEL_REVERSE + raw.padStart(64, '0') },
          { target: WNS, data: '0x' + SEL_REVERSE + raw.padStart(64, '0') },
          // (bytes lookupAddress, uint256 coinType = 60)
          { target: ENS_UNIVERSAL_RESOLVER, data: '0x' + SEL_ENS_REVERSE + abiWord(64) + abiWord(60) + abiWord(20) + raw.padEnd(64, '0') },
        ];
      });
      const decoded = decodeAggregate3(await this.rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest']));
      if (!decoded) continue;
      chunk.forEach((a, j) => {
        // GNS and WNS take any Unicode in a label, so their names are held to ENSIP-15 too: no look-alikes,
        // no bidi or zero-width tricks, no "/" or "#" to turn a link into another site's.
        const gns = normalizedName(readAbiString(decoded[3 * j]));
        const wns = normalizedName(readAbiString(decoded[3 * j + 1]));
        const ens = normalizedName(readAbiString(decoded[3 * j + 2]));
        const found = (/\.gwei$/.test(gns || '') && { name: gns, system: 'gns' }) || (/\.wei$/.test(wns || '') && { name: wns, system: 'wns' }) ||
          (ens && { name: ens, system: 'ens' }) || null;
        this.primaries.set(a, { found, at: now });
        if (found) result.set(a, found);
      });
    }
    return result;
  }

  // Newest posts across all names, for gwei.domains: one query, cached briefly. At most RECENT_PER_NAME
  // per name first, so one name can't crowd out the others; room left over goes to more posts from the
  // same names. Owners are re-checked so a sold or expired name's old posts drop out.
  async recent(limit = 20) {
    const now = this.now();
    if (this.recentCache && now - this.recentCache.at < RECENT_CACHE_SECONDS && this.recentCache.limit === limit) {
      return this.recentCache.posts;
    }
    const candidates = this.rows(
      `WITH latest AS (SELECT token, author, hash, MAX(block * ${POS} + idx) AS pos, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM auth GROUP BY token, author, hash) ` +
      `SELECT * FROM (SELECT l.token, l.author, l.hash, l.pos, l.first_ts, l.last_ts, n.name, c.title, ${ONCHAIN_TS} AS onchain_ts, ${ONCHAIN} AS onchain ` +
      "FROM latest l JOIN content c ON c.hash = l.hash JOIN names n ON n.token = l.token AND n.name != '' " +
      `WHERE NOT EXISTS (SELECT 1 FROM removal r WHERE r.token = l.token AND r.hash = l.hash AND r.author = l.author AND r.block * ${POS} + r.idx > l.pos)) ` +
      'WHERE onchain IS NOT NULL OR last_ts > ? ORDER BY pos DESC LIMIT ?',
      now - PENDING_SECONDS, limit * 6,
    );
    const owners = await this.currentOwners([...new Set(candidates.map((c) => c.token))]);
    const perName = new Map();
    const picked = [], spare = []; // [candidate index, post]: candidates come newest first
    for (const [i, c] of candidates.entries()) {
      if (owners.get(c.token) !== c.author) continue;
      const post = { name: c.name, token: c.token, hash: c.hash, title: c.title, time: c.onchain_ts ?? c.first_ts, authorized: c.first_ts, onchain: parseOnchain(c.onchain) };
      if ((perName.get(c.token) || 0) >= RECENT_PER_NAME) { spare.push([i, post]); continue; }
      perName.set(c.token, (perName.get(c.token) || 0) + 1);
      picked.push([i, post]);
      if (picked.length >= limit) break;
    }
    const posts = picked.concat(spare.slice(0, limit - picked.length)).sort((a, b) => a[0] - b[0]).map(([, post]) => post);
    this.recentCache = { at: now, limit, posts };
    return posts;
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
    const head = await this.head();
    const safe = head - CONFIRMATIONS;
    // Without a recorded cursor, start at the contract's deployment block (or at the head, if unset).
    const start = Number(this.env.POSTS_FROM_BLOCK) > 0 ? Number(this.env.POSTS_FROM_BLOCK) - 1 : safe;
    let cursor = Number(this.meta('cursor') ?? start);
    let events = 0;
    for (let n = 0; n < LOG_RANGES_PER_SYNC && cursor < safe; n++) {
      const from = cursor + 1;
      const to = Math.min(safe, from + LOG_RANGE - 1);
      const logs = await this.logs({
        address: contract,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics: [[T_AUTHORIZED, T_BLOB_PUBLISHED, T_REMOVED]],
      });
      events += await this.ingest(logs);
      cursor = to;
      this.setMeta('cursor', cursor);
    }
    await this.fillNames();
    const blobs = await this.fetchBlobs();
    await this.fillCids();
    this.prune();
    if (events || blobs) this.recentCache = null;
    let replies = 0;
    try {
      replies = await this.syncReplies(cursor);
    } catch (error) {
      console.error(JSON.stringify({ event: 'replies_sync_failed', message: String(error?.message || error).slice(0, 200) }));
    }
    return { head, cursor, events, blobs, replies };
  }

  // Rooms for the posts the index knows bytes for (from their first authorization, since a post shows
  // while it waits for its blob); then a catch-up for new rooms; then every room, up to `until` (the
  // events cursor, so a room exists before the blocks that could hold its replies are read).
  async syncReplies(until) {
    const { preferred } = rpcEndpointConfig(1, this.env);
    if (!preferred) return 0; // trace_filter: only the owner's node offers it (public RPCs don't)
    const start = Number(this.env.POSTS_FROM_BLOCK) > 0 ? Number(this.env.POSTS_FROM_BLOCK) - 1 : until;
    let cursor = Number(this.meta('reply_cursor') ?? start);
    const fresh = this.rows(
      'SELECT c.hash, MIN(a.block) AS since FROM content c JOIN auth a ON a.hash = c.hash ' +
      'WHERE NOT EXISTS (SELECT 1 FROM room m WHERE m.hash = c.hash) GROUP BY c.hash LIMIT 100',
    );
    for (const { hash, since } of fresh) {
      this.sql.exec('INSERT OR IGNORE INTO room (room, hash, since, scanned) VALUES (?, ?, ?, ?)', await replyRoom(hash), hash, since, since - 1);
    }
    const budget = { calls: REPLY_CALLS_PER_SYNC };
    let found = 0;
    // New blocks first, for every room in step: whatever else is going on, new replies show.
    for (let n = 0; n < REPLY_RANGES_PER_SYNC && cursor < until && budget.calls > 0; n++) {
      const to = Math.min(until, cursor + REPLY_RANGE);
      const rooms = this.rows('SELECT room FROM room WHERE scanned >= ?', cursor).map((r) => r.room);
      let through = to;
      for (let i = 0; i < rooms.length && through > cursor; i += ROOMS_PER_QUERY) {
        const done = await this.scanRange(rooms.slice(i, i + ROOMS_PER_QUERY), cursor + 1, through, budget);
        found += done.found;
        through = done.through; // blocks a later batch would scan again are only seen again: replies are keyed by tx
      }
      if (through <= cursor) break;
      this.sql.exec('UPDATE room SET scanned = ? WHERE scanned >= ?', through, cursor);
      cursor = through;
      this.setMeta('reply_cursor', cursor);
      if (through < to) break;
    }
    // Then rooms behind the shared cursor (bytes that arrived late), nearest first, with what is left.
    const behind = this.rows('SELECT room, scanned FROM room WHERE scanned < ? ORDER BY scanned DESC LIMIT ?', cursor, ROOM_CATCHUPS_PER_SYNC);
    for (const { room, scanned } of behind) {
      if (budget.calls <= 0) break;
      let at = scanned;
      while (at < cursor && budget.calls > 0) {
        const to = Math.min(cursor, at + CATCHUP_RANGE);
        const done = await this.scanRange([room], at + 1, to, budget);
        found += done.found;
        at = done.through;
        if (at < to) break;
      }
      this.sql.exec('UPDATE room SET scanned = ? WHERE room = ?', at, room);
    }
    await this.fillReplyTimes().catch(() => {});
    return found;
  }

  // Replies to `rooms` in blocks from..to, stored. Returns { found, through }: through is the last block
  // it got to with every block before it done (from - 1 for none), so progress is kept block by block.
  // trace_filter answers a whole range, but internal calls carry their input too, so a contract calling a
  // room many times with big inputs can make that answer too big or too slow. When the node itself is
  // fine (it answers eth_blockNumber), such a range is split in two, and a block that still fails is read
  // from its transactions, which is all a reply can be. A block that can't even be read that way is
  // skipped after REPLY_BLOCK_TRIES syncs, logged. Every call is paid from `budget`, so a sync always
  // ends, and the next one picks up where it stopped.
  async scanRange(rooms, from, to, budget) {
    const set = new Set(rooms);
    let calls;
    try {
      calls = await this.traceCalls(rooms, from, to, budget);
    } catch (error) {
      if (budget.calls <= 0 || !(await this.nodeAnswers(budget))) {
        console.error(JSON.stringify({ event: 'reply_scan_paused', from, to, message: String(error?.message || error).slice(0, 200) }));
        return { found: 0, through: from - 1 };
      }
      if (from < to) {
        const mid = Math.floor((from + to) / 2);
        const left = await this.scanRange(rooms, from, mid, budget);
        if (left.through < mid) return left;
        const right = await this.scanRange(rooms, mid + 1, to, budget);
        return { found: left.found + right.found, through: right.through };
      }
      if (budget.calls <= 0) return { found: 0, through: from - 1 }; // out of calls: not the block's fault
      try {
        calls = await this.blockCalls(set, from, budget);
        this.setMeta('reply_block_failures', '');
      } catch (blockError) {
        const [block, tries] = String(this.meta('reply_block_failures') || '').split(':').map(Number);
        const now = block === from ? tries + 1 : 1;
        const skip = now >= REPLY_BLOCK_TRIES && budget.calls > 0;
        console.error(JSON.stringify({ event: skip ? 'reply_block_skipped' : 'reply_block_failed', block: from, tries: now, message: String(blockError?.message || blockError).slice(0, 200) }));
        this.setMeta('reply_block_failures', skip ? '' : `${from}:${now}`);
        return { found: 0, through: skip ? from : from - 1 };
      }
    }
    let found = 0;
    for (const c of calls) {
      const room = String(c.to || '').toLowerCase();
      if (!set.has(room)) continue;
      const text = replyText(c, room);
      if (text === null) continue;
      this.sql.exec('INSERT OR IGNORE INTO reply (tx, block, pos, ts, room, sender, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        c.tx, c.block, c.pos, c.ts ?? null, room, String(c.from).toLowerCase(), text);
      found++;
    }
    return { found, through: to };
  }

  // Whether the owner's node answers at all, asked once per sync: a failure it gives for every request
  // is the node being down, not a range too big to answer.
  async nodeAnswers(budget) {
    if (budget.nodeAnswers === undefined) {
      if (budget.calls-- <= 0) return false;
      const { preferred } = rpcEndpointConfig(1, this.env);
      budget.nodeAnswers = await this.rpcAt([preferred], 'eth_blockNumber', []).then(() => true, () => false);
    }
    return budget.nodeAnswers;
  }

  // Successful top-level calls to `rooms` in from..to, from trace_filter.
  async traceCalls(rooms, from, to, budget) {
    if (budget.calls-- <= 0) throw new Error('reply scan: out of calls for this sync');
    const { preferred } = rpcEndpointConfig(1, this.env);
    const traces = await this.rpcAt([preferred], 'trace_filter', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), toAddress: rooms }]);
    if (!Array.isArray(traces)) throw new Error('trace_filter: not a list');
    return traces
      .filter((t) => t?.type === 'call' && !t.error && !(t.traceAddress || []).length && (!t.action?.callType || t.action.callType === 'call'))
      .map((t) => ({ ...t.action, tx: t.transactionHash, block: Number(t.blockNumber), pos: Number(t.transactionPosition) }));
  }

  // Transactions to `rooms` in one block, from the block itself. One call, however many there are: a
  // transaction to a room can't fail once it is in a block, since a room has no code and nobody holds a
  // key that could give it some (EIP-7702), so no receipts are needed.
  async blockCalls(rooms, number, budget) {
    if (budget.calls-- <= 0) throw new Error('reply scan: out of calls for this sync');
    const { preferred } = rpcEndpointConfig(1, this.env);
    const block = await this.rpcAt([preferred], 'eth_getBlockByNumber', ['0x' + number.toString(16), true], FULL_BLOCK_MAX_BYTES);
    const ts = Number(BigInt(block.timestamp));
    return (block.transactions || [])
      .filter((tx) => rooms.has(String(tx.to || '').toLowerCase()))
      .map((tx) => ({ from: tx.from, to: tx.to, value: tx.value, input: tx.input, tx: tx.hash, block: number, pos: Number(BigInt(tx.transactionIndex)), ts }));
  }

  // Replies found by trace_filter come without their block's time: look it up, a few blocks per sync.
  async fillReplyTimes() {
    const blocks = this.rows('SELECT DISTINCT block FROM reply WHERE ts IS NULL ORDER BY block DESC LIMIT ?', REPLY_TIMES_PER_SYNC);
    for (const { block } of blocks) {
      const header = await this.rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
      this.sql.exec('UPDATE reply SET ts = ? WHERE block = ? AND ts IS NULL', Number(BigInt(header.timestamp)), block);
    }
  }

  async ingest(logs) {
    const live = logs.filter((log) => !log.removed && log.address?.toLowerCase() === this.contract && log.topics?.length >= 3);
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
      if (topic === T_AUTHORIZED && log.topics.length === 4 && /^0x[0-9a-fA-F]{192}$/.test(log.data || '')) {
        const vh = word(log.data, 0).toLowerCase();
        this.sql.exec(
          'INSERT OR IGNORE INTO auth (block, idx, tx, ts, token, hash, author, blob, publisher, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          block, idx, log.transactionHash, ts, a, b, topicAddress(c), vh, topicAddress(word(log.data, 1)), BigInt(word(log.data, 2)).toString(),
        );
        // A blob may have been published before the author named it (post() does both at once).
        this.sql.exec(
          'INSERT OR IGNORE INTO pub (block, idx, tx, ts, hash, blob, publisher) SELECT block, idx, tx, ts, ?, vh, publisher FROM blobpub WHERE vh = ?',
          b, vh,
        );
        this.recheck(vh);
      } else if (topic === T_BLOB_PUBLISHED && log.topics.length === 3) {
        this.sql.exec(
          'INSERT OR IGNORE INTO blobpub (block, idx, tx, ts, vh, publisher) VALUES (?, ?, ?, ?, ?, ?)',
          block, idx, log.transactionHash, ts, a, topicAddress(b),
        );
        this.sql.exec(
          'INSERT OR IGNORE INTO pub (block, idx, tx, ts, hash, blob, publisher) SELECT DISTINCT ?, ?, ?, ?, hash, blob, ? FROM auth WHERE blob = ?',
          block, idx, log.transactionHash, ts, topicAddress(b), a,
        );
        this.sql.exec('INSERT OR IGNORE INTO blob (vh, block, ts) VALUES (?, ?, ?)', a, block, ts);
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

  // A claim that arrives after its blob was checked (say, an author naming a blob someone else
  // already published with a junk claim): check the blob again, from its kept bytes if it has them.
  // Each new claim costs its author a transaction, so this can't be made to loop.
  recheck(vh) {
    this.sql.exec(
      "UPDATE blob SET status = 'due', tries = 0, next_try = 0 WHERE vh = ? AND status != 'due' AND EXISTS " +
      '(SELECT 1 FROM pub p WHERE p.blob = blob.vh AND NOT EXISTS (SELECT 1 FROM checked c WHERE c.vh = p.blob AND c.hash = p.hash))',
      vh,
    );
  }

  // Full names for tokens that posted, via NameNFT.getFullName (a token's name never changes). A
  // token without a name (say, a subname whose parent was re-registered) is retried daily, so it
  // can't hold up the others.
  async fillNames() {
    const tokens = this.rows(
      'SELECT a.token FROM auth a LEFT JOIN names n ON n.token = a.token ' +
      "WHERE n.token IS NULL OR (n.name = '' AND n.checked < ?) GROUP BY a.token ORDER BY n.checked IS NOT NULL, MIN(a.block) LIMIT 30",
      this.now() - NAME_RETRY_SECONDS,
    ).map((r) => r.token);
    if (!tokens.length) return;
    const calls = tokens.map((token) => ({ target: NAMENFT, data: '0x' + SEL_GETFULLNAME + token.slice(2) }));
    const decoded = decodeAggregate3(await this.rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest']));
    if (!decoded) return;
    tokens.forEach((token, i) => {
      const r = decoded[i];
      let name = '';
      if (r?.success && r.data.length >= 128) {
        const length = Number(BigInt('0x' + r.data.slice(64, 128)));
        name = length <= 1024 ? new TextDecoder().decode(hexToBytes(r.data.slice(128, 128 + length * 2))) : '';
      }
      this.sql.exec('INSERT INTO names (token, name, checked) VALUES (?, ?, ?) ON CONFLICT (token) DO UPDATE SET name = excluded.name, checked = excluded.checked',
        token, name, this.now());
    });
  }

  // Fetch blobs that claim an authorized post. Blobs sent by the publisher the author named (or by
  // the author) go first, so other people's claims can't push them back. Only the claimed entries a
  // blob really contains are recorded; a blob none of whose claims hold is not kept.
  async fetchBlobs() {
    const now = this.now();
    const due = this.rows(
      'SELECT b.vh, b.ts, b.tries, b.bytes, EXISTS (SELECT 1 FROM pub p JOIN auth a ON a.hash = p.hash WHERE p.blob = b.vh ' +
      'AND (p.publisher = a.publisher OR p.publisher = a.author)) AS named FROM blob b ' +
      "WHERE b.status = 'due' AND b.tries < ? AND b.next_try <= ? AND EXISTS (SELECT 1 FROM pub p JOIN auth a ON a.hash = p.hash WHERE p.blob = b.vh) " +
      'ORDER BY named DESC, b.block LIMIT ?',
      BLOB_MAX_TRIES, now, BLOBS_PER_SYNC,
    );
    let fetched = 0;
    for (const { vh, ts, tries, bytes } of due) {
      const kept = bytes ? padBlob(toBytes(bytes)) : null;
      const blob = kept || await this.fetchBlob(vh, ts) || await this.rebuildBlob(vh);
      if (!blob) {
        const wait = Math.min(60 * 2 ** tries, 6 * 3600);
        this.sql.exec('UPDATE blob SET tries = tries + 1, next_try = ? WHERE vh = ?', now + wait, vh);
        continue;
      }
      const claimed = new Set(this.rows('SELECT hash FROM pub WHERE blob = ?', vh).map((r) => r.hash));
      for (const hash of claimed) this.sql.exec('INSERT OR IGNORE INTO checked (vh, hash) VALUES (?, ?)', vh, hash);
      let held = 0;
      for (const entry of decodeBlob(blob)) {
        const hash = postHash(entry);
        if (!claimed.has(hash)) continue;
        claimed.delete(hash);
        held++;
        this.sql.exec('INSERT OR IGNORE INTO carried (vh, hash) VALUES (?, ?)', vh, hash);
        const post = parsePost(entry);
        if (post) this.storeContent(hash, entry, post);
      }
      if (kept) this.sql.exec("UPDATE blob SET status = 'kept' WHERE vh = ?", vh); // it held a claim before
      else if (held) this.sql.exec("UPDATE blob SET status = 'kept', bytes = ?, fetched = ?, tries = tries + 1 WHERE vh = ?", toBuffer(trimBlob(blob)), now, vh);
      else this.sql.exec("UPDATE blob SET status = 'rejected', fetched = ?, tries = tries + 1 WHERE vh = ?", now, vh);
      fetched++;
    }
    return fetched;
  }

  // A blob from the first source whose bytes match its versioned hash (KZG commitment, with the
  // dapp's vendored KZG), so no source is taken on its word: a wrong answer just means the next one.
  async fetchBlob(vh, ts) {
    const { blobVersionedHash } = await import('../dapp/vendor/kzg.bundle.mjs');
    const sources = this.blobSources();
    const attempts = [];
    if (sources.blobscan) attempts.push(async () => this.getJson(`${sources.blobscan}/blobs/${vh}/data`));
    const slot = Math.floor((ts - BEACON_GENESIS) / 12);
    for (const beacon of sources.beacons) {
      attempts.push(async () => (await this.getJson(`${beacon}/eth/v1/beacon/blobs/${slot}?versioned_hashes=${vh}`))?.data?.[0]);
    }
    for (const attempt of attempts) {
      let hex = null;
      try { hex = await attempt(); } catch (_) {}
      if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex) || hex.length !== 2 + BLOB_BYTES * 2) continue;
      const bytes = hexToBytes(hex.slice(2));
      if (blobVersionedHash(bytes) === vh) return bytes;
      console.error(JSON.stringify({ event: 'posts_blob_mismatch', vh }));
    }
    return null;
  }

  // A blob no source has any more (beacon nodes keep them about 18 days), rebuilt from a post it
  // should carry: a post's own blob follows from the post's bytes, and the versioned hash says whether
  // this is it. The bytes come from the index or, once it lost them, from IPFS by the post's hash. A
  // blob holding several posts can't be rebuilt this way; Blobscan or a mirror's copy of it can.
  async rebuildBlob(vh) {
    const { blobVersionedHash } = await import('../dapp/vendor/kzg.bundle.mjs');
    const claims = this.rows('SELECT hash FROM pub WHERE blob = ? GROUP BY hash ORDER BY MIN(block), MIN(idx) LIMIT ?', vh, REBUILD_CLAIMS);
    for (const { hash } of claims) {
      const bytes = this.raw(hash) || await this.postFromIpfs(hash);
      const blob = bytes && encodeBlob([bytes]);
      if (blob && blobVersionedHash(blob) === vh) return blob;
    }
    return null;
  }

  async postFromIpfs(hash) {
    for (const gateway of this.ipfsGateways()) {
      try {
        const response = await this.fetchImpl(`${gateway}/ipfs/${postCid(hash)}`, {
          headers: { 'user-agent': 'gwei.domains posts indexer' },
          signal: AbortSignal.timeout(IPFS_TIMEOUT_MS),
        });
        const bytes = response.ok ? await readCapped(response, MAX_POST_BYTES) : null;
        if (!response.ok) await response.body?.cancel().catch(() => {});
        if (bytes && postHash(bytes) === hash) return bytes;
      } catch (_) {}
    }
    return null;
  }

  ipfsGateways() {
    try { return configuredGateways(this.env.IPFS_GATEWAYS, DEFAULT_IPFS_GATEWAYS); } catch (_) { return DEFAULT_IPFS_GATEWAYS; }
  }

  // CIDs for kept blobs that have none yet (blobs kept before CIDs were recorded), and the zero
  // padding off any blob still stored with it.
  async fillCids() {
    const rows = this.rows(
      'SELECT vh, bytes FROM blob b WHERE bytes IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobcid c WHERE c.vh = b.vh) LIMIT ?', CIDS_PER_SYNC,
    );
    for (const { vh, bytes } of rows) {
      const stored = toBytes(bytes);
      this.sql.exec('INSERT OR IGNORE INTO blobcid (vh, cid) VALUES (?, ?)', vh, await blobCid(padBlob(stored)));
      if (stored.length === BLOB_BYTES) this.sql.exec('UPDATE blob SET bytes = ? WHERE vh = ?', toBuffer(trimBlob(stored)), vh);
    }
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

  // Bytes that never made it into a blob expire (a day if nobody authorized them, three days if
  // someone did). Posts carried by a blob, and the blobs, are kept for good.
  prune() {
    const now = this.now();
    this.sql.exec(
      'DELETE FROM content WHERE NOT EXISTS (SELECT 1 FROM carried k WHERE k.hash = content.hash) AND (received < ? ' +
      'OR (received < ? AND NOT EXISTS (SELECT 1 FROM auth a WHERE a.hash = content.hash)))',
      now - AUTHORIZED_TTL_SECONDS, now - UPLOAD_TTL_SECONDS,
    );
  }

  // --- RPC -------------------------------------------------------------------------------------------
  // The preferred endpoint (the owner's node) is trusted. Public fallbacks aren't taken on their own
  // word: two must answer, the lower head wins, and only logs both return are used.
  async head() {
    const { preferred } = rpcEndpointConfig(1, this.env);
    if (preferred) {
      try { return Number(BigInt(await this.rpcAt([preferred], 'eth_blockNumber', []))); } catch (_) {}
    }
    const answers = await this.publicAnswers('eth_blockNumber', []);
    return Math.min(...answers.map((a) => Number(BigInt(a))));
  }

  async logs(filter) {
    const { preferred } = rpcEndpointConfig(1, this.env);
    if (preferred) {
      try {
        const logs = await this.rpcAt([preferred], 'eth_getLogs', [filter]);
        if (Array.isArray(logs)) return logs;
      } catch (_) {}
    }
    // Without the owner's node, a range counts only when two public endpoints return the same log
    // set. Endpoints that disagree are not an answer: ask the next one, and if no two agree, throw so
    // the cursor stays and the range is read again next sync. One endpoint can't add or hide an event.
    const key = (log) => [log.blockNumber, log.logIndex, log.transactionHash, ...(log.topics || []), log.data, log.removed ? 1 : 0].join('|').toLowerCase();
    const seen = new Map();
    for (const url of rpcEndpointConfig(1, this.env).endpoints.filter((u) => u !== preferred)) {
      let logs;
      try { logs = await this.rpcAt([url], 'eth_getLogs', [filter]); } catch (_) { continue; }
      if (!Array.isArray(logs)) continue;
      const set = logs.map(key).sort().join('\n');
      if (seen.has(set)) return seen.get(set);
      seen.set(set, logs);
    }
    throw new Error('eth_getLogs: no two public endpoints agree');
  }

  // Answers from two different public endpoints, or an error.
  async publicAnswers(method, params) {
    const { endpoints, preferred } = rpcEndpointConfig(1, this.env);
    const answers = [];
    for (const url of endpoints.filter((u) => u !== preferred)) {
      try {
        answers.push(await this.rpcAt([url], method, params));
      } catch (_) {
        continue;
      }
      if (answers.length === 2) return answers;
    }
    throw new Error(`${method}: fewer than two public endpoints answered`);
  }

  // Calls that only read (owners, names, block times) take any endpoint, preferred first.
  rpc(method, params) {
    return this.rpcAt(rpcEndpointConfig(1, this.env).endpoints, method, params);
  }

  async rpcAt(urls, method, params, maxBytes) {
    const { preferred, preferredAuth } = rpcEndpointConfig(1, this.env);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const failures = [];
    for (const url of urls) {
      try {
        const headers = { 'content-type': 'application/json' };
        if (preferredAuth && url === preferred) headers.authorization = preferredAuth;
        const response = await this.fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          failures.push(`${new URL(url).host}: HTTP ${response.status}`);
          continue;
        }
        const json = await readRpcJson(response, maxBytes);
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

// An aggregate3 result holding one ABI string -> the string ('' for anything else).
// The string a call returned first (a lone string, or the first member of a tuple), or ''.
function readAbiString(result) {
  if (!result?.success || !result.data || result.data.length < 128) return '';
  try {
    const at = Number(BigInt('0x' + result.data.slice(0, 64))) * 2;
    const length = Number(BigInt('0x' + result.data.slice(at, at + 64)));
    if (!length || length > 1024 || result.data.length < at + 64 + length * 2) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(result.data.slice(at + 64, at + 64 + length * 2)));
  } catch (_) {
    return '';
  }
}
const abiWord = (n) => BigInt(n).toString(16).padStart(64, '0');
// A name exactly as ENSIP-15 normalizes it, or null.
function normalizedName(name) {
  try {
    return name && name.length <= 255 && ens_normalize(name) === name ? name : null;
  } catch (_) {
    return null;
  }
}

// A response body, or null once it passes `max` bytes.
async function readCapped(response, max) {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

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
