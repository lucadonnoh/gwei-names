// Every registered name without a website gets a page at <name>.gwei.domains, built from its on-chain
// records and styled like gwei.domains. The records come back in one Multicall3 call; every value a
// name's owner controls is escaped, and links only ever become https/http/mailto URLs.

import { hexToBytes } from './web3-auto.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SEL_AGGREGATE3 = '82ad56cb'; // aggregate3((address,bool,bytes)[])
// ENS text-record keys shown on the page, in display order after the name.
// `header` is the ENS banner-image key; `gwei-page` is this page's own record: a small JSON object
// with an accent `color` and a `links` list (set from the dapp's profile editor).
export const PROFILE_TEXT_KEYS = ['display', 'description', 'avatar', 'url', 'com.twitter', 'com.github', 'org.telegram', 'org.signal', 'email', 'header', 'gwei-page'];

const pad32 = (h) => h.padStart(64, '0');
export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- Multicall3 ------------------------------------------------------------------------------------
// aggregate3 with allowFailure on every call, so a reverting ownerOf() doesn't sink the text reads.
export function encodeAggregate3(calls) {
  const elements = calls.map(({ target, data }) => {
    const bytes = data.replace(/^0x/, '');
    let padded = bytes;
    while (padded.length % 64) padded += '0';
    return pad32(target.slice(2).toLowerCase()) + pad32('1') + pad32('60') + pad32((bytes.length / 2).toString(16)) + padded;
  });
  let cursor = calls.length * 32;
  const offsets = elements.map((element) => {
    const offset = pad32(cursor.toString(16));
    cursor += element.length / 2;
    return offset;
  });
  return '0x' + SEL_AGGREGATE3 + pad32('20') + pad32(calls.length.toString(16)) + offsets.join('') + elements.join('');
}

// (bool success, bytes returnData)[] → [{ success, data }] with data as bare hex, or null if malformed.
export function decodeAggregate3(resultHex) {
  const hex = String(resultHex || '').replace(/^0x/, '');
  const word = (at) => {
    if (at < 0 || (at + 32) * 2 > hex.length) throw new Error('out of range');
    return BigInt('0x' + hex.slice(at * 2, at * 2 + 64));
  };
  try {
    const array = Number(word(0));
    const count = Number(word(array));
    if (count > 64) return null;
    const base = array + 32;
    const results = [];
    for (let i = 0; i < count; i++) {
      const element = base + Number(word(base + i * 32));
      const success = word(element) !== 0n;
      const dataAt = element + Number(word(element + 32));
      const length = Number(word(dataAt));
      if ((dataAt + 32 + length) * 2 > hex.length) return null;
      results.push({ success, data: hex.slice((dataAt + 32) * 2, (dataAt + 32 + length) * 2) });
    }
    return results;
  } catch (_) {
    return null;
  }
}

// --- record values ---------------------------------------------------------------------------------
const decodeAddress = (r) => (r?.success && r.data.length >= 64 ? '0x' + r.data.slice(24, 64) : null);
const decodeUint = (r) => (r?.success && r.data.length >= 64 ? BigInt('0x' + r.data.slice(0, 64)) : null);
function decodeString(r) {
  if (!r?.success || r.data.length < 128) return '';
  const at = Number(BigInt('0x' + r.data.slice(0, 64)));
  const length = Number(BigInt('0x' + r.data.slice(at * 2, at * 2 + 64)));
  if ((at + 32 + length) * 2 > r.data.length) return '';
  return new TextDecoder().decode(hexToBytes(r.data.slice((at + 32) * 2, (at + 32 + length) * 2))).trim();
}
const clip = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

// What registering a name would cost, asked in the same Multicall3 call after the text records so a
// name nobody holds can show its price: isAvailable(label, 0), getFee(label bytes), getPremium(id).
// A subname's label has a dot, which isAvailable() rejects, so subnames never get a price.
const SEL_ISAVAILABLE = '8f8dc386', SEL_GETFEE = 'fcee45f4', SEL_GETPREMIUM = '1bf1fffb';
export function priceCalls(target, label, tokenIdHex) {
  const bytes = new TextEncoder().encode(label);
  let data = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  while (data.length % 64) data += '0';
  return [
    { target, data: '0x' + SEL_ISAVAILABLE + pad32('40') + pad32('0') + pad32(bytes.length.toString(16)) + data },
    { target, data: '0x' + SEL_GETFEE + pad32(bytes.length.toString(16)) },
    { target, data: '0x' + SEL_GETPREMIUM + pad32(tokenIdHex) },
  ];
}
// NameNFT's GRACE_PERIOD plus PREMIUM_DECAY_PERIOD: an expired name's premium is gone this long after expiry.
const PREMIUM_GONE_AFTER = (90 + 21) * 86400;

