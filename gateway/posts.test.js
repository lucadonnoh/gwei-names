// Tests for posts: the byte formats (posts-format.js), the Markdown and math renderers, and the
// post index (posts-store.js) running on node:sqlite with mocked RPC and blob sources.
// Run: `node --test posts.test.js`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  BLOB_BYTES, BLOB_PAYLOAD_BYTES, MAX_POST_BYTES, POST_PATH, decodeBlob, encodeBlob, encodePost, parsePost, postHash, postPath,
} from './posts-format.js';
import { excerpt, linkUrl, renderMarkdown } from './markdown.js';
import { texToMathml } from './math.js';
import { PostStore, T_AUTHORIZED, T_BLOB_PUBLISHED, T_REMOVED, clientKey } from './posts-store.js';
import { keccak256 } from './web3-auto.js';
import { blobVersionedHash } from '../dapp/vendor/kzg.bundle.mjs';

const utf8 = (s) => new TextEncoder().encode(s);
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const pad32 = (h) => h.padStart(64, '0');

// --- formats -----------------------------------------------------------------------------------
test('event topics are the keccak of the GnsPosts event signatures', () => {
  const topic = (sig) => '0x' + toHex(keccak256(utf8(sig)));
  assert.equal(T_AUTHORIZED, topic('PostAuthorized(uint256,bytes32,address,bytes32,address,uint256)'));
  assert.equal(T_BLOB_PUBLISHED, topic('BlobPublished(bytes32,address,uint256)'));
  assert.equal(T_REMOVED, topic('PostRemoved(uint256,bytes32,address)'));
});

test('parsePost accepts v1 posts and rejects everything else', () => {
  assert.deepEqual(parsePost(encodePost({ title: ' Hello ', body: 'hi' })), { title: 'Hello', body: 'hi' });
  assert.deepEqual(parsePost(utf8('{"v":1,"title":"t","body":"","extra":[1]}')), { title: 't', body: '' });
  assert.deepEqual(parsePost(utf8('{"v":1,"title":"t","body":"b","time":1}')), { title: 't', body: 'b' }, 'a post has no date of its own');
  assert.equal(new TextDecoder().decode(encodePost({ title: 't', body: 'b' })), '{"v":1,"title":"t","body":"b"}');
  for (const bad of ['', 'nope', '[]', '{"v":2,"title":"t","body":"b"}', '{"v":1,"title":"","body":"b"}',
    '{"v":1,"title":"t"}', '{"v":1,"title":1,"body":"b"}', `{"v":1,"title":"${'x'.repeat(201)}","body":"b"}`]) {
    assert.equal(parsePost(utf8(bad)), null, bad);
  }
  assert.equal(parsePost(Uint8Array.from([0x7b, 0xff, 0x7d])), null, 'invalid UTF-8');
  const big = encodePost({ title: 't', body: 'x'.repeat(MAX_POST_BYTES) });
  assert.equal(parsePost(big), null, 'over the size limit');
});

test('blob container round-trips posts and ignores foreign blobs', () => {
  const a = encodePost({ title: 'a', body: 'first' });
  const b = encodePost({ title: 'b', body: 'ü'.repeat(1000) });
  const blob = encodeBlob([a, b]);
  assert.equal(blob.length, BLOB_BYTES);
  for (let i = 0; i < 4096; i++) assert.equal(blob[i * 32], 0, 'top byte of each field element is zero');
  assert.deepEqual(decodeBlob(blob).map(toHex), [a, b].map(toHex));

  // The largest post fits alone; one byte more doesn't.
  const max = new Uint8Array(MAX_POST_BYTES).fill(0x61);
  assert.equal(decodeBlob(encodeBlob([max]))[0].length, MAX_POST_BYTES);
  assert.equal(encodeBlob([new Uint8Array(MAX_POST_BYTES + 1)]), null);
  assert.equal(BLOB_PAYLOAD_BYTES, 4096 * 31);

  const foreign = new Uint8Array(BLOB_BYTES).fill(1);
  assert.deepEqual(decodeBlob(foreign), []);
  const otherMagic = encodeBlob([a]);
  otherMagic[1] = 0x41;
  assert.deepEqual(decodeBlob(otherMagic), []);
  assert.deepEqual(decodeBlob(new Uint8Array(10)), []);
});

test('post paths use a hash prefix and a readable slug', () => {
  const hash = '0x' + 'ab12'.repeat(16);
  assert.equal(postPath(hash, 'Exploring the blobspace!'), '/posts/ab12ab12ab12-exploring-the-blobspace');
  assert.equal(postPath(hash, 'Café über'), '/posts/ab12ab12ab12-cafe-uber');
  assert.equal(postPath(hash, '🦄'), '/posts/ab12ab12ab12');
  assert.equal(POST_PATH.exec('/posts/ab12ab12ab12-anything-here')[1], 'ab12ab12ab12');
  assert.equal(POST_PATH.exec('/posts/ab12ab12ab12')[1], 'ab12ab12ab12');
  assert.equal(POST_PATH.exec('/posts/ab12'), null);
});

// --- markdown ----------------------------------------------------------------------------------
test('markdown renders the supported subset', () => {
  const html = renderMarkdown('# Title *x*\n\nSome **bold**, _em_, ~~gone~~ and `<code>`.\nNew line\n\n- a\n- b\n\n2. two\n3. three\n\n> quote\n\n---\n\n```\nx < y\n```');
  assert.match(html, /^<h2 id="title-x">Title <em>x<\/em><\/h2>/);
  assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <del>gone<\/del> and <code>&lt;code&gt;<\/code>\.<br>New line/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul><ol start="2"><li>two<\/li><li>three<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote><hr><pre><code>x &lt; y<\/code><\/pre>$/);
  assert.match(renderMarkdown('snake_case_name'), /snake_case_name/);
  assert.match(renderMarkdown('## A\n\n## A'), /id="a".*id="a-1"/);
});

