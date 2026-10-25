import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { CARD_HEIGHT, CARD_WIDTH, renderCard } from './share-card.js';
import { cardVersion, postCard, profileCard, unregisteredCard } from './profile-page.js';

// A strict reader for the PNGs the cards are: every chunk's CRC, the header, and the scanlines.
function readPng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    assert.equal(view.getUint32(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type).filter((t, i, all) => t !== all[i - 1]), ['IHDR', 'PLTE', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  const header = new DataView(ihdr.buffer, ihdr.byteOffset);
  const palette = chunks.find((c) => c.type === 'PLTE').data;
  return {
    width: header.getUint32(0), height: header.getUint32(4), depth: ihdr[8], colorType: ihdr[9], interlace: ihdr[12],
    colors: palette.length / 3, palette,
    pixels: inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))),
  };
}

const SEED = '4af9471d1f0ffa0a3f725e0f0932984bb35187d5da3e24a9a55c9754aa9c0a01';
const profile = (text = {}, extra = {}) => ({ registered: true, seed: SEED, text, ...extra });
const PAGE = 'https://alice.gwei.limo/';

test('cards are valid 1200x630 indexed PNGs, small enough for every platform', async () => {
  const cards = [
    profileCard('alice.gwei', profile({ display: 'Alice', description: 'builds things' }, { primary: true }), PAGE),
    profileCard('alice.gwei', profile({ avatar: 'https://example.com/a.jpg' }), PAGE),
    postCard('alice.gwei', profile(), { title: 'Exploring the blobspace', time: 1667844963 }, PAGE),
    unregisteredCard('nobody.gwei', 'https://nobody.gwei.domains/'),
    { kind: 'site', title: 'yourname.gwei', lead: 'The ownerless and unruggable ENS alternative on Ethereum.', footer: 'gwei.domains' },
  ];
  for (const card of cards) {
    const png = await renderCard(card);
    const image = readPng(png);
    assert.deepEqual([image.width, image.height, image.depth, image.colorType, image.interlace], [CARD_WIDTH, CARD_HEIGHT, 8, 3, 0], card.kind);
    assert.equal(image.pixels.length, CARD_HEIGHT * (CARD_WIDTH + 1), 'a filter byte and 1200 indices per row');
    for (let y = 0; y < CARD_HEIGHT; y++) {
      const row = image.pixels.subarray(y * (CARD_WIDTH + 1), (y + 1) * (CARD_WIDTH + 1));
      assert.equal(row[0], 0, 'filter: none');
      assert.ok(Math.max(...row.subarray(1)) < image.colors, 'every index is in the palette');
    }
    assert.ok(png.length < 64 * 1024, `${card.kind} card is ${png.length} bytes`);
  }
});

test('the text takes the colour readable on the background, the mark stays white', async () => {
  const colorsOf = async (card) => {
    const { palette } = readPng(await renderCard(card));
    return { bg: [...palette.subarray(0, 3)], ink: [...palette.subarray(6, 9)], mark: [...palette.subarray(9, 12)] };
  };
  const light = await colorsOf(profileCard('a.gwei', profile({}, { page: { color: '#e6a800' } }), PAGE));
  assert.deepEqual(light.bg, [0xe6, 0xa8, 0x00], 'the accent colour is the background');
  assert.deepEqual(light.ink, [0, 0, 0], 'black text on a light accent');
  assert.ok(light.mark.every((v) => v >= 0.92 * 255), 'a white mark, as in the avatar');
  const dark = await colorsOf(unregisteredCard('a.gwei', PAGE));
  assert.deepEqual(dark.ink, [255, 255, 255]);
});

