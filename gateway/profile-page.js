// Every registered name without a website gets a page at <name>.gwei.domains, built from its on-chain
// records and styled like gwei.domains. The records come back in one Multicall3 call; every value a
// name's owner controls is escaped, and links only ever become https/http/mailto URLs.

import { hexToBytes } from './web3-auto.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SEL_AGGREGATE3 = '82ad56cb'; // aggregate3((address,bool,bytes)[])
// ENS text-record keys shown on the page, in display order after the name.
// `header` is the ENS banner-image key; `gwei-page` is this page's own record: a small JSON object
// with an accent `color` and a `links` list (set from the dapp's profile editor).
export const PROFILE_TEXT_KEYS = ['display', 'description', 'avatar', 'url', 'com.twitter', 'com.github', 'org.telegram', 'email', 'header', 'gwei-page'];

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

// Results of [resolve, ownerOf, expiresAt, ...text(PROFILE_TEXT_KEYS)] → the stored profile.
// `registered` follows resolve(): zero means unregistered, expired or otherwise inactive.
export function profileFromResults(results) {
  if (!Array.isArray(results) || results.length !== 3 + PROFILE_TEXT_KEYS.length || !results[0].success) return null;
  const address = decodeAddress(results[0]);
  if (!address) return null;
  if (BigInt(address) === 0n) return { registered: false };
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
  const email = (t.email || '').trim();
  if (/^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i.test(email)) rows.push(['Email', `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`]);
  return rows;
}

// --- generative avatar ----------------------------------------------------------------------------
// For names without an avatar record: a symmetric 7x7 pixel mark (the site's pixel "G" look) on a flat
// share-card background colour with the cards' faint dots. The name's token ID is the seed, so a
// name always gets the same one. The page embeds it as SVG; link previews get the same image as a PNG,
// since X and others don't render SVG.
const AVATAR_COLORS = ['#161616', '#244577', '#175640', '#402370', '#732430']; // SHARE_BGS in dapp/gweiNS.html
const AVATAR_GRID = 7, AVATAR_CELL = 16, AVATAR_SIZE = 160, AVATAR_OFFSET = (AVATAR_SIZE - AVATAR_GRID * AVATAR_CELL) / 2;
function avatarModel(seedHex, accent) {
  const bytes = hexToBytes(String(seedHex).replace(/^0x/, '').padStart(64, '0').slice(-64));
  // The owner's accent colour, when set, replaces the seeded background.
  const color = /^#[0-9a-f]{6}$/i.test(accent || '') ? accent : AVATAR_COLORS[bytes[0] % AVATAR_COLORS.length];
  const cells = [];
  for (let y = 0; y < AVATAR_GRID; y++) {
    for (let x = 0; x < 4; x++) {
      if (bytes[1 + y * 4 + x] < 128) continue;
      cells.push([x, y]);
      if (x < 3) cells.push([AVATAR_GRID - 1 - x, y]);
    }
  }
  // Hash outputs are almost never this sparse or dense, but a nearly blank or solid avatar shouldn't
  // happen at all; the inverse of a symmetric pattern is symmetric too.
  if (cells.length < 10 || cells.length > AVATAR_GRID * AVATAR_GRID - 10) {
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
    cells.map(([x, y]) => `<rect x="${AVATAR_OFFSET + x * AVATAR_CELL}" y="${AVATAR_OFFSET + y * AVATAR_CELL}" width="${AVATAR_CELL}" height="${AVATAR_CELL}" fill="#fff" fill-opacity="0.92"/>`).join('') +
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
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// The same avatar rasterized to a PNG (RGB, zlib via CompressionStream; no dependencies).
export async function avatarPng(seedHex, size = 256, accent) {
  const { color, cells } = avatarModel(seedHex, accent);
  const base = rgb(color);
  const filled = new Set(cells.map(([x, y]) => y * AVATAR_GRID + x));
  const scale = size / AVATAR_SIZE;
  const stride = size * 3 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const c = [...base];
      const mix = (target, alpha) => { for (let i = 0; i < 3; i++) c[i] += (target[i] - c[i]) * alpha; };
      const ux = x / scale, uy = y / scale;
      if (ux % 16 >= 7 && ux % 16 < 9 && uy % 16 >= 7 && uy % 16 < 9) mix([255, 255, 255], 0.06);
      const cx = Math.floor((ux - AVATAR_OFFSET) / AVATAR_CELL), cy = Math.floor((uy - AVATAR_OFFSET) / AVATAR_CELL);
      if (ux >= AVATAR_OFFSET && uy >= AVATAR_OFFSET && cx < AVATAR_GRID && cy < AVATAR_GRID && filled.has(cy * AVATAR_GRID + cx)) {
        mix([255, 255, 255], 0.92);
      }
      raw.set(c.map((v) => Math.round(v)), y * stride + 1 + x * 3);
    }
  }
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, size);
  new DataView(ihdr.buffer).setUint32(4, size);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, deflate, no filter, no interlace
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { png.set(part, at); at += part.length; }
  return png;
}
export const AVATAR_PNG_PATH = '/.well-known/gwei-avatar.png';