test('markdown never passes HTML or unsafe URLs through', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '![x](javascript:alert(1))',
    '[x](//evil.example/path)',
    '[a"onmouseover="x](https://a.example"onclick="y)',
    'https://a.example/"onmouseover=alert(1)',
    '`</code><script>`',
    '$\\text{<script>}$',
    '**<b>**',
    // A held span inside a link or image destination, or inside alt text, must not be expanded there.
    '[click](/![x](https://i.example/a;style=color:red))',
    '[x](/![a](https://i.example/p/data-probe=1))',
    '![![a](https://i.example/b.png)](https://i.example/a.png)',
    '![`code`](https://i.example/a.png)',
    '![$\\mathrm{a}$](https://i.example/a.png)',
    '![x](https://i.example/`a`)',
  ];
  // Every tag and attribute in the output must be one the renderer emits itself.
  const TAGS = new Set(['p', 'a', 'img', 'code', 'pre', 'em', 'strong', 'del', 'br', 'math', 'mi', 'mo', 'mn', 'mtext', 'mrow']);
  const ATTRS = new Set(['href', 'src', 'alt', 'loading', 'referrerpolicy', 'rel']);
  for (const attack of attacks) {
    const html = renderMarkdown(attack);
    for (const [, tag, attrs] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
      assert.ok(TAGS.has(tag), `${attack} → <${tag}> in ${html}`);
      const rest = attrs.replace(/\s([a-z-]+)="([^"]*)"/g, (_, name, value) => {
        assert.ok(ATTRS.has(name), `${attack} → attribute ${name} in ${html}`);
        if (name === 'href' || name === 'src') assert.match(value, /^(https:\/\/|\/(?!\/)|#)/, `${attack} → ${name}=${value}`);
        return '';
      });
      assert.equal(rest.trim(), '', `${attack} → stray attribute text ${rest} in ${html}`);
    }
  }
  assert.equal(linkUrl('javascript:alert(1)'), null);
  assert.equal(linkUrl('/posts/x'), '/posts/x');
  assert.equal(linkUrl('#anchor'), '#anchor');
  assert.equal(linkUrl('//evil.example'), null);
  assert.equal(linkUrl('ipfs://bafkreigw36dmko6bpsp355lk5k6u35zbhu3egeaxkm42wfczvfrbcimsnq'),
    'https://ipfs.filebase.io/ipfs/bafkreigw36dmko6bpsp355lk5k6u35zbhu3egeaxkm42wfczvfrbcimsnq');
});

test('long lines of whitespace parse in linear time', () => {
  for (const line of ['# a' + ' '.repeat(100000) + 'x', '#' + ' '.repeat(100000) + '#x', '```' + ' '.repeat(100000) + 'x']) {
    const start = performance.now();
    renderMarkdown(line);
    assert.ok(performance.now() - start < 500, `${JSON.stringify(line.slice(0, 8))}… took ${performance.now() - start} ms`);
  }
  assert.match(renderMarkdown('### Title ##   '), /<h3 id="title">Title<\/h3>/);
  assert.match(renderMarkdown('# C# #'), /<h2[^>]*>C#<\/h2>/);
  assert.match(renderMarkdown('# #'), /<h2[^>]*><\/h2>/);
  assert.match(renderMarkdown('```js   \nx\n```'), /<pre><code[^>]*>x<\/code><\/pre>/);
});

test('links, images and bare URLs', () => {
  assert.equal(renderMarkdown('[ok](https://a.example/?a=1&b=2)'), '<p><a href="https://a.example/?a=1&amp;b=2" rel="nofollow ugc noopener">ok</a></p>');
  assert.match(renderMarkdown('![alt](ipfs://bafkreigw36dmko6bpsp355lk5k6u35zbhu3egeaxkm42wfczvfrbcimsnq)'),
    /<img src="https:\/\/ipfs\.filebase\.io\/ipfs\/bafkrei[^"]+" alt="alt" loading="lazy" referrerpolicy="no-referrer">/);
  assert.match(renderMarkdown('[![i](https://i.example/a.png)](https://l.example)'), /<a href="https:\/\/l\.example\/"[^>]*><img src="https:\/\/i\.example\/a\.png"/);
  assert.match(renderMarkdown('![`a<b` and $x$ and \\_](https://i.example/a.png)'), /alt="a&lt;b and x and _"/);
  assert.match(renderMarkdown('see https://a.example/path_with_under_scores.'), /<a href="https:\/\/a\.example\/path_with_under_scores"[^>]*>https:\/\/a\.example\/path_with_under_scores<\/a>\./);
});

test('TeX math becomes MathML', () => {
  assert.equal(texToMathml('y_0'), '<math><msub><mi>y</mi><mn>0</mn></msub></math>');
  assert.equal(texToMathml('\\frac{a}{b}', true), '<math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>');
  assert.equal(texToMathml('\\sqrt[d]{n}'), '<math><mroot><mi>n</mi><mi>d</mi></mroot></math>');
  assert.equal(texToMathml('x^2_i'), '<math><msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup></math>');
  assert.match(texToMathml('\\left( \\frac{1}{2} \\right)'), /^<math><mrow><mo>\(<\/mo><mfrac>.*<mo>\)<\/mo><\/mrow><\/math>$/);
  assert.match(texToMathml('\\alpha \\le \\beta'), /<mi>α<\/mi><mo>≤<\/mo><mi>β<\/mi>/);
  assert.match(texToMathml('a < b'), /<mo>&lt;<\/mo>/);
  for (const bad of ['\\unknown', '{', '}', 'x_', '\\frac{a}', '\\right)', 'a_b_c', '']) assert.equal(texToMathml(bad), null, bad);
  assert.equal(texToMathml('{'.repeat(40) + 'x' + '}'.repeat(40)), null, 'nesting is bounded');
  // A script after a closing bracket takes the whole group as its base, or browsers drop the bracket.
  assert.equal(texToMathml('(k+1)^2'), '<math><msup><mrow><mo>(</mo><mi>k</mi><mo>+</mo><mn>1</mn><mo>)</mo></mrow><mn>2</mn></msup></math>');
  assert.equal(texToMathml('f(x)_i'), '<math><mrow><mi>f</mi><msub><mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow><mi>i</mi></msub></mrow></math>');
  assert.match(texToMathml('((a)^2)^3'), /^<math><msup><mrow><mo>\(<\/mo><msup><mrow><mo>\(<\/mo><mi>a<\/mi><mo>\)<\/mo><\/mrow>/);
  assert.equal(texToMathml('x)^2'), '<math><mrow><mi>x</mi><msup><mo>)</mo><mn>2</mn></msup></mrow></math>', 'an unmatched bracket stays as it was');
  assert.equal(texToMathml('(a+b)'), '<math><mrow><mo>(</mo><mi>a</mi><mo>+</mo><mi>b</mi><mo>)</mo></mrow></math>', 'no script, no extra group');

  const html = renderMarkdown('length-$k$ and $$\\frac{y-y_0}{y_1-y_0}$$ cost $5 and $10, \\$ sign, `$x$`');
  assert.match(html, /length-<math><mi>k<\/mi><\/math>/);
  assert.match(html, /<math display="block"><mfrac>/);
  assert.match(html, /cost \$5 and \$10, \$ sign, <code>\$x\$<\/code>/);
  assert.match(renderMarkdown('$\\nope$'), /<code>\$\\nope\$<\/code>/);
  assert.match(renderMarkdown('$$\nE = mc^2\n$$'), /^<p><math display="block">/);
});

test('excerpt strips markup', () => {
  assert.equal(excerpt('# Hi *there*\n\n[link](https://x) and snake_case ![i](y)'), 'Hi there link and snake_case');
  assert.equal(excerpt('word '.repeat(100), 20), 'word word word word…');
});

// --- the index ---------------------------------------------------------------------------------
function memorySql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...params) {
      const statement = db.prepare(query);
      const args = params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
      if (/^\s*(SELECT|WITH)/i.test(query)) {
        const rows = statement.all(...args);
        return { toArray: () => rows };
      }
      statement.run(...args);
      return { toArray: () => [] };
    },
  };
}

