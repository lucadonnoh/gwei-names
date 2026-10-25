// Link-preview cards: the 1200x630 PNG that X, Telegram, WhatsApp, Discord and the rest show for a
// name's profile, a post or an unregistered name (profile-page.js says which card a page gets). They
// are drawn here with no dependencies, in the look of the dapp's share card and the generated avatar:
// a flat background in the name's avatar colour with faint dots, the avatar's pixel mark, and text in
// a pixel font (card-font.js, a Unifont subset with emoji and most scripts). A card is 8-bit indexed,
// so the work is a few fills into a byte per pixel plus one deflate, the same for every name.
//
// An owner's own avatar image is not drawn: decoding remote JPEG, WebP, GIF or SVG files would need
// decoders this Worker doesn't have, and a fetch of someone else's server on every new card. Such
// names get a card without the mark (it would contradict their avatar); the page itself still shows it.

import { CARD_FONT } from './card-font.js';
import { avatarModel, encodePng, rgb, textOn } from './profile-page.js';

export const CARD_WIDTH = 1200, CARD_HEIGHT = 630;
const W = CARD_WIDTH, H = CARD_HEIGHT, STRIDE = W + 1; // each scanline starts with its filter byte
const PAD = 72;
const INK_BG = '#161616'; // SHARE_BGS[0] in dapp/gweiNS.html
// Palette slots: 0 is the background, then the text colour (black or white) mixed over it at these strengths.
const DOT = 1, INK = 2, MARK = 3, SOFT = 4, MUTED = 5, PILL = 6;
const MIXES = [0, 0.045, 1, 0.92, 0.78, 0.6, 0.14];

// --- the pixel font --------------------------------------------------------------------------------
// Decoded on first use (about a millisecond: the data isn't compressed) and then kept for the
// isolate's life.
let font = null;
function loadFont() {
  if (font) return font;
  const text = atob(CARD_FONT);
  const bytes = new Uint8Array(text.length); // a plain loop: Uint8Array.from with a callback is ten times slower here
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const n = view.getUint32(0);
  const codes = new Uint32Array(n);
  let at = 4;
  for (let i = 0; i < n; i++, at += 3) codes[i] = bytes[at] << 16 | bytes[at + 1] << 8 | bytes[at + 2];
  const wide = bytes.subarray(at, at + Math.ceil(n / 8));
  at += wide.length;
  const marks = new Map();
  const m = view.getUint16(at);
  at += 2;
  for (let i = 0; i < m; i++, at += 4) marks.set(bytes[at] << 16 | bytes[at + 1] << 8 | bytes[at + 2], view.getInt8(at + 3));
  const offsets = new Uint32Array(n);
  for (let i = 0; i < n; i++) { offsets[i] = at; at += wide[i >> 3] & (0x80 >> (i & 7)) ? 32 : 16; }
  font = { codes, wide, marks, offsets, bytes };
  return font;
}
function glyphIndex(f, cp) {
  let lo = 0, hi = f.codes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (f.codes[mid] === cp) return mid;
    if (f.codes[mid] < cp) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
const glyphWidth = (f, i) => (f.wide[i >> 3] & (0x80 >> (i & 7)) ? 16 : 8);

// --- text: graphemes → clusters of glyphs, in display order ---------------------------------------
// Invisible characters (joiners, variation selectors, tags, bidi controls) and emoji skin tones are not
// drawn; a ZWJ sequence (👩‍💻, 🏳️‍🌈) draws its first emoji, which is how a font without the sequence shows it.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{1f3fb}-\u{1f3ff}\u{e0000}-\u{e0fff}]/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
const RTL = /[\u0590-\u05ff\u0600-\u065f\u066a-\u06ef\u06fa-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const STRONG = /[\p{L}\p{N}]/u;

// Each cluster: { glyphs: [{ index, x }] in font pixels (index -1 is a missing glyph), advance, kind }.
function clusters(f, text) {
  const out = [];
  const segments = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
  for (const segment of segments) {
    const glyphs = [];
    let advance = 0;
    for (const ch of segment.split('\u200d')[0]) {
      if (INVISIBLE.test(ch)) continue;
      const cp = ch.codePointAt(0);
      const index = glyphIndex(f, cp);
      const shift = f.marks.get(cp);
      // Combining marks (accents, vowel signs) sit on what precedes them, as the font draws them.
      if (shift !== undefined && glyphs.length) { glyphs.push({ index, x: advance + shift }); continue; }
      const width = index >= 0 ? glyphWidth(f, index) : cp >= 0x1100 ? 16 : 8;
      glyphs.push({ index, x: advance, width });
      advance += width;
    }
    if (!glyphs.length) continue;
    out.push({ glyphs, advance, text: segment, kind: RTL.test(segment) ? 'R' : STRONG.test(segment) ? 'L' : 'N' });
  }
  // Right-to-left runs (Hebrew, Arabic) read in reverse, with what lies between their letters, as in
  // a left-to-right page. Arabic letters are drawn in their isolated forms.
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'R') continue;
    let end = i;
    for (let j = i + 1; j < out.length && out[j].kind !== 'L'; j++) if (out[j].kind === 'R') end = j;
    out.splice(i, end - i + 1, ...out.slice(i, end + 1).reverse());
    i = end;
  }
  return out;
}
const width = (line) => line.reduce((sum, c) => sum + c.advance, 0);
const ellipsis = (f) => clusters(f, '…')[0];