// Results of [resolve, ownerOf, expiresAt, ...text(PROFILE_TEXT_KEYS), ...priceCalls] → the stored profile.
// `registered` follows resolve(): zero means unregistered, expired or otherwise inactive. Such a name
// carries a `price` (wei, as strings, since lookups are cached as JSON) when the registrar would take it.
export function profileFromResults(results) {
  if (!Array.isArray(results) || results.length !== 6 + PROFILE_TEXT_KEYS.length || !results[0].success) return null;
  const address = decodeAddress(results[0]);
  if (!address) return null;
  if (BigInt(address) === 0n) {
    const [available, fee, premium] = results.slice(-3).map(decodeUint);
    if (available !== 1n || fee === null) return { registered: false };
    const expired = decodeUint(results[2]);
    return {
      registered: false,
      price: {
        fee: String(fee),
        ...(premium > 0n && expired > 0n && expired < 1n << 40n ? { premium: String(premium), premiumEnds: Number(expired) + PREMIUM_GONE_AFTER } : {}),
      },
    };
  }
  const text = {};
  PROFILE_TEXT_KEYS.forEach((key, i) => {
    const value = decodeString(results[3 + i]);
    if (value) text[key] = clip(value, key === 'description' ? 500 : 300);
  });
  const expires = decodeUint(results[2]);
  const page = parseGweiPage(text['gwei-page']);
  delete text['gwei-page'];
  return {
    registered: true,
    address,
    owner: decodeAddress(results[1]),
    expiresAt: expires && expires > 0n && expires < 1n << 40n ? Number(expires) : null,
    text,
    ...(page ? { page } : {}),
  };
}

// The `gwei-page` record: { "color": "#rrggbb", "links": ["https://…", …] }. Anything else in it, or
// anything malformed, is ignored; links are validated again when rendered.
export const PAGE_MAX_LINKS = 8;
export function parseGweiPage(value) {
  let raw;
  try {
    raw = JSON.parse(value || '');
  } catch (_) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const page = {};
  if (typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color.trim())) page.color = raw.color.trim().toLowerCase();
  if (Array.isArray(raw.links)) {
    const links = raw.links.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim().slice(0, 300)).slice(0, PAGE_MAX_LINKS);
    if (links.length) page.links = links;
  }
  return Object.keys(page).length ? page : null;
}

