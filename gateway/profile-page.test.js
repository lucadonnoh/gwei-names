import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import {
  PROFILE_TEXT_KEYS, avatarPng, avatarSvg, avatarUrl, decodeAggregate3, encodeAggregate3, nftAvatarRef, parseGweiPage,
  profileFromResults, renderProfile, renderUnregistered, THEME_SCRIPT,
} from './profile-page.js';

const NFT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
const pad32 = (h) => h.padStart(64, '0');
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const abiString = (s) => { let d = hex(s); while (d.length % 64) d += '0'; return pad32('20') + pad32((hex(s).length / 2).toString(16)) + d; };
const word = (h) => pad32(h);

// Reference values from Foundry: cast calldata 'aggregate3((address,bool,bytes)[])' and cast abi-encode.
test('aggregate3 calldata and results match cast', () => {
  assert.equal(encodeAggregate3([
    { target: NFT, data: '0x4f896d4f' + pad32('ff') },
    { target: NFT, data: '0x1234' },
  ]), '0x82ad56cb00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001000000000000000000000000009d51d507bc7264d4fe8ad1cf7fe191933a0a81d60000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000244f896d4f00000000000000000000000000000000000000000000000000000000000000ff000000000000000000000000000000000000000000000000000000000000000000000000000000009d51d507bc7264d4fe8ad1cf7fe191933a0a81d60000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000');
  assert.deepEqual(decodeAggregate3('0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000beef000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000'), [
    { success: true, data: pad32('beef') },
    { success: false, data: '' },
  ]);
  assert.equal(decodeAggregate3('0x' + pad32('20') + pad32('ff')), null, 'claims more results than fit');
});

const results = ({ address = 'a11ce', owner = 'a11ce', expires = '0', text = {} } = {}) => [
  { success: true, data: word(address) },
  owner === null ? { success: false, data: '' } : { success: true, data: word(owner) },
  { success: true, data: word(expires) },
  ...PROFILE_TEXT_KEYS.map((key) => ({ success: true, data: abiString(text[key] || '') })),
];

test('profiles: unregistered, owner and expiry, and record parsing', () => {
  assert.deepEqual(profileFromResults(results({ address: '0' })), { registered: false });
  const p = profileFromResults(results({ owner: 'b0b', expires: (1877108399).toString(16), text: { description: ' hi ', 'com.twitter': '@alice' } }));
  assert.equal(p.registered, true);
  assert.equal(p.address, '0x' + pad32('a11ce').slice(24));
  assert.equal(p.owner, '0x' + pad32('b0b').slice(24));
  assert.equal(p.expiresAt, 1877108399);
  assert.deepEqual(p.text, { description: 'hi', 'com.twitter': '@alice' });
  assert.equal(profileFromResults(results({ owner: null })).owner, null, 'a reverting ownerOf is tolerated');
  assert.equal(profileFromResults(results().slice(1)), null, 'wrong arity');
});

test('the profile page escapes records and only links to safe URLs', () => {
  const profile = profileFromResults(results({
    owner: 'b0b',
    expires: (1877108399).toString(16),
    text: {
      display: 'Alice <b>',
      description: '<script>alert(1)</script> & co',
      avatar: 'ipfs://bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644/me.png',
      url: 'example.com/blog',
      'com.twitter': 'https://x.com/alice_',
      'com.github': 'alice',
      'org.telegram': 'bad',
      email: 'alice@example.com',
    },
  }));
  const html = renderProfile({ name: 'alice.gwei', dappHash: 'alice', pageUrl: 'https://alice.gwei.domains/', profile });
  assert.doesNotMatch(html.replace(`<script>${THEME_SCRIPT}</script>`, ''), /<script/i, 'no script but the pinned theme switch');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
  assert.match(html, /Alice &lt;b&gt;/);
  assert.match(html, /src="https:\/\/ipfs\.filebase\.io\/ipfs\/bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644\/me\.png"/);
  assert.match(html, /href="https:\/\/example\.com\/blog"/);
  assert.match(html, /href="https:\/\/x\.com\/alice_"/);
  assert.match(html, /href="https:\/\/github\.com\/alice"/);
  assert.doesNotMatch(html, /t\.me/, 'an invalid Telegram handle is dropped');
  assert.match(html, /href="mailto:alice@example\.com"/);
  assert.match(html, /<span>Owner<\/span>/);
  assert.match(html, /<span>Expires<\/span>2029-06-25/);
  assert.match(html, /<meta property="og:title" content="alice\.gwei">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/ipfs\.filebase\.io\/ipfs\//);
  assert.match(html, /href="https:\/\/gwei\.domains\/#alice">View on gwei\.domains/);

  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'http//nope']) {
    const p = profileFromResults(results({ text: { url: bad, avatar: bad } }));
    const out = renderProfile({ name: 'x.gwei', dappHash: 'x', pageUrl: 'https://x.gwei.domains/', profile: p });
    assert.doesNotMatch(out, /javascript:|data:text/, bad);
    assert.doesNotMatch(out, /<span>Website<\/span>/, bad);
    assert.doesNotMatch(out, /class="avatar"/, bad);
  }
  const plain = renderProfile({ name: 'x.gwei', dappHash: 'x', pageUrl: 'https://x.gwei.domains/', profile: profileFromResults(results()) });
  assert.match(plain, /og:image" content="https:\/\/gwei\.domains\/icon-512\.png"/, 'falls back to the GNS icon');
  assert.match(plain, /x\.gwei on the Gwei Name Service/);
  assert.doesNotMatch(plain, /<span>Owner<\/span>/, 'owner hidden when it is the resolved address');
});