// Greedy line breaking within `max` font pixels, after a cluster matching `breakAfter` where possible.
// Spaces at a break are dropped. Returns every line; the caller decides what fits.
const CLOSING = /^[、。，．：；！？）」』】〕〉》]$/u; // CJK punctuation that can't start a line
function wrap(list, max, breakAfter) {
  const lines = [];
  let line = [];
  let used = 0;
  for (const c of list) {
    if (used + c.advance > max && line.length) {
      let cut = line.length;
      if (c.text !== ' ') { // a space that overflows is itself the break
        for (let i = line.length - 1; i > 0; i--) if (breakAfter.test(line[i].text)) { cut = i + 1; break; }
        // A break point near the start would waste the line; break mid-word instead.
        if (width(line.slice(0, cut)) < max * 0.4) cut = line.length;
        if (cut === line.length && CLOSING.test(c.text) && line.length > 1) cut--; // takes a character along
      }
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
      while (line.length && line[0].text === ' ') line.shift();
      used = width(line);
    }
    if (!line.length && c.text === ' ') continue;
    line.push(c);
    used += c.advance;
  }
  if (line.length) lines.push(line);
  return lines.map((l) => { while (l.length && l.at(-1).text === ' ') l.pop(); return l; });
}

// Text in at most `maxLines` lines, ending in "…" when it doesn't all fit.
function fitText(f, list, max, maxLines, breakAfter = / /) {
  const lines = wrap(list, max, breakAfter);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  const dots = ellipsis(f);
  while (last.length && (width(last) + dots.advance > max || last.at(-1).text === ' ')) last.pop();
  last.push(dots);
  return kept;
}

// A name as large as fits: one line if possible, else broken after its dots, and as a last resort cut
// in the middle so its end (".gwei", the parent name) stays readable.
const NAME_FITS = [[10, 1], [9, 1], [8, 1], [7, 1], [6, 1], [5, 1], [5, 2], [4, 2], [3, 2], [3, 3]];
function fitName(f, name, maxPx, maxScale = 10) {
  const list = clusters(f, name);
  for (const [scale, maxLines] of NAME_FITS.filter(([sc]) => sc <= maxScale)) {
    const lines = wrap(list, Math.floor(maxPx / scale), /\./);
    if (lines.length <= maxLines) return { scale, lines };
  }
  const [scale, maxLines] = NAME_FITS.at(-1);
  const max = Math.floor(maxPx / scale);
  const tail = list.slice(-Math.min(list.length, 14));
  for (let head = list.length - tail.length; head >= 0; head--) {
    const lines = wrap([...list.slice(0, head), ellipsis(f), ...tail], max, /^$/);
    if (lines.length <= maxLines) return { scale, lines };
  }
  return { scale, lines: wrap(tail, max, /^$/).slice(0, maxLines) };
}

// --- drawing -----------------------------------------------------------------------------------------
function fill(raw, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x)), x1 = Math.min(W, Math.round(x + w));
  const y0 = Math.max(0, Math.round(y)), y1 = Math.min(H, Math.round(y + h));
  if (x0 >= x1) return;
  for (let row = y0; row < y1; row++) raw.fill(color, row * STRIDE + 1 + x0, row * STRIDE + 1 + x1);
}