// --- badges -----------------------------------------------------------------------------------------
// The share card's name types, plus what makes a name stand out.
function nameBadges(name, profile) {
  const badges = [];
  if (name.endsWith('.zkpassport.gwei')) badges.push('Proof of humanity');
  else if (name.endsWith('.id.gwei')) badges.push('Free name');
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
const STYLE = ':root{--bg:#fff;--fg:#000;--muted:#666;--panel:#f5f5f5;--btn-bg:#000;--btn-fg:#fff;--btn-hover:#333}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#e8e8e0;--muted:#888;--panel:#151515;--btn-bg:#e8e8e0;--btn-fg:#0a0a0a;--btn-hover:#ccc}}' +
  '*{margin:0;padding:0;box-sizing:border-box}' +
  'body{font-family:Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;padding:60px 20px 40px;max-width:480px;margin:0 auto;line-height:1.5}' +
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
  '.post-title{font-size:24px;font-weight:600;line-height:1.25;overflow-wrap:anywhere;margin-bottom:6px}' +
  '.post-meta{font-size:12px;color:var(--muted);letter-spacing:.03em;margin-bottom:28px}' +
  '.post-body{font-size:15px;line-height:1.65;overflow-wrap:anywhere}' +
  '.post-body p,.post-body ul,.post-body ol,.post-body blockquote,.post-body pre{font-size:15px;margin:0 0 16px}' +
  '.post-body h2{font-size:19px;line-height:1.3;margin:32px 0 10px}.post-body h3{font-size:16px;margin:28px 0 8px}' +
  '.post-body h4{font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:24px 0 8px}' +
  '.post-body ul,.post-body ol{padding-left:22px}.post-body li{margin-bottom:4px}' +
  '.post-body blockquote{border-left:2px solid var(--muted);padding-left:14px;color:var(--muted)}' +
  '.post-body pre{background:var(--panel);padding:12px 14px;overflow-x:auto;font-size:13px;line-height:1.5}' +
  '.post-body code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:var(--panel);padding:1px 4px}' +
  '.post-body pre code{background:none;padding:0;font-size:inherit}' +
  '.post-body img{display:block;max-width:100%;height:auto;margin:0 auto}' +
  '.post-body hr{border:0;border-top:1px solid var(--muted);opacity:.4;margin:28px 0}';

export function renderLayout({ title, head = '', body, subtitle = '' }) {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title><link rel="icon" href="https://gwei.domains/favicon.ico">${head}<style>${STYLE}</style>` +
    '<h1><a href="https://gwei.domains">Gwei Name Service</a></h1>' +
    (subtitle ? `<div class="subtitle">${subtitle}</div>` : '<div class="subtitle"></div>') + body;
}

export function metaTags({ title, description, url, image, imageSize, type = 'profile' }) {
  const tag = (attr, key, value) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  return tag('name', 'description', description) +
    tag('property', 'og:type', type) + tag('property', 'og:site_name', 'Gwei Name Service') +
    tag('property', 'og:title', title) + tag('property', 'og:description', description) +
    tag('property', 'og:url', url) + tag('property', 'og:image', image) +
    (imageSize ? tag('property', 'og:image:width', imageSize) + tag('property', 'og:image:height', imageSize) : '') +
    tag('name', 'twitter:card', 'summary') + tag('name', 'twitter:title', title) +
    tag('name', 'twitter:description', description) + tag('name', 'twitter:image', image);
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
  const display = t.display && t.display.toLowerCase() !== name.toLowerCase() ? t.display : '';
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
    head: feed + (avatar?.startsWith('https://')
      ? metaTags({ title: name, description, url: pageUrl, image: avatar })
      : profile.seed
        ? metaTags({ title: name, description, url: pageUrl, image: new URL(AVATAR_PNG_PATH, pageUrl).href, imageSize: '256' })
        : metaTags({ title: name, description, url: pageUrl, image: 'https://gwei.domains/icon-512.png' })),
    body,
  });
}

// The avatar a page shows for a name: its image record (or NFT), else the generated mark.
export function avatarHtml(profile) {
  const avatar = avatarUrl(profile.avatarImage || profile.text?.avatar);
  if (avatar) return `<img class="avatar" src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer">`;
  return profile.seed ? avatarSvg(profile.seed, profile.page?.color) : '';
}

// The image link previews use: the avatar when it's a plain https URL, else the generated PNG.
export function shareImage(profile, pageUrl) {
  const avatar = avatarUrl(profile.avatarImage || profile.text?.avatar);
  if (avatar?.startsWith('https://')) return { image: avatar };
  if (profile.seed) return { image: new URL(AVATAR_PNG_PATH, pageUrl).href, imageSize: '256' };
  return { image: 'https://gwei.domains/icon-512.png' };
}

export function renderUnregistered({ name, dappHash }) {
  return renderLayout({
    title: name,
    subtitle: '.gwei name',
    body: `<div class="name">${escapeHtml(name)}</div><div class="lead muted">isn't registered, or has expired.</div>` +
      `<div class="actions"><a class="btn" href="https://gwei.domains/#${dappHash}">Register it</a></div>`,
  });
}

// No scripts on these pages; images (avatars) over https or inline, styles inline.
export const PROFILE_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
