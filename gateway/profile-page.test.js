import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_TEXT_KEYS, avatarUrl, decodeAggregate3, encodeAggregate3, nftAvatarRef, profileFromResults, renderProfile, renderUnregistered,
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
  assert.doesNotMatch(html, /<script>/);
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