function webLink(value) {
  let v = value.trim();
  if (!/^https?:\/\//i.test(v)) {
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/\S*)?$/i.test(v)) return null;
    v = 'https://' + v;
  }
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_) {
    return null;
  }
}
export function avatarUrl(value) {
  const v = (value || '').trim();
  if (v.includes('\u0000')) return null;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([a-zA-Z0-9]{46,100})(\/[^\s?#"'<>]*)?$/.exec(v);
  // Filebase rather than ipfs.io: ipfs.io rate-limits heavily, and a 429 would be a broken image.
  if (ipfs) return `https://ipfs.filebase.io/ipfs/${ipfs[1]}${ipfs[2] || ''}`;
  // Inline images (on-chain NFT art is often an SVG data URI) are fine in <img>, which never runs them.
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(v) && v.length <= 200000) return v;
  const url = /^https:\/\//i.test(v) ? webLink(v) : null;
  return url && url.startsWith('https://') ? url : null;
}

// ENSIP-12 NFT avatar ("eip155:1/erc721:<contract>/<id>", erc1155 likewise) on mainnet.
export function nftAvatarRef(value) {
  const m = /^eip155:1\/(erc721|erc1155):(0x[0-9a-fA-F]{40})\/(\d{1,78})$/.exec((value || '').trim());
  return m ? { standard: m[1], contract: m[2].toLowerCase(), tokenId: BigInt(m[3]) } : null;
}
const handle = (value, pattern) => {
  const h = (value || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter|github)\.com\//i, '').replace(/\/$/, '');
  return pattern.test(h) ? h : null;
};

// Label/value rows for the info panel. Values are already-escaped HTML.
function profileRows(profile) {
  const rows = [];
  const etherscan = (a) => `<a href="https://etherscan.io/address/${a}">${a}</a>`;
  rows.push(['Address', etherscan(profile.address)]);
  if (profile.owner && profile.owner.toLowerCase() !== profile.address.toLowerCase()) rows.push(['Owner', etherscan(profile.owner)]);
  if (profile.expiresAt) rows.push(['Expires', new Date(profile.expiresAt * 1000).toISOString().slice(0, 10)]);
  const t = profile.text || {};
  const site = t.url && webLink(t.url);
  if (site) rows.push(['Website', `<a href="${escapeHtml(site)}" rel="nofollow ugc noopener">${escapeHtml(site.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`]);
  const x = handle(t['com.twitter'], /^[A-Za-z0-9_]{1,15}$/);
  if (x) rows.push(['X', `<a href="https://x.com/${x}" rel="nofollow ugc noopener">@${x}</a>`]);
  const gh = handle(t['com.github'], /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
  if (gh) rows.push(['GitHub', `<a href="https://github.com/${gh}" rel="nofollow ugc noopener">${gh}</a>`]);
  const tg = handle(t['org.telegram'], /^[A-Za-z0-9_]{5,32}$/);
  if (tg) rows.push(['Telegram', `<a href="https://t.me/${tg}" rel="nofollow ugc noopener">@${tg}</a>`]);
  // A Signal username can't be turned into a link (Signal's links are random), so it's shown as text.
  const signal = handle(t['org.signal'], /^[a-z_][a-z0-9_]{2,31}\.(?!00$)(?:\d{2}|[1-9]\d{2,8})$/i);
  if (signal) rows.push(['Signal', signal]);
  const email = (t.email || '').trim();
  if (/^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i.test(email)) rows.push(['Email', `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`]);
  return rows;
}

// --- generative avatar ----------------------------------------------------------------------------
// For names without an avatar record: a symmetric 9x9 pixel mark (the site's pixel "G" look) on a flat
// share-card background colour with the cards' faint dots. The name's token ID is the seed, so a
// name always gets the same one. The page embeds it as SVG; link previews get the same image as a PNG,
// since X and others don't render SVG.
// The pattern alone tells names apart (owners can set the background with their accent colour): 45
// random bits, so two names share one with even odds only at about 7 million names.
const AVATAR_COLORS = ['#161616', '#244577', '#175640', '#402370', '#732430']; // SHARE_BGS in dapp/gweiNS.html
const AVATAR_GRID = 9, AVATAR_HALF = 5, AVATAR_CELL = 16, AVATAR_SIZE = 180, AVATAR_OFFSET = (AVATAR_SIZE - AVATAR_GRID * AVATAR_CELL) / 2;
const AVATAR_MIN_CELLS = 16; // fewer (or more than 81 - 16) lit cells and the pattern is inverted
export function avatarModel(seedHex, accent) {
  const bytes = hexToBytes(String(seedHex).replace(/^0x/, '').padStart(64, '0').slice(-64));
  // The owner's accent colour, when set, replaces the seeded background.
  const color = /^#[0-9a-f]{6}$/i.test(accent || '') ? accent : AVATAR_COLORS[bytes[0] % AVATAR_COLORS.length];
  // One bit per cell of the left half and the middle column, from the bytes after the colour byte.
  const bit = (i) => (bytes[1 + (i >> 3)] >> (i & 7)) & 1;
  const cells = [];
  for (let y = 0; y < AVATAR_GRID; y++) {
    for (let x = 0; x < AVATAR_HALF; x++) {
      if (!bit(y * AVATAR_HALF + x)) continue;
      cells.push([x, y]);
      if (x < AVATAR_HALF - 1) cells.push([AVATAR_GRID - 1 - x, y]);
    }
  }
  // Hash outputs are almost never this sparse or dense, but a nearly blank or solid avatar shouldn't
  // happen at all; the inverse of a symmetric pattern is symmetric too.
  if (cells.length < AVATAR_MIN_CELLS || cells.length > AVATAR_GRID * AVATAR_GRID - AVATAR_MIN_CELLS) {
    const lit = new Set(cells.map(([x, y]) => `${x},${y}`));
    const inverse = [];
    for (let y = 0; y < AVATAR_GRID; y++) for (let x = 0; x < AVATAR_GRID; x++) if (!lit.has(`${x},${y}`)) inverse.push([x, y]);
    return { color, cells: inverse };
  }
  return { color, cells };
}

export function avatarSvg(seedHex, accent) {
  const { color, cells } = avatarModel(seedHex, accent);
  return `<svg class="avatar" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}" shape-rendering="crispEdges" role="img" aria-label="generated avatar">` +
    '<defs><pattern id="av-dots" width="16" height="16" patternUnits="userSpaceOnUse"><rect x="7" y="7" width="2" height="2" fill="#fff" fill-opacity="0.06"/></pattern></defs>' +
    `<rect width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" fill="${color}"/>` +
    `<rect width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" fill="url(#av-dots)"/>` +
    // One path for every cell: as separate translucent rects, neighbours scaled to fractional pixels
    // overlap by a sliver that is painted twice and shows as a light seam (iOS Safari especially).
    `<path fill="#fff" fill-opacity="0.92" d="${cells.map(([x, y]) => `M${AVATAR_OFFSET + x * AVATAR_CELL} ${AVATAR_OFFSET + y * AVATAR_CELL}h${AVATAR_CELL}v${AVATAR_CELL}h-${AVATAR_CELL}z`).join('')}"/>` +
    '</svg>';
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Unfiltered scanlines (a filter byte per row) → PNG, zlib via CompressionStream; no dependencies.
// RGB unless a palette (an array of [r, g, b]) is given, then 8-bit indexed.
export async function encodePng(width, height, raw, palette) {
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, palette ? 3 : 2, 0, 0, 0], 8); // 8-bit, indexed or RGB, deflate, no filter, no interlace
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)];
  if (palette) parts.push(pngChunk('PLTE', Uint8Array.from(palette.flat())));
  parts.push(pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)));
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { png.set(part, at); at += part.length; }
  return png;
}