// Glyph pixels become scale x scale squares; `bold` widens each one to the right (classic pixel bold).
function drawGlyph(raw, f, glyph, x, y, scale, color, bold) {
  if (glyph.index < 0) { // no glyph in the font: an empty box, as fonts draw a missing character
    const w = glyph.width;
    fill(raw, x + scale, y + 2 * scale, (w - 2) * scale, scale, color);
    fill(raw, x + scale, y + 13 * scale, (w - 2) * scale, scale, color);
    fill(raw, x + scale, y + 2 * scale, scale, 12 * scale, color);
    fill(raw, x + (w - 2) * scale, y + 2 * scale, scale, 12 * scale, color);
    return;
  }
  const bytesPerRow = glyphWidth(f, glyph.index) / 8;
  const at = f.offsets[glyph.index];
  for (let row = 0; row < 16; row++) {
    let bits = 0;
    for (let b = 0; b < bytesPerRow; b++) bits = bits << 8 | f.bytes[at + row * bytesPerRow + b];
    const cols = bytesPerRow * 8;
    // Runs of lit pixels are filled at once.
    for (let col = 0; col < cols; col++) {
      if (!(bits & (1 << (cols - 1 - col)))) continue;
      let end = col;
      while (end + 1 < cols && bits & (1 << (cols - 2 - end))) end++;
      fill(raw, x + col * scale, y + row * scale, (end - col + 1) * scale + bold, scale, color);
      col = end;
    }
  }
}
function drawLine(raw, f, line, x, y, scale, color, bold = 0) {
  for (const c of line) {
    for (const g of c.glyphs) drawGlyph(raw, f, g, x + g.x * scale, y, scale, color, bold);
    x += c.advance * scale;
  }
  return x;
}
const boldFor = (scale) => (scale >= 4 ? Math.round(scale / 2) : scale >= 2 ? 1 : 0);

// The generated avatar's 9x9 mark, or the G of the GNS logo (gns-icon.svg), at `cell` pixels per cell.
function drawMark(raw, cells, x, y, cell) {
  for (const [cx, cy] of cells) fill(raw, x + cx * cell, y + cy * cell, cell, cell, MARK);
}
const LOGO_RECTS = [[0, 0, 10, 2], [0, 0, 2, 10], [0, 8, 10, 2], [8, 5, 2, 5], [5, 5, 5, 2]]; // the G, in a 10x10 grid
function drawLogo(raw, x, y, cell, color) {
  for (const [rx, ry, rw, rh] of LOGO_RECTS) fill(raw, x + rx * cell, y + ry * cell, rw * cell, rh * cell, color);
}

// Small uppercase labels in filled pills, like the profile page's badges, right-aligned at `right`.
// Returns where the leftmost one starts.
function drawPills(raw, f, labels, right, y) {
  let x = right;
  for (const label of [...labels].reverse()) {
    const line = clusters(f, label.toUpperCase());
    const w = width(line) * 2 + 32;
    x -= w;
    fill(raw, x, y, w, 44, PILL);
    drawLine(raw, f, line, x + 16, y + 6, 2, SOFT, 1);
    x -= 12;
  }
  return x;
}

// --- layouts -------------------------------------------------------------------------------------------
// Every card: the brand top left, the main block centred in the space left, the page's address and any
// badges at the bottom. `card` comes from profile-page.js (profileCard, postCard, unregisteredCard), or
// is a site card ({ kind: 'site', title, lead, footer }) for the dapp's own pages.
const lineHeight = (scale) => 16 * scale + (scale >= 5 ? 8 : 6);
const TITLE_FITS = [[8, 1], [7, 1], [6, 2], [5, 3], [4, 4], [3, 5]];