const CONTRACT = '0x' + 'c0'.repeat(20);
const ALICE = '0x' + 'a1'.repeat(20);
const BOB = '0x' + 'b0'.repeat(20);
const PUBLISHER = '0x' + '9b'.repeat(20);
const TOKEN = '0x' + pad32('a11ce');
const TOKEN2 = '0x' + pad32('b0b');
const topicAddr = (a) => '0x' + pad32(a.slice(2));
const word = (v) => pad32(BigInt(v).toString(16));

// A fake chain + blob sources. `chain.logs` are served by eth_getLogs, `chain.owners` answer the
// ownerOf/resolve multicall, and `blobs` (versioned hash → bytes) are served by Blobscan unless
// `blobscanDown`, in which case the beacon API has them.
function fakeWorld() {
  const world = {
    head: 1000, logs: [], owners: {}, names: {}, blobs: {}, blobscanDown: false, beaconDown: false, calls: [],
    timestamp: (block) => 1_700_000_000 + block * 12,
  };
  world.rpcDown = new Set(); // hosts that fail
  world.extraLogs = {}; // host → logs only that endpoint returns (a lying RPC)
  world.extraHead = {}; // host → blocks that endpoint adds to the head
  world.fetch = async (url, init) => {
    world.calls.push(url);
    if (init?.method === 'POST' && /^https:\/\/(rpc\.test|eth\.drpc\.org|eth-mainnet\.public\.blastapi\.io|eth-pokt\.nodies\.app|rpc\.mevblocker\.io|eth\.rpc\.blxrbdn\.com|ethereum-rpc\.publicnode\.com)/.test(url)) {
      const host = new URL(url).host;
      if (world.rpcDown.has(host)) return new Response('down', { status: 503 });
      const { method, params } = JSON.parse(init.body);
      const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (method === 'eth_blockNumber') return ok('0x' + (world.head + (world.extraHead[host] || 0)).toString(16));
      if (method === 'eth_getBlockByNumber') return ok({ timestamp: '0x' + world.timestamp(Number(params[0])).toString(16) });
      if (method === 'eth_getLogs') {
        const [{ fromBlock, toBlock }] = params;
        const all = [...world.logs, ...(world.extraLogs[host] || [])];
        return ok(all.filter((l) => Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock)));
      }
      if (method === 'eth_call') return ok(answerMulticall(params[0].data, world));
      throw new Error('unexpected RPC ' + method);
    }
    const blobscan = /^https:\/\/blobscan\.test\/blobs\/(0x[0-9a-f]+)\/data$/.exec(url);
    if (blobscan) {
      const blob = (world.blobscanBlobs || {})[blobscan[1]] || world.blobs[blobscan[1]];
      if (world.blobscanDown || !blob) return new Response('nope', { status: world.blobscanDown ? 503 : 404 });
      return new Response(JSON.stringify('0x' + toHex(blob)));
    }
    const beacon = /^https:\/\/beacon\.test\/eth\/v1\/beacon\/blobs\/(\d+)\?versioned_hashes=(0x[0-9a-f]+)$/.exec(url);
    if (beacon) {
      const blob = (world.beaconBlobs || {})[beacon[2]] || world.blobs[beacon[2]];
      if (world.beaconDown || !blob) return new Response(JSON.stringify({ data: [] }));
      world.beaconSlot = Number(beacon[1]);
      return new Response(JSON.stringify({ data: ['0x' + toHex(blob)] }));
    }
    throw new Error('unexpected fetch ' + url);
  };
  return world;
}

// Decode aggregate3 calls and answer getFullName / resolve / ownerOf from the world.
function answerMulticall(data, world) {
  const hex = data.slice(10);
  const at = (i) => Number(BigInt('0x' + hex.slice(i * 2, i * 2 + 64)));
  const count = at(32);
  const results = [];
  for (let i = 0; i < count; i++) {
    const element = 64 + at(64 + i * 32);
    const callLength = at(element + 96);
    const call = hex.slice((element + 128) * 2, (element + 128 + callLength) * 2);
    const sel = call.slice(0, 8);
    const token = '0x' + call.slice(8, 72);
    const owner = world.owners[token];
    if (sel === '465411c1') {
      const name = utf8(world.names[token] || '');
      let padded = toHex(name);
      while (padded.length % 64) padded += '0';
      results.push(word(32) + word(name.length) + padded);
    } else if (sel === '4f896d4f') {
      results.push(pad32(owner ? owner.slice(2) : '0'));
    } else if (sel === '6352211e') {
      results.push(pad32((owner || '0x0').slice(2)));
    } else {
      throw new Error('unexpected call ' + sel);
    }
  }
  // (bool, bytes)[]: offsets then [success, 0x40, length, data] per element.
  const elements = results.map((r) => word(1) + word(64) + word(r.length / 2) + r);
  let cursor = elements.length * 32;
  const offsets = elements.map((e) => { const o = word(cursor); cursor += e.length / 2; return o; });
  return '0x' + word(32) + word(elements.length) + offsets.join('') + elements.join('');
}

