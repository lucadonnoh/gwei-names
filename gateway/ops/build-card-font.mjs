// Builds card-font.js, the pixel font the link-preview cards are drawn with (share-card.js): a subset
// of GNU Unifont (SIL OFL 1.1, see card-font.LICENSE) covering the scripts .gwei names and bios are
// likely to use, emoji included. Run it by hand when the subset changes; nothing fetches it at build
// or deploy time.
//
//   curl -O https://ftp.gnu.org/gnu/unifont/unifont-17.0.05/unifont_all-17.0.05.hex.gz && gunzip unifont_all-17.0.05.hex.gz
//   curl -O https://ftp.gnu.org/gnu/unifont/unifont-17.0.05/unifont-combining-17.0.05.txt
//   node gateway/ops/build-card-font.mjs unifont_all-17.0.05.hex unifont-combining-17.0.05.txt
//
// Format (base64, not compressed: the Worker upload is gzipped anyway, and decoding then costs about
// a millisecond instead of an inflate): u32 glyph count N, N u24 code points (ascending), N bits of
// width (1 = 16 px, else 8 px), u16 count M of combining marks with M (u24 code point, i8 x offset),
// then the bitmaps: 16 rows of 1 or 2 bytes per glyph, most significant bit leftmost.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [hexPath, combiningPath] = process.argv.slice(2);
if (!hexPath || !combiningPath) {
  console.error('usage: node build-card-font.mjs <unifont_all.hex> <unifont-combining.txt>');
  process.exit(1);
}

const glyphs = new Map();
for (const line of readFileSync(hexPath, 'utf8').split('\n')) {
  const m = /^([0-9A-F]{4,6}):([0-9A-F]+)$/.exec(line.trim());
  if (m && (m[2].length === 32 || m[2].length === 64)) glyphs.set(parseInt(m[1], 16), m[2]);
}
const combining = new Map();
for (const line of readFileSync(combiningPath, 'utf8').split('\n')) {
  const m = /^([0-9A-F]{4,6}):(-?\d+)$/.exec(line.trim());
  if (m) combining.set(parseInt(m[1], 16), Number(m[2]));
}

const wanted = new Set();
const range = (a, b) => { for (let c = a; c <= b; c++) wanted.add(c); };
// Latin, IPA and spacing modifiers, combining marks, Greek, Cyrillic, Armenian, Hebrew, Arabic.
range(0x20, 0x7e); range(0xa0, 0x6ff);
range(0x900, 0xdff); // Indic scripts
range(0xe00, 0xeff); // Thai, Lao
range(0x10a0, 0x10ff); // Georgian
range(0x1e00, 0x1fff); // Latin Extended Additional (Vietnamese), Greek Extended
// Punctuation, currency, letterlike, arrows, maths, technical, enclosed, box and block elements,
// shapes, symbols, dingbats: the BMP's emoji-like symbols live here.
range(0x2000, 0x23ff); range(0x2460, 0x27ff); range(0x2900, 0x2bff);
range(0x3000, 0x30ff); // CJK punctuation, kana
range(0x3130, 0x318f); // Hangul compatibility jamo
range(0xff01, 0xffee); // fullwidth punctuation, as CJK text uses it
// Emoji and pictographs: mahjong and cards, enclosed letters and flags, symbols and pictographs.
range(0x1f000, 0x1f02f); range(0x1f0a0, 0x1f2ff); range(0x1f300, 0x1f6ff); range(0x1f780, 0x1f7ff); range(0x1f900, 0x1f9ff); range(0x1fa70, 0x1faff);
// Han characters: the common sets of Chinese (GB 2312 level 1, Big5's frequent set) and Japanese
// (JIS X 0208 level 1), about 7,200; and the 2,350 Hangul syllables of KS X 1001.
const decode = (label, bytes) => {
  try { return new TextDecoder(label, { fatal: true }).decode(Uint8Array.from(bytes)); } catch (_) { return ''; }
};
const legacy = (label, leads, trails, last = 0xffff) => {
  for (const lead of leads) for (const trail of trails) {
    if ((lead << 8 | trail) > last) continue;
    const s = decode(label, [lead, trail]);
    if ([...s].length === 1 && /[\p{Script=Han}\p{Script=Hangul}]/u.test(s)) wanted.add(s.codePointAt(0));
  }
};
const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
legacy('gbk', span(0xb0, 0xd7), span(0xa1, 0xfe));
legacy('big5', span(0xa4, 0xc6), [...span(0x40, 0x7e), ...span(0xa1, 0xfe)], 0xc67e); // the frequent set ends at C67E
legacy('euc-jp', span(0xb0, 0xcf), span(0xa1, 0xfe));
legacy('euc-kr', span(0xb0, 0xc8), span(0xa1, 0xfe));

const codes = [...wanted].filter((c) => glyphs.has(c)).sort((a, b) => a - b);
const n = codes.length;
const marks = codes.filter((c) => combining.has(c) && combining.get(c) !== 0);
const bitmapBytes = codes.reduce((sum, c) => sum + glyphs.get(c).length / 2, 0);
const out = new Uint8Array(4 + n * 3 + Math.ceil(n / 8) + 2 + marks.length * 4 + bitmapBytes);
const view = new DataView(out.buffer);
let at = 0;
view.setUint32(at, n); at += 4;
for (const c of codes) { out[at++] = c >> 16; out[at++] = (c >> 8) & 0xff; out[at++] = c & 0xff; }
codes.forEach((c, i) => { if (glyphs.get(c).length === 64) out[at + (i >> 3)] |= 0x80 >> (i & 7); });
at += Math.ceil(n / 8);
view.setUint16(at, marks.length); at += 2;
for (const c of marks) { out[at++] = c >> 16; out[at++] = (c >> 8) & 0xff; out[at++] = c & 0xff; view.setInt8(at++, combining.get(c)); }
for (const c of codes) { const hex = glyphs.get(c); for (let i = 0; i < hex.length; i += 2) out[at++] = parseInt(hex.slice(i, i + 2), 16); }

const packed = Buffer.from(out).toString('base64');
const target = fileURLToPath(new URL('../card-font.js', import.meta.url));
writeFileSync(target,
  '// Generated by ops/build-card-font.mjs from GNU Unifont 17.0.05; do not edit by hand.\n' +
  '// Copyright (C) 1998-2026 Roman Czyborra, Paul Hardy, Qianqian Fang, Andrew Miller, Johnnie Weaver,\n' +
  '// David Corbett, Ælla Chiana Moskopp, Rebecca Bettencourt, Minseo Lee, Ho-Seok Ee, et al.\n' +
  '// This font data is licensed under the SIL Open Font License, Version 1.1 (card-font.LICENSE).\n' +
  `// ${n} glyphs, ${marks.length} of them combining marks.\n` +
  `export const CARD_FONT = '${packed}';\n`);
console.log(`${n} glyphs (${marks.length} combining), ${out.length} bytes raw, ${packed.length} base64 → ${target}`);