test('the unregistered page links to registration', () => {
  const html = renderUnregistered({ name: 'nobody.gwei', dappHash: 'nobody' });
  assert.match(html, /isn't registered, or has expired/);
  assert.match(html, /href="https:\/\/gwei\.domains\/#nobody">Register it/);
});

test('avatars: NFT references are recognized, inline images allowed, everything else dropped', () => {
  assert.deepEqual(nftAvatarRef('eip155:1/erc721:0xAA6612f03443517ced2bdcf27958c22353ceeab9/8977'),
    { standard: 'erc721', contract: '0xaa6612f03443517ced2bdcf27958c22353ceeab9', tokenId: 8977n });
  assert.equal(nftAvatarRef('eip155:1/erc1155:0x86f7692569914b5060ef39aab99e62ec96a6ed45/7680').standard, 'erc1155');
  assert.equal(nftAvatarRef('eip155:137/erc721:0xaa6612f03443517ced2bdcf27958c22353ceeab9/1'), null, 'mainnet only');
  assert.equal(avatarUrl('data:image/svg+xml;base64,PHN2Zy8+'), 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(avatarUrl('data:text/html,<script>x</script>'), null);
  assert.equal(avatarUrl('http://insecure.example/a.png'), null);
});

test('the generated avatar is deterministic per name, symmetric, and a valid PNG', async () => {
  const seedA = 'ab'.repeat(32), seedB = '01'.repeat(32);
  assert.equal(avatarSvg(seedA), avatarSvg(seedA));
  assert.notEqual(avatarSvg(seedA), avatarSvg(seedB));
  const cells = [...avatarSvg(seedA).matchAll(/<rect x="(\d+)" y="(\d+)" width="16"/g)].map(([, x, y]) => `${x},${y}`);
  assert.ok(cells.length >= 16 && cells.length <= 65, 'never nearly blank or solid');
  for (const c of cells) {
    const [x, y] = c.split(',').map(Number);
    assert.ok(cells.includes(`${18 + (8 - (x - 18) / 16) * 16},${y}`), `mirror of ${c}`);
  }
  // 45 independent cells: every one of the left five columns flips with some seed.
  const key = (seed) => avatarSvg(seed).replace(/<rect width="180" height="180" fill="#[0-9a-f]{6}"\/>/, '');
  const seen = new Set();
  const { createHash } = await import('node:crypto');
  for (let i = 0; i < 2000; i++) seen.add(key(createHash('sha256').update(String(i)).digest('hex')));
  assert.equal(seen.size, 2000, 'no repeats in 2000 seeds');

  const png = await avatarPng(seedA, 64);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  assert.equal(String.fromCharCode(...png.subarray(12, 16)), 'IHDR');
  assert.equal(view.getUint32(16), 64);
  assert.equal(view.getUint32(20), 64);
  const idatLength = view.getUint32(33);
  assert.equal(String.fromCharCode(...png.subarray(37, 41)), 'IDAT');
  const pixels = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(pixels.length, 64 * (64 * 3 + 1), 'one filter byte and 64 RGB pixels per row');
  assert.equal(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4)), 'IEND');
});