const logOf = (block, idx, topics, data = '0x') => ({
  address: CONTRACT, blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16),
  transactionHash: '0x' + pad32(`${block}${idx}`), topics, data, removed: false,
});
// PostAuthorized names the blob the author built for the post. Tests say which blob that was when
// they publish it: published(…, hash, vh) points the post's authorizations at vh, then emits
// BlobPublished(vh).
const authLogs = new Map();
const authorized = (block, idx, token, hash, author, publisher = PUBLISHER, fee = 10n ** 13n, vh = '0x01' + hash.slice(4)) => {
  const log = logOf(block, idx, [T_AUTHORIZED, token, hash, topicAddr(author)], '0x' + vh.slice(2) + pad32(publisher.slice(2)) + word(fee));
  authLogs.set(hash, [...(authLogs.get(hash) || []), log]);
  return log;
};
const published = (block, idx, hash, vh, publisher = PUBLISHER) => {
  for (const log of authLogs.get(hash) || []) log.data = '0x' + vh.slice(2) + log.data.slice(66);
  return logOf(block, idx, [T_BLOB_PUBLISHED, vh, topicAddr(publisher)], '0x' + word(0));
};
const removed = (block, idx, token, hash, author) => logOf(block, idx, [T_REMOVED, token, hash, topicAddr(author)]);
const versionedHash = (n) => '0x01' + pad32(n.toString(16)).slice(2); // for blobs that are never fetched
// A blob's real versioned hash (the index checks every fetched blob against it), and serving it.
const serve = (world, blob) => { const vh = blobVersionedHash(blob); world.blobs[vh] = blob; return vh; };

function makeStore(world, env = {}) {
  let now = world.timestamp(world.head);
  const store = new PostStore(memorySql(), {
    POSTS_CONTRACT: CONTRACT,
    POSTS_FROM_BLOCK: '100',
    RPC_URL: 'https://rpc.test/',
    BLOB_SOURCES: JSON.stringify({ blobscan: 'https://blobscan.test', beacons: ['https://beacon.test'] }),
    ...env,
  }, { fetchImpl: world.fetch, now: () => now });
  store.advance = (seconds) => { now += seconds; };
  return store;
}

function postBytes(title, body = 'Body of ' + title) {
  const bytes = encodePost({ title, body });
  return { bytes, hash: postHash(bytes) };
}

test('uploads of an authorized hash skip the limits, so junk uploads can delay posting but not block it', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  for (let i = 0; i < 20; i++) store.upload(postBytes('junk' + i).bytes, '9.9.9.9');
  const real = postBytes('Real one');
  assert.equal(store.upload(real.bytes, '9.9.9.9').status, 429, 'the address is rate-limited');
  world.logs.push(authorized(500, 0, TOKEN, real.hash, ALICE));
  await store.sync();
  assert.deepEqual(store.upload(real.bytes, '9.9.9.9'), { hash: real.hash }, 'but an authorized post always goes in');
});

test('IPv6 clients are rate-limited per /64', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  const store = makeStore(fakeWorld());
  for (let i = 0; i < 20; i++) assert.ok(store.upload(postBytes('v6-' + i).bytes, `2001:db8:1:2::${i.toString(16)}`).hash);
  assert.equal(store.upload(postBytes('v6-x').bytes, '2001:db8:1:2:ffff::9').status, 429);
});

test('upload validates, deduplicates and rate-limits', async () => {
  const store = makeStore(fakeWorld());
  const a = postBytes('A');
  assert.deepEqual(store.upload(a.bytes, '1.1.1.1'), { hash: a.hash });
  assert.deepEqual(store.upload(a.bytes, '1.1.1.1'), { hash: a.hash }, 'same bytes, same hash');
  assert.equal(store.upload(utf8('{"v":2}'), '1.1.1.1').status, 400);
  assert.equal(store.upload(new Uint8Array(MAX_POST_BYTES + 1), '1.1.1.1').status, 413);
  for (let i = 0; i < 19; i++) assert.ok(store.upload(postBytes('p' + i).bytes, '2.2.2.2').hash);
  assert.ok(store.upload(postBytes('p19').bytes, '2.2.2.2').hash);
  assert.equal(store.upload(postBytes('p20').bytes, '2.2.2.2').status, 429);
  assert.ok(store.upload(postBytes('p20').bytes, '3.3.3.3').hash, 'other clients are unaffected');
  assert.deepEqual(parsePost(store.raw(a.hash)), parsePost(a.bytes));
});

test('an authorized upload shows while pending, then drops out unless a blob carries it', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Pending post');
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE));
  world.owners[TOKEN] = ALICE;
  world.names[TOKEN] = 'alice.gwei';
  const result = await store.sync();
  assert.equal(result.cursor, 998, 'indexes up to head - 2');
  assert.equal(result.events, 1);

  let posts = store.forToken(TOKEN, ALICE);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Pending post');
  assert.equal(posts[0].onchain, null);
  assert.deepEqual(store.forToken(TOKEN, BOB), [], 'only the current owner’s posts show');

  store.advance(2 * 86400);
  posts = store.forToken(TOKEN, ALICE);
  assert.deepEqual(posts, [], 'unpublished posts drop out after a day');
});

test('a blob that carries the post confirms it, from any publisher', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Confirmed');
  const vh = serve(world, encodeBlob([a.bytes]));
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(510, 3, a.hash, vh, BOB));
  const result = await store.sync();
  assert.equal(result.blobs, 1);

  const [post] = store.forToken(TOKEN, ALICE);
  assert.equal(post.onchain.blob, vh);
  assert.equal(post.onchain.publisher, BOB);
  assert.equal(post.onchain.block, 510);
  store.advance(30 * 86400);
  assert.equal(store.forToken(TOKEN, ALICE).length, 1, 'confirmed posts stay');
  assert.equal(toHex(store.blobBytes(vh)), toHex(world.blobs[vh]), 'the blob is kept');

  const detail = store.detail(a.hash);
  assert.equal(detail.title, 'Confirmed');
  assert.equal(detail.authorizations[0].author, ALICE);
  assert.equal(detail.authorizations[0].fee, '10000000000000');
});