// The same avatar rasterized to a PNG.
export async function avatarPng(seedHex, size = 256, accent) {
  const { color, cells } = avatarModel(seedHex, accent);
  const filled = new Set(cells.map(([x, y]) => y * AVATAR_GRID + x));
  const scale = size / AVATAR_SIZE;
  // Every pixel is one of four shades (the background, lightened by a grid dot, a lit cell, or both),
  // mixed once here rather than per pixel: the Worker draws this on a request's CPU budget.
  const shades = [false, true].flatMap((dot) => [false, true].map((lit) => {
    const c = rgb(color);
    const mix = (target, alpha) => { for (let i = 0; i < 3; i++) c[i] += (target[i] - c[i]) * alpha; };
    if (dot) mix([255, 255, 255], 0.06);
    if (lit) mix([255, 255, 255], 0.92);
    return c.map((v) => Math.round(v));
  }));
  // Whether a row or column crosses a grid dot, and which cell it falls in (-1 outside the grid).
  const axis = Array.from({ length: size }, (_, v) => {
    const u = v / scale;
    const cell = Math.floor((u - AVATAR_OFFSET) / AVATAR_CELL);
    return { dot: u % 16 >= 7 && u % 16 < 9, cell: u >= AVATAR_OFFSET && cell < AVATAR_GRID ? cell : -1 };
  });
  const stride = size * 3 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    const row = axis[y];
    for (let x = 0; x < size; x++) {
      const col = axis[x];
      const lit = row.cell >= 0 && col.cell >= 0 && filled.has(row.cell * AVATAR_GRID + col.cell);
      const shade = shades[(row.dot && col.dot ? 2 : 0) + (lit ? 1 : 0)];
      const at = y * stride + 1 + x * 3;
      raw[at] = shade[0]; raw[at + 1] = shade[1]; raw[at + 2] = shade[2];
    }
  }
  return encodePng(size, size, raw);
}
export const AVATAR_PNG_PATH = '/.well-known/gwei-avatar.png';

// --- badges -----------------------------------------------------------------------------------------
// The share card's name types, plus what makes a name stand out.
function nameBadges(name, profile) {
  const badges = [];
  // Only the registrars' own children: a deeper name was minted by whoever owns its parent.
  if (/^[^.]+\.zkpassport\.gwei$/.test(name)) badges.push('Proof of humanity');
  else if (/^[^.]+\.id\.gwei$/.test(name)) badges.push('Free name');
  if (profile.primary) badges.push('Primary name');
  const labels = name.slice(0, -'.gwei'.length).split('.');
  if (labels.length === 1) {
    const label = labels[0];
    const length = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(label)].length : [...label].length;
    if (/\p{Extended_Pictographic}/u.test(label)) badges.push('Emoji');
    else if (/^\d+$/.test(label)) badges.push('Number');
    if (length <= 3) badges.push('Short name');
  }
  return badges;
}