// The main block: rows of wrapped text, top to bottom, fitted between the brand and the bottom row.
// Exported for tests.
const TEXT_TOP = PAD + 40, TEXT_BOTTOM = H - PAD - 56;
export function textRows(card, textWidth) {
  const f = loadFont();
  const rows = [];
  const text = (value, scale, color, maxLines, gap, extra) => {
    const list = clusters(f, String(value).replace(/\s+/g, ' ').trim());
    if (list.length) rows.push({ list, lines: fitText(f, list, Math.floor(textWidth / scale), maxLines), scale, color, gap, ...extra });
  };
  // A title as large as fits in a few lines (`fits`: sizes and line counts, largest first).
  const fitsAll = (list, [scale, maxLines]) => wrap(list, Math.floor(textWidth / scale), / /).length <= maxLines;
  const title = (value, fits, gap) => {
    const list = clusters(f, String(value).replace(/\s+/g, ' ').trim());
    const found = fits.findIndex((fit) => fitsAll(list, fit));
    const at = found >= 0 ? found : fits.length - 1;
    const [scale, maxLines] = fits[at];
    rows.push({ list, lines: fitText(f, list, Math.floor(textWidth / scale), maxLines), scale, color: INK, gap, fits, at });
  };
  if (card.kind === 'post') {
    text(card.name, 3, SOFT, 1, 0, { byline: true });
    title(card.title, TITLE_FITS, 28);
    if (card.date) text(card.date, 2, MUTED, 1, 24);
  } else if (card.kind === 'site') {
    title(card.title, [[10, 1], ...TITLE_FITS], 0);
    if (card.lead) text(card.lead, 3, SOFT, 3, 28);
  } else {
    // A premium line needs the room of a smaller name.
    rows.push({ ...fitName(f, card.name, textWidth, card.premium ? 8 : 10), color: INK, gap: 0 });
    if (card.kind === 'unregistered' && card.fee) { // what registering it costs, as the dapp shows it
      text('is available to register', 3, SOFT, 1, card.premium ? 18 : 24);
      text(`${card.fee} ETH / year`, 6, INK, 1, 10);
      if (card.premium) text(`+ ${card.premium} ETH premium, falling to 0 by ${card.premiumEnds}`, 3, MUTED, 2, 10);
    } else if (card.kind === 'unregistered') text('isn\u2019t registered, or has expired.', 3, SOFT, 1, 24);
    if (card.display) text(card.display, 4, SOFT, 1, 24);
    if (card.bio) text(card.bio, 3, MUTED, 3, card.display ? 10 : 24);
  }
  // Whatever doesn't fit first takes a title down to a smaller size that still shows all of it; then
  // loses lines from the bottom up (they end in "…"), then whole rows.
  const height = () => rows.reduce((sum, r) => sum + r.gap + r.lines.length * lineHeight(r.scale), 0);
  while (height() > TEXT_BOTTOM - TEXT_TOP) {
    const t = rows.find((row) => row.fits);
    const smaller = t ? t.fits.findIndex((fit, i) => i > t.at && fitsAll(t.list, fit)) : -1;
    if (smaller >= 0) {
      t.at = smaller;
      [t.scale] = t.fits[smaller];
      t.lines = fitText(f, t.list, Math.floor(textWidth / t.scale), t.fits[smaller][1]);
      continue;
    }
    const r = rows.findLast((row) => row.list && row.lines.length > 1);
    if (r) r.lines = fitText(f, r.list, Math.floor(textWidth / r.scale), r.lines.length - 1);
    else if (rows.length > 1) rows.pop();
    else break;
  }
  return rows;
}

export async function renderCard(card) {
  const f = loadFont();
  const model = card.seed ? avatarModel(card.seed, card.accent) : { color: card.accent || INK_BG, cells: [] };
  const base = rgb(model.color);
  const ink = rgb(textOn(model.color) === '#000' ? '#000000' : '#ffffff');
  const palette = MIXES.map((a) => base.map((v, i) => Math.round(v + (ink[i] - v) * a)));
  // The mark is white whatever the text colour, as in the generated avatar the page shows.
  palette[MARK] = base.map((v) => Math.round(v + (255 - v) * 0.92));
  const raw = new Uint8Array(STRIDE * H); // zero: filter "none" and the background colour
  for (let y = 30; y < H; y += 20) for (let x = 30; x < W; x += 20) fill(raw, x, y, 2, 2, DOT);

  // The brand, as on the dapp's share card; then the bottom row: badges at the right, the address.
  drawLogo(raw, PAD, PAD - 8, 3.2, MUTED);
  drawLine(raw, f, clusters(f, 'gwei name service'), PAD + 50, PAD - 12, 2, MUTED, 1);
  const pillsLeft = card.badges?.length ? drawPills(raw, f, card.badges, W - PAD, H - PAD - 40) : W - PAD;
  const footer = clusters(f, card.footer || card.host || '');
  if (footer.length) drawLine(raw, f, fitText(f, footer, Math.floor((pillsLeft - 24 - PAD) / 2), 1)[0], PAD, H - PAD - 34, 2, MUTED, 1);

  // The mark (or the logo) takes the right side; text gets what is left.
  const side = 288;
  const showMark = card.kind === 'site' || (card.mark && model.cells.length);
  const textWidth = (showMark ? W - PAD - side - 64 : W - PAD) - PAD;
  if (card.kind === 'site') drawLogo(raw, W - PAD - side + 4, (H - 280) / 2, 28, MARK);
  else if (showMark) drawMark(raw, model.cells, W - PAD - side, (H - side) / 2, side / 9);

  const rows = textRows(card, textWidth);
  const height = rows.reduce((sum, r) => sum + r.gap + r.lines.length * lineHeight(r.scale), 0);
  let y = Math.round(TEXT_TOP + Math.max(0, (TEXT_BOTTOM - TEXT_TOP - height) / 2));
  for (const r of rows) {
    y += r.gap;
    let x = PAD;
    if (r.byline && card.mark && model.cells.length) { // a small mark before the author's name
      drawMark(raw, model.cells, x, y + 4, 4.5);
      x += 56;
    }
    for (const line of r.lines) {
      drawLine(raw, f, line, x, y, r.scale, r.color, r.color === INK || r.byline ? boldFor(r.scale) : Math.min(1, boldFor(r.scale)));
      y += lineHeight(r.scale);
    }
  }
  return encodePng(W, H, raw, palette);
}