test('a PostPublished claim for a blob that lacks the post is ignored', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Real');
  const other = postBytes('Other');
  const vh = serve(world, encodeBlob([other.bytes]));
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(510, 0, a.hash, vh));
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain, null);
  assert.equal(store.raw(other.hash), null, 'entries nobody claimed are not stored');
  assert.equal(store.blobBytes(vh), null, 'a blob none of whose claims hold is not kept');
  const calls = world.calls.length;
  store.advance(7200);
  await store.sync();
  assert.equal(world.calls.slice(calls).filter((u) => u.includes(vh)).length, 0, 'and it is not fetched again');
});

test('a self-published post needs no upload: its bytes come from the blob', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Only in a blob', 'from **somewhere** else');
  const vh = serve(world, encodeBlob([postBytes('unrelated').bytes, a.bytes]));
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE, ALICE, 0n), published(500, 1, a.hash, vh, ALICE));
  await store.sync();
  const [post] = store.forToken(TOKEN, ALICE);
  assert.equal(post.title, 'Only in a blob');
  assert.equal(store.postForToken(TOKEN, ALICE, a.hash.slice(2, 14)).body, 'from **somewhere** else');
});

test('blobs come from the beacon API when Blobscan is down, and retries back off', async () => {
  const world = fakeWorld();
  world.blobscanDown = true;
  const store = makeStore(world);
  const a = postBytes('Beacon');
  const vh = serve(world, encodeBlob([a.bytes]));
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(600, 0, a.hash, vh));
  await store.sync();
  assert.ok(store.forToken(TOKEN, ALICE)[0].onchain);
  assert.equal(world.beaconSlot, Math.floor((world.timestamp(600) - 1606824023) / 12));

  const b = postBytes('Unavailable');
  const blobB = encodeBlob([b.bytes]);
  const vh2 = blobVersionedHash(blobB);
  world.beaconDown = true;
  world.head = 1100;
  world.logs.push(authorized(1000, 0, TOKEN, b.hash, ALICE), published(1001, 0, b.hash, vh2));
  store.upload(b.bytes, 'ip');
  await store.sync();
  const calls = world.calls.length;
  store.advance(30);
  await store.sync();
  assert.equal(world.calls.filter((u, i) => i >= calls && u.includes(vh2)).length, 0, 'no refetch before the backoff');
  world.blobs[vh2] = blobB;
  world.blobscanDown = false;
  store.advance(120);
  await store.sync();
  assert.ok(store.forToken(TOKEN, ALICE).find((p) => p.hash === b.hash).onchain, 'fetched once the backoff passes');
});

test('blobs no owner authorized are never fetched', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const vh = serve(world, encodeBlob([postBytes('spam').bytes]));
  world.logs.push(published(500, 0, postBytes('spam').hash, vh));
  await store.sync();
  assert.equal(world.calls.filter((u) => u.includes(vh)).length, 0);
  assert.equal(store.blobBytes(vh), null);
});

test('removal hides a post until its author authorizes it again', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Removable');
  const vh = serve(world, encodeBlob([a.bytes]));
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(500, 1, a.hash, vh), removed(600, 0, TOKEN, a.hash, ALICE));
  await store.sync();
  assert.deepEqual(store.forToken(TOKEN, ALICE), []);

  world.head = 1100;
  world.logs.push(authorized(1050, 0, TOKEN, a.hash, ALICE));
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE).length, 1);

  // A removal by someone else (a later owner, say) doesn't hide the author's post.
  world.head = 1200;
  world.logs.push(removed(1150, 0, TOKEN, a.hash, BOB));
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE).length, 1);
});

test('recent lists posts across names and drops names whose owner changed', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Alice post', 'a');
  const b = postBytes('Bob post', 'b');
  const vh = serve(world, encodeBlob([a.bytes, b.bytes]));
  world.owners = { [TOKEN]: ALICE, [TOKEN2]: BOB };
  world.names = { [TOKEN]: 'alice.gwei', [TOKEN2]: 'bob.gwei' };
  world.logs.push(
    authorized(500, 0, TOKEN, a.hash, ALICE), authorized(501, 0, TOKEN2, b.hash, BOB),
    published(502, 0, a.hash, vh), published(502, 1, b.hash, vh),
  );
  await store.sync();
  let recent = await store.recent(10);
  assert.deepEqual(recent.map((p) => [p.name, p.title]), [['bob.gwei', 'Bob post'], ['alice.gwei', 'Alice post']]);

  world.owners[TOKEN2] = ALICE; // bob.gwei was sold
  store.advance(120);
  recent = await store.recent(10);
  assert.deepEqual(recent.map((p) => p.name), ['alice.gwei']);
});

test('sync resumes from its cursor and pages long ranges', async () => {
  const world = fakeWorld();
  world.head = 20_000;
  const store = makeStore(world);
  const first = await store.sync();
  assert.equal(first.cursor, 99 + 5 * 2000, 'five 2000-block pages per run');
  const second = await store.sync();
  assert.equal(second.cursor, 99 + 10 * 2000 > 19_998 ? 19_998 : 99 + 10 * 2000);
  const ranges = world.calls.filter((u) => u.startsWith('https://rpc.test')).length;
  assert.ok(ranges >= 12);
});

test('without a contract configured, sync does nothing', async () => {
  const world = fakeWorld();
  const store = makeStore(world, { POSTS_CONTRACT: '' });
  assert.deepEqual(await store.sync(), { skipped: 'POSTS_CONTRACT is not set' });
  assert.equal(world.calls.length, 0);
});

test('uploads nobody authorizes are pruned after a day', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const kept = postBytes('Kept');
  const dropped = postBytes('Dropped');
  store.upload(kept.bytes, 'ip');
  store.upload(dropped.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, kept.hash, ALICE));
  store.advance(86400 + 60);
  await store.sync();
  assert.ok(store.raw(kept.hash));
  assert.equal(store.raw(dropped.hash), null);
});