// --- page template (gwei.domains look) -------------------------------------------------------------
const DARK_VARS = '--bg:#0a0a0a;--fg:#e8e8e0;--muted:#888;--panel:#151515;--btn-bg:#e8e8e0;--btn-fg:#0a0a0a;--btn-hover:#ccc';
const STYLE = ':root{--bg:#fff;--fg:#000;--muted:#666;--panel:#f5f5f5;--btn-bg:#000;--btn-fg:#fff;--btn-hover:#333}' +
  // Dark follows the browser unless the visitor picked a theme (the .dark / .light class).
  `:root.dark{${DARK_VARS}}@media (prefers-color-scheme:dark){:root:not(.light){${DARK_VARS}}}` +
  '*{margin:0;padding:0;box-sizing:border-box}' +
  // One column width for every gwei.domains page: 730px of content, as on vitalik.eth.limo.
  'body{font-family:Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;padding:60px 20px 80px;max-width:770px;margin:0 auto;line-height:1.5}' +
  'h1{font-size:14px;font-weight:400;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px}h1 a{color:inherit;text-decoration:none}' +
  '.subtitle{font-size:12px;color:var(--muted);margin-bottom:40px;letter-spacing:.03em}' +
  'a{color:var(--fg);text-underline-offset:3px}a:hover{opacity:.55}' +
  'p{font-size:14px;margin-bottom:12px;overflow-wrap:anywhere}' +
  '.name{font-size:24px;font-weight:600;overflow-wrap:anywhere;margin-bottom:8px}' +
  '.lead{font-size:14px;overflow-wrap:anywhere;margin-bottom:6px}.lead.muted{color:var(--muted)}' +
  '.avatar{display:block;width:96px;height:96px;object-fit:cover;margin-bottom:16px;background:var(--panel)}' +
  '.banner{display:block;width:100%;aspect-ratio:3/1;object-fit:cover;margin-bottom:20px;background:var(--panel)}' +
  '.links{margin-top:24px}.links a{display:block;padding:12px 14px;margin-bottom:8px;border:1px solid var(--fg);color:var(--fg);text-decoration:none;font-size:13px;overflow-wrap:anywhere}' +
  '.links a:hover{background:var(--panel);opacity:1}' +
  '.badges{margin:2px 0 10px}.badge{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);border:1px solid var(--muted);padding:2px 7px;margin:0 6px 6px 0}' +
  '.panel{font-size:13px;margin-top:24px;padding:12px;background:var(--panel);overflow-wrap:anywhere}' +
  '.panel div{margin-bottom:6px}.panel div:last-child{margin-bottom:0}' +
  '.panel span{display:inline-block;min-width:76px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-right:8px}' +
  '.actions{margin-top:16px}' +
  '.btn{display:inline-block;padding:12px 24px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;background:var(--btn-bg);color:var(--btn-fg);border:1px solid var(--btn-bg);text-decoration:none;margin:8px 8px 0 0}' +
  '.btn:hover{background:var(--btn-hover);opacity:1}.btn.secondary{background:var(--bg);color:var(--fg)}' +
  '.note{font-size:12px;color:var(--muted);margin-top:40px;line-height:1.6}.note a{color:var(--muted)}' +
  '.section{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:32px 0 4px}' +
  '.post-link{display:flex;gap:14px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--panel);color:var(--fg);text-decoration:none;font-size:14px}' +
  '.post-link:hover{opacity:.55}.post-date{flex:none;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}' +
  '.post-name{flex:1;overflow-wrap:anywhere}.post-link .badge{margin:0}' +
  '.byline{display:inline-flex;align-items:center;gap:10px;color:var(--fg);text-decoration:none;font-size:13px;margin-bottom:28px}' +
  '.byline .avatar{width:32px;height:32px;margin:0}' +
  '.post-title{font-size:28px;font-weight:600;line-height:1.25;overflow-wrap:anywhere;margin-bottom:6px}' +
  '.post-meta{font-size:12px;color:var(--muted);letter-spacing:.03em;margin-bottom:28px}' +
  '.post-body{font-size:16px;line-height:1.75;overflow-wrap:anywhere}' +
  '.post-body p,.post-body ul,.post-body ol,.post-body blockquote{font-size:16px;margin:0 0 18px}.post-body pre{margin:0 0 18px}' +
  '.post-body h2{font-size:22px;line-height:1.3;margin:36px 0 12px}.post-body h3{font-size:18px;margin:30px 0 10px}' +
  '.post-body h4{font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:24px 0 8px}' +
  '.post-body ul,.post-body ol{padding-left:22px}.post-body li{margin-bottom:4px}' +
  '.post-body blockquote{border-left:2px solid var(--muted);padding-left:14px;color:var(--muted)}' +
  '.post-body pre{background:var(--panel);padding:12px 14px;overflow-x:auto;font-size:13px;line-height:1.5}' +
  '.post-body code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:var(--panel);padding:1px 4px}' +
  '.post-body pre code{background:none;padding:0;font-size:inherit}' +
  '.post-body img{display:block;max-width:100%;height:auto;margin:0 auto}' +
  '.post-body hr{border:0;border-top:1px solid var(--muted);opacity:.4;margin:28px 0}' +
  // The theme switch, as on gwei.domains: a moon in light mode, a sun in dark mode. Shown only when
  // the theme script runs (it adds .js).
  // It floats over the text on narrow screens, so it sits on a disc of the page colour.
  '.theme-toggle{display:none;position:fixed;right:20px;bottom:20px;width:40px;height:40px;padding:9px;border:0;border-radius:50%;background:var(--bg);box-shadow:0 1px 6px rgba(0,0,0,.15);color:var(--fg);opacity:.75;cursor:pointer}' +
  '.theme-toggle:hover{opacity:1}.theme-toggle svg{display:block;width:22px;height:22px}:root.js .theme-toggle{display:block}' +
  '.theme-toggle .sun,:root.dark .theme-toggle .moon{display:none}:root.dark .theme-toggle .sun{display:block}' +
  '@media (prefers-color-scheme:dark){:root:not(.light) .theme-toggle .moon{display:none}:root:not(.light) .theme-toggle .sun{display:block}}';