test('names in any script, emoji and hostile text render without breaking the image', async () => {
  const names = [
    '🦄.gwei', '👩‍💻🇮🇹.gwei', '1️⃣.gwei', '三三三.gwei', '한국어.gwei', 'привет.gwei', 'שלום.gwei', 'مرحبا.gwei', 'नमस्ते.gwei',
    'ภาษาไทย.gwei', 'e\u0301cole.gwei', '\u200d\ufe0f.gwei', '\u{10fffd}\u{e0001}.gwei',
    'a'.repeat(250) + '.gwei', `${'x'.repeat(60)}.${'y'.repeat(60)}.${'z'.repeat(60)}.gwei`, '🦄'.repeat(62) + '.gwei',
  ];
  const hostile = ['\u202egnp.exe', '<script>alert(1)</script>', '\u0000\u0001\t\n\r', '🦄'.repeat(250), 'w'.repeat(500), ' '.repeat(300)];
  for (const name of names) {
    for (const description of [hostile[names.indexOf(name) % hostile.length], '']) {
      const png = await renderCard(profileCard(name, profile({ display: description, description }), PAGE));
      const image = readPng(png);
      assert.equal(image.width, CARD_WIDTH, name);
      assert.equal(image.pixels.length, CARD_HEIGHT * (CARD_WIDTH + 1), name);
    }
  }
  const title = '𝕏'.repeat(200);
  assert.equal(readPng(await renderCard(postCard('a.gwei', profile(), { title, time: 0 }, PAGE))).height, CARD_HEIGHT);
});

test('the font has emoji and the common scripts; anything else is a box, never a crash', async () => {
  const pixels = async (name) => readPng(await renderCard(unregisteredCard(name, 'https://x.gwei.limo/'))).pixels;
  // Two cards that differ in one character are different images only if the font draws both.
  for (const [a, b] of [['🦄.gwei', '🐴.gwei'], ['三.gwei', '二.gwei'], ['가.gwei', '나.gwei'], ['ж.gwei', 'з.gwei'], ['א.gwei', 'ב.gwei'], ['é.gwei', 'è.gwei']]) {
    assert.notDeepEqual(await pixels(a), await pixels(b), `${a} and ${b} are drawn`);
  }
  // Characters outside the subset are drawn as the same empty box.
  assert.deepEqual(await pixels('\u{10fffd}.gwei'), await pixels('\u{10fffc}.gwei'));
  // A ZWJ sequence draws its first emoji, and invisible characters nothing at all.
  assert.deepEqual(await pixels('👩‍💻.gwei'), await pixels('👩.gwei'));
  assert.deepEqual(await pixels('a\u200b\ufe0f.gwei'), await pixels('a.gwei'));
});

test('a card’s version follows what it shows, and only that', () => {
  const base = profileCard('alice.gwei', profile({ description: 'hi', 'com.twitter': 'alice' }), PAGE);
  const v = cardVersion(base);
  assert.match(v, /^[0-9a-f]{8}$/);
  assert.equal(cardVersion(profileCard('alice.gwei', profile({ description: 'hi', 'com.twitter': 'alice' }), PAGE)), v, 'deterministic');
  assert.equal(cardVersion(profileCard('alice.gwei', profile({ description: 'hi', 'com.twitter': 'bob' }), PAGE)), v, 'records the card leaves out');
  assert.notEqual(cardVersion(profileCard('alice.gwei', profile({ description: 'hello' }), PAGE)), v, 'the bio');
  assert.notEqual(cardVersion(profileCard('alice.gwei', profile({ description: 'hi' }, { page: { color: '#175640' } }), PAGE)), v, 'the accent');
  assert.notEqual(cardVersion(profileCard('alice.gwei', profile({ description: 'hi' }), 'https://alice.gwei.domains/')), v, 'the host it shows');
  // What the card shows: the name's own labels on the page's domain, not the Punycode host.
  assert.equal(profileCard('🦄.gwei', profile(), 'https://xn--4s9h.gwei.limo/').host, '🦄.gwei.limo');
  assert.equal(profileCard('alice.gwei', profile({ display: 'Alice' }), PAGE).display, '', 'a display name repeating the label');
  assert.deepEqual(profileCard('bob.zkpassport.gwei', profile({}, { primary: true }), PAGE).badges, ['Proof of humanity', 'Primary name']);
  assert.equal(profileCard('alice.gwei', profile({ avatar: 'ipfs://bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644/me.png' }), PAGE).mark, false,
    'an owner’s own avatar replaces the generated mark');
});
