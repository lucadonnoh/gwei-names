// The byte formats of GNS posts (posts/SPEC.md): a post is a small JSON document named by its
// keccak-256 hash, and a blob carries one or more posts in a length-prefixed container.

import { keccak256 } from './web3-auto.js';

export const BLOB_BYTES = 131072; // 4096 field elements of 32 bytes
const FIELD_ELEMENTS = 4096;
const FE_DATA = 31; // byte 0 of every field element is zero, which keeps it below the BLS modulus
export const BLOB_PAYLOAD_BYTES = FIELD_ELEMENTS * FE_DATA; // 126976
const MAGIC = [0x67, 0x77, 0x65, 0x69]; // "gwei"
const VERSION = 1;
const HEADER = MAGIC.length + 1;
// One post fits in one blob: the payload minus the header and its own 3-byte length.
export const MAX_POST_BYTES = BLOB_PAYLOAD_BYTES - HEADER - 3;
export const MAX_TITLE_CHARS = 200;

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const postHash = (bytes) => '0x' + toHex(keccak256(bytes));

// A v1 post: { "v": 1, "title": string, "body": string, "time"?: unix seconds }. Unknown fields are
// ignored, so later versions can add some. Returns null for anything else.
export function parsePost(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_POST_BYTES) return null;
  let doc;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.v !== 1) return null;
  if (typeof doc.title !== 'string' || typeof doc.body !== 'string') return null;
  const title = doc.title.trim();
  if (!title || [...title].length > MAX_TITLE_CHARS) return null;
  const time = Number.isSafeInteger(doc.time) && doc.time > 0 && doc.time < 1e11 ? doc.time : null;
  return { title, body: doc.body, time };
}

// Serialize a post the way the dapp does: fixed key order, no whitespace.
export function encodePost({ title, body, time }) {
  const doc = { v: 1, title, body };
  if (time != null) doc.time = time;
  return new TextEncoder().encode(JSON.stringify(doc));
}

// Blob → payload bytes, or null if any field element has a nonzero top byte (not this encoding).
function blobPayload(blob) {
  if (!(blob instanceof Uint8Array) || blob.length !== BLOB_BYTES) return null;
  const payload = new Uint8Array(BLOB_PAYLOAD_BYTES);
  for (let i = 0; i < FIELD_ELEMENTS; i++) {
    if (blob[i * 32] !== 0) return null;
    payload.set(blob.subarray(i * 32 + 1, i * 32 + 32), i * FE_DATA);
  }
  return payload;
}

// The posts a blob carries, as raw byte strings. A blob in any other format carries none.
export function decodeBlob(blob) {
  const payload = blobPayload(blob);
  if (!payload || !MAGIC.every((b, i) => payload[i] === b) || payload[MAGIC.length] !== VERSION) return [];
  const entries = [];
  let at = HEADER;
  while (at + 3 <= payload.length) {
    const length = (payload[at] << 16) | (payload[at + 1] << 8) | payload[at + 2];
    if (length === 0 || at + 3 + length > payload.length) break;
    entries.push(payload.slice(at + 3, at + 3 + length));
    at += 3 + length;
  }
  return entries;
}

// Posts → one blob, or null if they don't fit. Used by tests and by tools that publish their own blobs.
export function encodeBlob(entries) {
  const size = HEADER + entries.reduce((n, e) => n + 3 + e.length, 0);
  if (!entries.length || size > BLOB_PAYLOAD_BYTES || entries.some((e) => !e.length)) return null;
  const payload = new Uint8Array(BLOB_PAYLOAD_BYTES);
  payload.set(MAGIC, 0);
  payload[MAGIC.length] = VERSION;
  let at = HEADER;
  for (const entry of entries) {
    payload.set([entry.length >> 16, (entry.length >> 8) & 0xff, entry.length & 0xff], at);
    payload.set(entry, at + 3);
    at += 3 + entry.length;
  }
  const blob = new Uint8Array(BLOB_BYTES);
  for (let i = 0; i < FIELD_ELEMENTS; i++) blob.set(payload.subarray(i * FE_DATA, (i + 1) * FE_DATA), i * 32 + 1);
  return blob;
}

// URL path for a post: a 12-hex-digit hash prefix, then the title as a readable slug.
export function postPath(hash, title) {
  const slug = (title || '').normalize('NFKD').toLowerCase().replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `/posts/${hash.slice(2, 14)}${slug ? '-' + slug : ''}`;
}
export const POST_PATH = /^\/posts\/([0-9a-f]{12})(?:-[a-z0-9-]*)?\/?$/;