// The visitor's theme choice is one cookie per site (gwei.domains, shared by the dapp and every name
// page there, or gwei.limo): the cookie's domain is the last two labels of the page's host.
// This is the only script these pages run; the CSP allows exactly this text, by hash.
export const THEME_SCRIPT = "(()=>{const r=document.documentElement,m=document.cookie.match(/(?:^|; )gwei-theme=(dark|light)/);" +
  "r.classList.add('js');if(m)r.classList.add(m[1]);document.addEventListener('click',(e)=>{" +
  "if(!e.target.closest||!e.target.closest('.theme-toggle'))return;" +
  "const dark=r.classList.contains('dark')||(!r.classList.contains('light')&&matchMedia('(prefers-color-scheme:dark)').matches),next=dark?'light':'dark';" +
  "r.classList.remove('dark','light');r.classList.add(next);" +
  "document.cookie='gwei-theme='+next+';domain='+location.hostname.split('.').slice(-2).join('.')+';path=/;max-age=31536000;samesite=lax;secure'})})()";
export const THEME_SCRIPT_HASH = "'sha256-QSbCQDQ4kljhA7vttnh5J+kRtdviwGQcubS+uAk0zO0='";
const THEME_TOGGLE = '<button class="theme-toggle" type="button" title="Switch light or dark" aria-label="Switch light or dark mode">' +
  '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
  '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
  '</button>';

// `icon` is the page's favicon link(s); name pages pass the name's avatar (faviconLinks).
export function renderLayout({ title, head = '', body, subtitle = '', icon = '<link rel="icon" href="https://gwei.domains/favicon.ico">' }) {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    `<title>${escapeHtml(title)}</title>${icon}${head}<style>${STYLE}</style>` +
    `<script>${THEME_SCRIPT}</script>` +
    '<h1><a href="https://gwei.domains">Gwei Name Service</a></h1>' +
    (subtitle ? `<div class="subtitle">${subtitle}</div>` : '<div class="subtitle"></div>') + body + THEME_TOGGLE;
}

// Link-preview tags. `url` is the page on the host it was asked for (gwei.limo or gwei.domains), and
// a 1200x630 `image` (a card, see cardImage) is shown large.
export function metaTags({ title, description, url, image, imageWidth, imageHeight, imageAlt, type = 'website' }) {
  const tag = (attr, key, value) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  return `<link rel="canonical" href="${escapeHtml(url)}">` + tag('name', 'description', description) +
    tag('property', 'og:type', type) + tag('property', 'og:site_name', 'Gwei Name Service') +
    tag('property', 'og:title', title) + tag('property', 'og:description', description) +
    tag('property', 'og:url', url) + tag('property', 'og:image', image) +
    (imageWidth ? tag('property', 'og:image:type', 'image/png') + tag('property', 'og:image:width', imageWidth) + tag('property', 'og:image:height', imageHeight) : '') +
    (imageAlt ? tag('property', 'og:image:alt', imageAlt) : '') +
    tag('name', 'twitter:card', imageWidth > imageHeight ? 'summary_large_image' : 'summary') + tag('name', 'twitter:title', title) +
    tag('name', 'twitter:description', description) + tag('name', 'twitter:image', image) +
    (imageAlt ? tag('name', 'twitter:image:alt', imageAlt) : '');
}

// --- link-preview cards ------------------------------------------------------------------------------
// Every page's preview image is a 1200x630 card that share-card.js draws from one of these. Its URL
// carries a hash of what the card shows (?v=), so a records change gives previews a new image to
// fetch, and the Worker keys its cache of drawn cards on the same hash.
export const CARD_PATH = '/.well-known/gwei-card.png';
export const POST_CARD_PATH = /^\/\.well-known\/gwei-card\/([0-9a-f]{12})\.png$/;
export const postCardPath = (hash) => `/.well-known/gwei-card/${hash.slice(2, 14)}.png`;
const CARD_DESIGN = 1; // bump with any change to how cards look, so caches and previews refresh

