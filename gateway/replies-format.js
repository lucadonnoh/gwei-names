// Replies to GNS posts (posts/SPEC.md, "Replies"). A reply is a calldata-chat message (the protocol
// ethchat.gwei runs on) to the post's room: a successful top-level transaction from the replier to the
// room's address, of exactly 1 wei, whose input is 0x01 + 1 to 1024 bytes of UTF-8. No contract and no
// publisher: the transaction is the reply, and its sender is its author.

export const MAX_REPLY_BYTES = 1024;
export const REPLY_VALUE = 1n;
const FORMAT_VERSION = 1;
const utf8 = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// A calldata-chat named room: the first 20 bytes of SHA-256("calldata-chat/<name>/v1").
export async function namedRoom(name) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(`calldata-chat/${name}/v1`)));
  return '0x' + hex(digest.slice(0, 20));
}

// A post's room is the named room `gwei-` + the first 43 hex digits of its hash: 48 characters, the
// longest name calldata-chat allows, so any calldata-chat client can open the thread too.
export const replyRoomName = (postHash) => 'gwei-' + postHash.slice(2, 45).toLowerCase();
export const replyRoom = (postHash) => namedRoom(replyRoomName(postHash));

// Reply text -> transaction input, or an error a person can act on.
export function encodeReply(text) {
  const bytes = utf8.encode(text);
  if (!bytes.length || bytes.length > MAX_REPLY_BYTES) throw new Error(`A reply is 1 to ${MAX_REPLY_BYTES} bytes of text.`);
  if (strict.decode(bytes) !== text) throw new Error('The reply contains invalid Unicode.');
  return '0x' + FORMAT_VERSION.toString(16).padStart(2, '0') + hex(bytes);
}

// Transaction input -> reply text, or null for anything else (another version, invalid UTF-8).
export function decodeReply(input) {
  if (typeof input !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){2,1025}$/.test(input)) return null;
  if (parseInt(input.slice(2, 4), 16) !== FORMAT_VERSION) return null;
  try {
    return strict.decode(Uint8Array.from(input.slice(4).match(/../g), (b) => parseInt(b, 16)));
  } catch (_) {
    return null;
  }
}

// A top-level call { from, to, value, input } to `room` -> its reply text, or null if it isn't a reply.
export function replyText(call, room) {
  if (call.to?.toLowerCase() !== room.toLowerCase() || call.from?.toLowerCase() === room.toLowerCase()) return null;
  try { if (BigInt(call.value) !== REPLY_VALUE) return null; } catch (_) { return null; }
  return decodeReply(call.input);
}

// Whether a post takes replies. The name's `gwei-replies` text record decides first: space-separated
// `<post id>:on` or `:off` entries, where the post id is the 12 hex digits after 0x (as in its URL),
// set by the name's current owner, the last entry for a post winning. Then the post itself: only
// `"replies": true` takes them. Replies are opt-in, so posts written before they existed, or by a
// publisher that doesn't know them, don't.
export const REPLIES_RECORD = 'gwei-replies';
export function repliesOn(postHash, postReplies, record) {
  const id = postHash.slice(2, 14).toLowerCase();
  let setting = null;
  for (const entry of String(record || '').toLowerCase().split(/\s+/)) {
    const [key, value] = entry.split(':');
    if (key === id && (value === 'on' || value === 'off')) setting = value === 'on';
  }
  return setting ?? postReplies === true;
}

// The record with one post's setting changed (its other entries kept, in order).
export function setRepliesRecord(record, postHash, on) {
  const id = postHash.slice(2, 14).toLowerCase();
  const kept = String(record || '').split(/\s+/).filter((e) => e && e.toLowerCase().split(':')[0] !== id);
  return [...kept, `${id}:${on ? 'on' : 'off'}`].join(' ');
}