test('badges mark proof-of-humanity and free names, short, number and emoji names, and primary names', () => {
  const base = profileFromResults(results());
  const badges = (name, extra = {}) => [...renderProfile({ name, dappHash: 'x', pageUrl: 'https://x.gwei.domains/', profile: { ...base, ...extra } })
    .matchAll(/<span class="badge">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(badges('alice.zkpassport.gwei'), ['Proof of humanity']);
  assert.deepEqual(badges('bob.id.gwei'), ['Free name']);
  assert.deepEqual(badges('abc.gwei'), ['Short name']);
  assert.deepEqual(badges('4242.gwei'), ['Number']);
  assert.deepEqual(badges('🦄.gwei', { primary: true }), ['Primary name', 'Emoji', 'Short name']);
  assert.deepEqual(badges('vitalik.gwei'), []);
});

test('gwei-page: accent colour and links are parsed defensively', () => {
  assert.deepEqual(parseGweiPage('{"color":"#175640","links":["https://a.example"," b.example ",""]}'),
    { color: '#175640', links: ['https://a.example', 'b.example'] });
  assert.deepEqual(parseGweiPage('{"color":"red","links":"nope","extra":1}'), null);
  assert.equal(parseGweiPage('not json'), null);
  assert.equal(parseGweiPage('[1,2]'), null);
  assert.equal(parseGweiPage(JSON.stringify({ links: Array.from({ length: 20 }, (_, i) => `https://${i}.example`) })).links.length, 8);
});

test('gwei-page shapes the profile: accent button and avatar, link list, banner, edit link', () => {
  const profile = profileFromResults(results({ text: {
    'gwei-page': JSON.stringify({ color: '#f0e68c', links: ['warpcast.com/alice', 'javascript:alert(1)', 'https://alice.blog/'] }),
    header: 'https://img.example/banner.png',
  } }));
  profile.seed = 'ab'.repeat(32);
  assert.equal(profile.text['gwei-page'], undefined, 'the raw record is not rendered as text');
  const html = renderProfile({ name: 'alice.gwei', dappHash: 'alice', pageUrl: 'https://alice.gwei.domains/', profile });
  assert.match(html, /class="btn" style="background:#f0e68c;border-color:#f0e68c;color:#000"/, 'dark text on a light accent');
  assert.match(html, /<rect width="180" height="180" fill="#f0e68c"\/>/, 'generated avatar uses the accent');
  assert.match(html, /<div class="links"><a href="https:\/\/warpcast\.com\/alice" [^>]*>warpcast\.com\/alice<\/a><a href="https:\/\/alice\.blog\/" [^>]*>alice\.blog<\/a><\/div>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<img class="banner" src="https:\/\/img\.example\/banner\.png"/);
  assert.match(html, /<a href="https:\/\/gwei\.domains\/#alice">edit this profile<\/a>/);

  const dark = profileFromResults(results({ text: { 'gwei-page': '{"color":"#402370"}' } }));
  assert.match(renderProfile({ name: 'x.gwei', dappHash: 'x', pageUrl: 'https://x.gwei.domains/', profile: dark }), /color:#fff"/);
});

test('the theme switch: one hash-pinned script, shared cookie, system theme by default', async () => {
  const { THEME_SCRIPT, THEME_SCRIPT_HASH, PROFILE_CSP, renderLayout } = await import('./profile-page.js');
  const { createHash } = await import('node:crypto');
  assert.equal(THEME_SCRIPT_HASH, `'sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`, 'the CSP hash matches the script');
  assert.match(PROFILE_CSP, new RegExp(`script-src ${THEME_SCRIPT_HASH.replace(/[+/]/g, '\\$&')};`));
  assert.doesNotMatch(PROFILE_CSP, /unsafe-inline'; img|script-src[^;]*unsafe/);
  const html = renderLayout({ title: 't', body: '<p>x</p>' });
  assert.equal(html.split('<script>').length, 2, 'exactly one script');
  assert.ok(html.includes(`<script>${THEME_SCRIPT}</script>`));
  assert.match(html, /<button class="theme-toggle" type="button"/);
  assert.match(html, /:root\.dark\{--bg:#0a0a0a/);
  assert.match(html, /@media \(prefers-color-scheme:dark\)\{:root:not\(\.light\)\{--bg:#0a0a0a/);
  assert.match(THEME_SCRIPT, /domain=gwei\.domains;path=\/;max-age=31536000;samesite=lax;secure/);
});

test('name pages use the name’s avatar as their favicon', async () => {
  const { faviconLinks, renderUnregistered } = await import('./profile-page.js');
  assert.equal(faviconLinks({ seed: 'ab'.repeat(32), text: {} }),
    '<link rel="icon" type="image/png" href="/.well-known/gwei-avatar.png"><link rel="apple-touch-icon" href="/.well-known/gwei-avatar.png">');
  assert.equal(faviconLinks({ seed: 'ab'.repeat(32), text: { avatar: 'ipfs://bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644/me.png' } }),
    '<link rel="icon" href="https://ipfs.filebase.io/ipfs/bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644/me.png">');
  assert.equal(faviconLinks({ seed: 'ab'.repeat(32), avatarImage: 'https://nft.example/a.png?x="y"', text: {} }), '<link rel="icon" href="https://nft.example/a.png?x=%22y%22">');
  assert.equal(faviconLinks({ seed: 'ab'.repeat(32), text: { avatar: 'javascript:alert(1)' } }).includes('gwei-avatar.png'), true, 'unsafe avatars fall back to the generated one');
  const profile = renderProfile({ name: 'alice.gwei', dappHash: 'alice', pageUrl: 'https://alice.gwei.domains/', profile: { seed: 'ab'.repeat(32), text: {}, address: '0x' + '1'.repeat(40) } });
  assert.match(profile, /<link rel="icon" type="image\/png" href="\/\.well-known\/gwei-avatar\.png">/);
  assert.doesNotMatch(profile, /gwei\.domains\/favicon\.ico/);
  assert.match(renderUnregistered({ name: 'nobody.gwei', dappHash: 'nobody' }), /<link rel="icon" href="https:\/\/gwei\.domains\/favicon\.ico">/);
});