const displayName = (name, t) => (t.display && t.display.toLowerCase() !== name.toLowerCase() ? t.display : '');
// The page's address as people read it: the name's own (Unicode) labels on the page's domain.
const cardHost = (name, pageUrl) => `${name.slice(0, -'.gwei'.length)}.${new URL(pageUrl).hostname.split('.').slice(-2).join('.')}`;
const CARD_BADGES = ['Proof of humanity', 'Free name', 'Primary name']; // the rest are plain from the name
export function profileCard(name, profile, pageUrl) {
  const t = profile.text || {};
  const display = displayName(name, t);
  return {
    kind: 'profile', name, host: cardHost(name, pageUrl), seed: profile.seed || null, accent: profile.page?.color || null,
    // The owner's own avatar isn't drawn (see share-card.js), and the generated mark would contradict it.
    mark: !avatarUrl(profile.avatarImage || t.avatar),
    // A display name that only repeats the label ("alice" on alice.gwei) adds nothing to the card.
    display: display.toLowerCase() === name.slice(0, -'.gwei'.length).toLowerCase() ? '' : display,
    bio: t.description || '', badges: nameBadges(name, profile).filter((b) => CARD_BADGES.includes(b)),
  };
}
export function postCard(name, profile, post, pageUrl) {
  return {
    kind: 'post', name, host: cardHost(name, pageUrl), seed: profile.seed || null, accent: profile.page?.color || null,
    mark: !avatarUrl(profile.avatarImage || profile.text?.avatar),
    title: post.title, date: Number.isFinite(post.time) ? new Date(post.time * 1000).toISOString().slice(0, 10) : '',
  };
}
// `price` is the profile's (profileFromResults): set when the name can be registered right now.
export function unregisteredCard(name, pageUrl, price) {
  return { kind: 'unregistered', name, host: cardHost(name, pageUrl), ...(price ? priceText(price) : {}) };
}
// Wei → ETH for people: exact for the fixed yearly fees, two significant digits for a decaying premium.
const formatEth = (wei, digits = 6) => (Number(BigInt(wei)) / 1e18).toLocaleString('en-US', { maximumSignificantDigits: digits, useGrouping: false });
function priceText(price) {
  return {
    fee: formatEth(price.fee),
    ...(price.premium ? { premium: formatEth(price.premium, 2), premiumEnds: new Date(price.premiumEnds * 1000).toISOString().slice(0, 10) } : {}),
  };
}

export function cardVersion(card) { // FNV-1a: a cache key, not a security boundary
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify([CARD_DESIGN, card]))) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
// The metaTags image fields for `card`, served at `path` on the page's own host.
export function cardImage(card, path, pageUrl, alt) {
  return { image: new URL(`${path}?v=${cardVersion(card)}`, pageUrl).href, imageWidth: 1200, imageHeight: 630, imageAlt: alt };
}

// `name` is the full name ("alice.gwei"), `dappHash` its gwei.domains link fragment, `pageUrl` this page.
// Readable text on an accent background: black or white, by relative luminance.
export function textOn(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000' : '#fff';
}

// Posts (posts/SPEC.md) listed under the profile, newest first. Each is { hash, title, time, onchain }.
export function postListHtml(posts, postPath) {
  if (!posts?.length) return '';
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  return '<div class="section">Posts</div><div class="posts">' + posts.map((p) =>
    `<a class="post-link" href="${escapeHtml(postPath(p.hash, p.title))}"><span class="post-date">${day(p.time)}</span>` +
    `<span class="post-name">${escapeHtml(p.title)}</span>${p.onchain ? '' : '<span class="badge">Publishing</span>'}</a>`).join('') +
    '</div>';
}