// --- the review's attack cases ------------------------------------------------------------------
test('a claimed blob stuffed with junk only records the claimed entries', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const real = postBytes('Real');
  const junk = Array.from({ length: 500 }, (_, i) => postBytes('j' + i, '').bytes);
  const vh = serve(world, encodeBlob([...junk, real.bytes]));
  world.logs.push(authorized(500, 0, TOKEN, real.hash, ALICE, ALICE, 0n), published(501, 0, real.hash, vh, BOB));
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain.blob, vh);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM carried')[0].n, 1);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content')[0].n, 1);
});

test('a source serving bytes that are not the blob is caught by the versioned hash', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Checked');
  const vh = serve(world, encodeBlob([a.bytes]));
  world.blobscanBlobs = { [vh]: encodeBlob([a.bytes, postBytes('smuggled').bytes]) }; // carries the post, but isn't the blob
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(501, 0, a.hash, vh));
  const error = console.error;
  const logged = [];
  console.error = (line) => logged.push(line);
  try { await store.sync(); } finally { console.error = error; }
  assert.match(logged.join(), /posts_blob_mismatch/);
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain.blob, vh, 'the beacon API had the real blob');
  assert.equal(toHex(store.blobBytes(vh)), toHex(world.blobs[vh]));

  const b = postBytes('Both sources wrong');
  const vhB = serve(world, encodeBlob([b.bytes]));
  const wrong = encodeBlob([b.bytes, postBytes('x').bytes]);
  world.blobscanBlobs = { [vhB]: wrong };
  world.beaconBlobs = { [vhB]: wrong };
  store.upload(b.bytes, 'ip');
  world.head = 1100;
  world.logs.push(authorized(1000, 0, TOKEN, b.hash, ALICE), published(1001, 0, b.hash, vhB));
  console.error = () => {};
  try { await store.sync(); } finally { console.error = error; }
  assert.equal(store.forToken(TOKEN, ALICE).find((p) => p.hash === b.hash).onchain, null, 'a wrong blob is not taken');
  world.blobscanBlobs = {};
  world.beaconBlobs = {};
  store.advance(120);
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE).find((p) => p.hash === b.hash).onchain.blob, vhB, 'and it is retried');
});

test('a junk claim on a blob cannot keep a later real claim from being checked', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const real = postBytes('Front-run');
  const junk = postBytes('Junk claim');
  const vh = serve(world, encodeBlob([real.bytes]));
  // Someone publishes the author's blob first, with a junk claim, and the index checks it.
  world.logs.push(authorized(500, 0, TOKEN2, junk.hash, BOB, BOB, 0n, vh), published(501, 0, junk.hash, vh, BOB));
  await store.sync();
  assert.equal(store.rows('SELECT status FROM blob WHERE vh = ?', vh)[0].status, 'rejected');
  // Then the author authorizes the post they built that blob for.
  world.head = 1100;
  world.logs.push(authorized(1000, 0, TOKEN, real.hash, ALICE, PUBLISHER, 10n ** 13n, vh));
  store.advance(60);
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain?.blob, vh, 'the blob is checked again for the new claim');
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain.publisher, BOB);
  // Re-announcing claims that were already checked doesn't refetch anything.
  const calls = world.calls.length;
  world.head = 1200;
  world.logs.push(authorized(1100, 0, TOKEN2, junk.hash, BOB, BOB, 0n, vh), logOf(1101, 0, [T_BLOB_PUBLISHED, vh, topicAddr(PUBLISHER)], '0x' + word(0)));
  store.advance(60);
  await store.sync();
  assert.equal(world.calls.slice(calls).filter((u) => u.includes(vh)).length, 0);
});

test('a later claim on a kept blob is checked from the kept bytes', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('First in the blob');
  const b = postBytes('Second in the blob');
  const vh = serve(world, encodeBlob([a.bytes, b.bytes]));
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE, ALICE, 0n, vh), published(500, 1, a.hash, vh, ALICE));
  await store.sync();
  assert.ok(store.forToken(TOKEN, ALICE).find((p) => p.hash === a.hash).onchain);
  delete world.blobs[vh]; // no source has it any more
  world.head = 1100;
  world.logs.push(authorized(1000, 0, TOKEN2, b.hash, BOB, BOB, 0n, vh));
  store.advance(60);
  await store.sync();
  assert.equal(store.forToken(TOKEN2, BOB)[0].onchain?.blob, vh);
});

test('blobs nobody named for a post are never fetched, however many there are', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Paid post');
  const vh = serve(world, encodeBlob([a.bytes]));
  store.upload(a.bytes, 'ip');
  for (let i = 0; i < 20; i++) {
    const junkVh = versionedHash(100 + i);
    world.blobs[junkVh] = encodeBlob([a.bytes]); // even ones that happen to contain the post
    world.logs.push(logOf(400 + i, 0, [T_BLOB_PUBLISHED, junkVh, topicAddr(BOB)], '0x' + word(0)));
  }
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE, PUBLISHER, 10n ** 13n, vh), logOf(600, 0, [T_BLOB_PUBLISHED, vh, topicAddr(PUBLISHER)], '0x' + word(0)));
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain?.blob, vh);
  assert.equal(world.calls.filter((u) => /0x01[0-9a-f]+/.test(u) && !u.includes(vh)).length, 0, 'no junk blob was fetched');
});

test('the blob the author named counts only once it is published, whoever publishes it', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Named');
  const vh = serve(world, encodeBlob([a.bytes]));
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE, PUBLISHER, 10n ** 13n, vh));
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain, null, 'authorized, not yet published');
  world.head = 1100;
  world.logs.push(logOf(1050, 0, [T_BLOB_PUBLISHED, vh, topicAddr(BOB)], '0x' + word(0))); // someone else delivered it
  store.advance(60);
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain.publisher, BOB);
  assert.equal(store.detail(a.hash).authorizations[0].blob, vh);
});

test('an author’s paid authorizations are listed for refunds, even once the post is off the page', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Paid, never delivered');
  const b = postBytes('Self-published');
  const vh = versionedHash(70);
  store.upload(a.bytes, 'ip');
  world.logs.push(
    authorized(500, 0, TOKEN, a.hash, ALICE, PUBLISHER, 10n ** 13n, vh),
    authorized(510, 0, TOKEN, a.hash, ALICE, PUBLISHER, 10n ** 13n, vh), // topped up: one row
    authorized(520, 0, TOKEN, b.hash, ALICE, ALICE, 0n),
    authorized(530, 0, TOKEN2, a.hash, BOB, PUBLISHER, 1n, vh),
  );
  await store.sync();
  store.advance(2 * 86400);
  assert.equal(store.forToken(TOKEN, ALICE).length, 0, 'past its pending window');
  assert.deepEqual(store.paidBy(ALICE.toUpperCase().replace('0X', '0x')), [
    { hash: a.hash, blob: vh, publisher: PUBLISHER, token: TOKEN, block: 510, title: 'Paid, never delivered' },
  ]);
  assert.equal(store.paidBy(BOB).length, 1);
});