export function renderProfile({ name, dappHash, pageUrl, profile, postsHtml = '' }) {
  const t = profile.text || {};
  const page = profile.page || {};
  const accent = page.color || null;
  const banner = avatarUrl(profile.bannerImage || t.header);
  const links = (page.links || []).map(webLink).filter(Boolean);
  const display = displayName(name, t);
  const avatar = avatarUrl(profile.avatarImage || t.avatar);
  const description = t.description || `${name} on the Gwei Name Service, an ownerless namespace on Ethereum.`;
  const dapp = `https://gwei.domains/#${dappHash}`;
  const rows = profileRows(profile).map(([label, value]) => `<div><span>${label}</span>${value}</div>`).join('');
  const badges = nameBadges(name, profile);
  const share = `https://x.com/intent/post?text=${encodeURIComponent(name)}&url=${encodeURIComponent(pageUrl)}`;
  const body =
    (banner ? `<img class="banner" src="${escapeHtml(banner)}" alt="" referrerpolicy="no-referrer">` : '') +
    (avatar
      ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer">`
      : profile.seed ? avatarSvg(profile.seed, accent) : '') +
    `<div class="name">${escapeHtml(name)}</div>` +
    (badges.length ? `<div class="badges">${badges.map((b) => `<span class="badge">${b}</span>`).join('')}</div>` : '') +
    (display ? `<div class="lead">${escapeHtml(display)}</div>` : '') +
    (t.description ? `<div class="lead muted">${escapeHtml(t.description)}</div>` : '') +
    (links.length
      ? `<div class="links">${links.map((href) => `<a href="${escapeHtml(href)}" rel="nofollow ugc noopener">${escapeHtml(href.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`).join('')}</div>`
      : '') +
    postsHtml +
    `<div class="panel">${rows}</div>` +
    `<div class="actions"><a class="btn"${accent ? ` style="background:${accent};border-color:${accent};color:${textOn(accent)}"` : ''} href="${dapp}">View on gwei.domains</a>` +
    `<a class="btn secondary" href="${escapeHtml(share)}" rel="noopener">Share</a></div>` +
    `<p class="note">This is the default page for ${escapeHtml(name)}. Its owner can ` +
    `<a href="${dapp}">edit this profile</a> or replace the page with a website stored on IPFS, Swarm or a contract: ` +
    '<a href="https://gwei.domains/guide/">host a website →</a></p>';
  const feed = postsHtml ? `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(name)}" href="/feed.xml">` : '';
  return renderLayout({
    title: name,
    subtitle: '.gwei name',
    icon: faviconLinks(profile),
    head: feed + metaTags({
      title: name, description, url: pageUrl,
      ...cardImage(profileCard(name, profile, pageUrl), CARD_PATH, pageUrl, `${name} on the Gwei Name Service`),
    }),
    body,
  });
}

// The avatar a page shows for a name: its image record (or NFT), else the generated mark.
export function avatarHtml(profile) {
  const avatar = avatarUrl(profile.avatarImage || profile.text?.avatar);
  if (avatar) return `<img class="avatar" src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer">`;
  return profile.seed ? avatarSvg(profile.seed, profile.page?.color) : '';
}

// A name's pages use its avatar as their icon: the image record (or NFT) when it has one, else the
// generated mark as a PNG, which every browser takes as a favicon (Safari ignores SVG ones).
export function faviconLinks(profile) {
  const avatar = avatarUrl(profile.avatarImage || profile.text?.avatar);
  if (avatar) return `<link rel="icon" href="${escapeHtml(avatar)}">`;
  if (profile.seed) return `<link rel="icon" type="image/png" href="${AVATAR_PNG_PATH}"><link rel="apple-touch-icon" href="${AVATAR_PNG_PATH}">`;
  return '<link rel="icon" href="https://gwei.domains/favicon.ico">';
}

// Any name can be looked up, so these pages stay out of search indexes; previews still get a card,
// with the price when the name can be registered (`price` from profileFromResults).
export function renderUnregistered({ name, dappHash, pageUrl, price }) {
  const card = pageUrl ? unregisteredCard(name, pageUrl, price) : null;
  const description = !card?.fee ? `${name} isn't registered, or has expired. Register it on gwei.domains.`
    : `${name} is available for ${card.fee} ETH a year` +
      (card.premium ? `, plus a ${card.premium} ETH premium that falls to 0 by ${card.premiumEnds}` : '') + '. Register it on gwei.domains.';
  return renderLayout({
    title: name,
    subtitle: '.gwei name',
    head: card ? '<meta name="robots" content="noindex">' + metaTags({
      title: name, description, url: pageUrl,
      ...cardImage(card, CARD_PATH, pageUrl, card.fee ? `${name} is available for ${card.fee} ETH a year` : `${name} isn't registered`),
    }) : '',
    body: `<div class="name">${escapeHtml(name)}</div><div class="lead muted">isn't registered, or has expired.</div>` +
      `<div class="actions"><a class="btn" href="https://gwei.domains/#${dappHash}">Register it</a></div>`,
  });
}

// No scripts on these pages; images (avatars) over https or inline, styles inline.
export const PROFILE_CSP = `default-src 'none'; script-src ${THEME_SCRIPT_HASH}; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