test('a token without a full name never holds up the others', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Named');
  const vh = serve(world, encodeBlob([a.bytes]));
  for (let i = 0; i < 40; i++) {
    const token = '0x' + pad32((0xdead00 + i).toString(16));
    world.owners[token] = BOB;
    world.logs.push(authorized(400, i, token, postBytes('x' + i).hash, BOB, BOB, 0n)); // no names
  }
  world.owners[TOKEN] = ALICE;
  world.names[TOKEN] = 'alice.gwei';
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(501, 0, a.hash, vh));
  await store.sync();
  store.advance(60);
  await store.sync();
  assert.deepEqual((await store.recent(5)).map((p) => p.name), ['alice.gwei']);
});

test('recent shows at most two posts per name', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  world.owners = { [TOKEN]: ALICE, [TOKEN2]: BOB };
  world.names = { [TOKEN]: 'alice.gwei', [TOKEN2]: 'bob.gwei' };
  const posts = Array.from({ length: 5 }, (_, i) => postBytes('alice ' + i, 'b'));
  const bob = postBytes('bob post', 'b');
  const vh = serve(world, encodeBlob([...posts.map((p) => p.bytes), bob.bytes]));
  world.logs.push(authorized(400, 0, TOKEN2, bob.hash, BOB), published(400, 1, bob.hash, vh));
  posts.forEach((p, i) => world.logs.push(authorized(500 + i, 0, TOKEN, p.hash, ALICE), published(500 + i, 1, p.hash, vh)));
  await store.sync();
  assert.deepEqual((await store.recent(10)).map((p) => p.title), ['alice 4', 'alice 3', 'bob post']);
});

test('with the owner’s node down, events need two public endpoints to agree', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  world.rpcDown.add('rpc.test');
  const real = postBytes('Real');
  const fake = postBytes('Injected');
  store.upload(real.bytes, 'ip');
  store.upload(fake.bytes, 'ip');
  world.owners[TOKEN] = ALICE;
  world.logs.push(authorized(500, 0, TOKEN, real.hash, ALICE));
  world.extraLogs['eth.drpc.org'] = [authorized(500, 1, TOKEN, fake.hash, ALICE)];
  world.extraHead['eth.drpc.org'] = 1_000_000; // and a head far in the future
  const result = await store.sync();
  assert.equal(result.cursor, world.head - 2, 'the lower head wins');
  assert.deepEqual(store.forToken(TOKEN, ALICE).map((p) => p.title), ['Real']);
});

test('with the owner’s node down, one public endpoint leaving a log out cannot hide it', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  world.rpcDown.add('rpc.test');
  const a = postBytes('Withdrawn');
  store.upload(a.bytes, 'ip');
  world.owners[TOKEN] = ALICE;
  const auth = authorized(500, 0, TOKEN, a.hash, ALICE);
  const removal = removed(600, 0, TOKEN, a.hash, ALICE);
  world.logs.push(auth, removal);
  // The first public endpoint omits the removal; the next two agree on the full set.
  const hidden = world.fetch;
  world.fetch = async (url, init) => {
    if (init?.method === 'POST' && url.startsWith('https://eth.drpc.org') && JSON.parse(init.body).method === 'eth_getLogs') {
      const res = await hidden(url, init);
      const json = await res.json();
      json.result = json.result.filter((l) => l !== removal && l.topics[0] !== T_REMOVED);
      return new Response(JSON.stringify(json));
    }
    return hidden(url, init);
  };
  store.fetchImpl = world.fetch;
  await store.sync();
  assert.deepEqual(store.forToken(TOKEN, ALICE), [], 'the removal was indexed');
});

test('with the owner’s node down and no two public endpoints agreeing, the range is read again', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  world.rpcDown.add('rpc.test');
  const auth = authorized(500, 0, TOKEN, postBytes('x').hash, ALICE);
  world.logs.push(auth);
  const base = world.fetch;
  let n = 0;
  world.fetch = async (url, init) => {
    if (init?.method === 'POST' && JSON.parse(init.body).method === 'eth_getLogs') {
      const json = await (await base(url, init)).json();
      n += 1; // every endpoint adds a different made-up log, so no two answers match
      json.result.push({ ...auth, logIndex: '0x' + (100 + n).toString(16), transactionHash: '0x' + pad32((1000 + n).toString(16)) });
      return new Response(JSON.stringify(json));
    }
    return base(url, init);
  };
  store.fetchImpl = world.fetch;
  const cursorBefore = store.meta('cursor');
  await assert.rejects(store.sync(), /no two public endpoints agree/);
  assert.equal(store.meta('cursor'), cursorBefore, 'the cursor did not move past the range');
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM auth')[0].n, 0, 'nothing from the disagreeing answers was recorded');
});

test('a removal in the same block as its authorization hides the post at mainnet block heights', async () => {
  const world = fakeWorld();
  world.head = 26_300_100;
  const store = makeStore(world, { POSTS_FROM_BLOCK: '26299999' });
  const a = postBytes('Same block');
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(26_300_000, 3, TOKEN, a.hash, ALICE), removed(26_300_000, 5, TOKEN, a.hash, ALICE));
  await store.sync();
  assert.deepEqual(store.forToken(TOKEN, ALICE), []);
});

test('authorized bytes that never reach a blob expire; blob bytes are kept for thirty days', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const stuck = postBytes('Never published');
  const done = postBytes('Published');
  const vh = serve(world, encodeBlob([done.bytes]));
  store.upload(stuck.bytes, 'ip');
  store.upload(done.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, stuck.hash, ALICE), authorized(500, 1, TOKEN, done.hash, ALICE), published(501, 0, done.hash, vh));
  await store.sync();
  store.advance(3 * 86400 + 60);
  await store.sync();
  assert.equal(store.raw(stuck.hash), null);
  assert.ok(store.raw(done.hash), 'posts carried by a blob stay');
  assert.ok(store.blobBytes(vh));
  store.advance(30 * 86400);
  await store.sync();
  assert.equal(store.blobBytes(vh), null);
  assert.ok(store.raw(done.hash));
  assert.ok(store.forToken(TOKEN, ALICE)[0].onchain, 'the post stays on Ethereum in the index');
});

test('the post list query stays bounded however many posts a name has', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  for (let i = 0; i < 300; i++) {
    const p = postBytes('p' + i);
    store.storeContent(p.hash, p.bytes, parsePost(p.bytes));
    world.logs.push(authorized(500 + Math.floor(i / 100), i % 100, TOKEN, p.hash, ALICE));
  }
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE, 10_000).length, 200);
  assert.equal(store.postForToken(TOKEN, ALICE, postBytes('p7').hash.slice(2, 14)).title, 'p7');
});

test('fuzz: rendered posts only ever contain the renderer’s own tags and attributes', () => {
  const TAGS = new Set(['p', 'a', 'img', 'code', 'pre', 'em', 'strong', 'del', 'br', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr',
    'math', 'mi', 'mo', 'mn', 'mtext', 'mrow', 'msub', 'msup', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mspace']);
  const ATTRS = {
    href: (v) => /^(https?:\/\/|mailto:|\/(?!\/)|#)/.test(v), src: (v) => /^(https:\/\/|data:image\/)/.test(v),
    alt: () => true, loading: (v) => v === 'lazy', referrerpolicy: (v) => v === 'no-referrer', rel: (v) => v === 'nofollow ugc noopener',
    id: (v) => /^[\p{L}\p{N}-]+$/u.test(v), start: (v) => /^\d+$/.test(v), display: (v) => v === 'block',
    mathvariant: (v) => /^[a-z-]+$/.test(v), width: (v) => /^-?[\d.]+em$/.test(v), linethickness: (v) => v === '0', linebreak: (v) => v === 'newline',
  };
  const pieces = ['<', '>', '"', "'", '&', '=', '/', '\\', ':', '*', '**', '_', '~~', '`', '```', '[', ']', '(', ')', '![', '](', '#', '## ', '- ', '1. ',
    '> ', '$', '$$', '{', '}', '^', '\n', '\n\n', ' ', 'javascript:', 'data:text/html,', 'https://a.example/', 'http://b', '//c.example', 'mailto:x@y.z',
    'ipfs://bafkreigw36dmko6bpsp355lk5k6u35zbhu3egeaxkm42wfczvfrbcimsnq', '<script>', '<img src=x onerror=alert(1)>', 'onerror=', '\\frac', '\\text{',
    '\\sqrt[', '\\left(', '\\right)', 'x_', 'y^', '&quot;', '&#39;', '\u0000', ' ', 'é', '🦄', '|', '-->', '<!--', '<math>', '</p>'];
  let seed = 0x5eed;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 3000; round++) {
    const input = Array.from({ length: 1 + rand(40) }, () => pieces[rand(pieces.length)]).join('');
    const html = renderMarkdown(input);
    const text = html.replace(/<\/?([a-z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*>/g, (tag, name, attrs) => {
      assert.ok(TAGS.has(name), `<${name}> from ${JSON.stringify(input)}`);
      for (const [, attr, value] of attrs.matchAll(/\s([a-z-]+)="([^"]*)"/g)) {
        assert.ok(ATTRS[attr]?.(value.replace(/&amp;/g, '&')), `${attr}="${value}" from ${JSON.stringify(input)}`);
      }
      return '';
    });
    assert.doesNotMatch(text, /[<>"]/, `stray markup ${JSON.stringify(text)} from ${JSON.stringify(input)}`);
  }
});

test('a post is dated by the block of the blob that carries it, else by its authorization', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const early = postBytes('Authorized first, published later');
  const late = postBytes('Authorized second, published first');
  const pending = postBytes('Not in a blob yet');
  const vhA = serve(world, encodeBlob([late.bytes])), vhB = serve(world, encodeBlob([early.bytes]));
  for (const p of [early, late, pending]) store.upload(p.bytes, 'ip');
  world.logs.push(
    authorized(500, 0, TOKEN, early.hash, ALICE), authorized(510, 0, TOKEN, late.hash, ALICE),
    published(520, 0, late.hash, vhA), published(600, 0, early.hash, vhB),
    authorized(700, 0, TOKEN, pending.hash, ALICE),
  );
  await store.sync();
  const posts = store.forToken(TOKEN, ALICE);
  assert.deepEqual(posts.map((p) => [p.title, p.time]), [
    ['Not in a blob yet', world.timestamp(700)],
    ['Authorized first, published later', world.timestamp(600)],
    ['Authorized second, published first', world.timestamp(520)],
  ]);
  assert.equal(store.detail(early.hash).time, world.timestamp(600));
  assert.equal(store.detail(pending.hash).time, world.timestamp(700));
});

test('pointing the index at a new contract starts it over', async () => {
  const world = fakeWorld();
  const sql = memorySql();
  const env = { POSTS_CONTRACT: CONTRACT, POSTS_FROM_BLOCK: '100', RPC_URL: 'https://rpc.test/', BLOB_SOURCES: '{"blobscan":"https://blobscan.test","beacons":[]}' };
  const old = new PostStore(sql, env, { fetchImpl: world.fetch, now: () => world.timestamp(world.head) });
  const a = postBytes('From the old contract');
  old.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE));
  await old.sync();
  assert.ok(old.raw(a.hash));
  assert.ok(old.meta('cursor'));

  const same = new PostStore(sql, env, { fetchImpl: world.fetch, now: () => world.timestamp(world.head) });
  assert.ok(same.raw(a.hash), 'a restart keeps the index');

  const fresh = new PostStore(sql, { ...env, POSTS_CONTRACT: '0x' + 'd0'.repeat(20) }, { fetchImpl: world.fetch, now: () => world.timestamp(world.head) });
  assert.equal(fresh.raw(a.hash), null);
  assert.equal(fresh.meta('cursor'), null);
  assert.equal(fresh.rows('SELECT COUNT(*) AS n FROM auth')[0].n, 0);
});
