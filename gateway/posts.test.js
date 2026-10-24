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
import { PostStore, T_AUTHORIZED, T_PUBLISHED, T_REMOVED, clientKey } from './posts-store.js';
import { keccak256 } from './web3-auto.js';

const utf8 = (s) => new TextEncoder().encode(s);
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const pad32 = (h) => h.padStart(64, '0');

// --- formats -----------------------------------------------------------------------------------
test('event topics are the keccak of the GnsPosts event signatures', () => {
  const topic = (sig) => '0x' + toHex(keccak256(utf8(sig)));
  assert.equal(T_AUTHORIZED, topic('PostAuthorized(uint256,bytes32,address,address,uint256)'));
  assert.equal(T_PUBLISHED, topic('PostPublished(bytes32,bytes32,address)'));
  assert.equal(T_REMOVED, topic('PostRemoved(uint256,bytes32,address)'));
});

test('parsePost accepts v1 posts and rejects everything else', () => {
  assert.deepEqual(parsePost(encodePost({ title: ' Hello ', body: 'hi', time: 1700000000 })), { title: 'Hello', body: 'hi', time: 1700000000 });
  assert.deepEqual(parsePost(utf8('{"v":1,"title":"t","body":"","extra":[1]}')), { title: 't', body: '', time: null });
  for (const bad of ['', 'nope', '[]', '{"v":2,"title":"t","body":"b"}', '{"v":1,"title":"","body":"b"}',
    '{"v":1,"title":"t"}', '{"v":1,"title":1,"body":"b"}', `{"v":1,"title":"${'x'.repeat(201)}","body":"b"}`]) {
    assert.equal(parsePost(utf8(bad)), null, bad);
  }
  assert.equal(parsePost(Uint8Array.from([0x7b, 0xff, 0x7d])), null, 'invalid UTF-8');
  assert.equal(parsePost(utf8('{"v":1,"title":"t","body":"b","time":-5}')).time, null);
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

test('links, images and bare URLs', () => {
  assert.equal(renderMarkdown('[ok](https://a.example/?a=1&b=2)'), '<p><a href="https://a.example/?a=1&amp;b=2" rel="nofollow ugc noopener">ok</a></p>');
  assert.match(renderMarkdown('![alt](ipfs://bafkreigw36dmko6bpsp355lk5k6u35zbhu3egeaxkm42wfczvfrbcimsnq)'),
    /<img src="https:\/\/ipfs\.filebase\.io\/ipfs\/bafkrei[^"]+" alt="alt" loading="lazy" referrerpolicy="no-referrer">/);
  assert.match(renderMarkdown('[![i](https://i.example/a.png)](https://l.example)'), /<a href="https:\/\/l\.example\/"[^>]*><img src="https:\/\/i\.example\/a\.png"/);
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
  world.fetch = async (url, init) => {
    world.calls.push(url);
    if (url.startsWith('https://rpc.test')) {
      const { method, params } = JSON.parse(init.body);
      const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (method === 'eth_blockNumber') return ok('0x' + world.head.toString(16));
      if (method === 'eth_getBlockByNumber') return ok({ timestamp: '0x' + world.timestamp(Number(params[0])).toString(16) });
      if (method === 'eth_getLogs') {
        const [{ fromBlock, toBlock }] = params;
        return ok(world.logs.filter((l) => Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock)));
      }
      if (method === 'eth_call') return ok(answerMulticall(params[0].data, world));
      throw new Error('unexpected RPC ' + method);
    }
    const blobscan = /^https:\/\/blobscan\.test\/blobs\/(0x[0-9a-f]+)\/data$/.exec(url);
    if (blobscan) {
      const blob = world.blobs[blobscan[1]];
      if (world.blobscanDown || !blob) return new Response('nope', { status: world.blobscanDown ? 503 : 404 });
      return new Response(JSON.stringify('0x' + toHex(blob)));
    }
    const beacon = /^https:\/\/beacon\.test\/eth\/v1\/beacon\/blobs\/(\d+)\?versioned_hashes=(0x[0-9a-f]+)$/.exec(url);
    if (beacon) {
      const blob = world.blobs[beacon[2]];
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
const authorized = (block, idx, token, hash, author, publisher = PUBLISHER, fee = 10n ** 13n) =>
  logOf(block, idx, [T_AUTHORIZED, token, hash, topicAddr(author)], '0x' + pad32(publisher.slice(2)) + word(fee));
const published = (block, idx, hash, vh, publisher = PUBLISHER) => logOf(block, idx, [T_PUBLISHED, hash, vh, topicAddr(publisher)]);
const removed = (block, idx, token, hash, author) => logOf(block, idx, [T_REMOVED, token, hash, topicAddr(author)]);
const versionedHash = (n) => '0x01' + pad32(n.toString(16)).slice(2);

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

function postBytes(title, body = 'Body of ' + title, time = 1_690_000_000) {
  const bytes = encodePost({ title, body, time });
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
  const vh = versionedHash(1);
  world.blobs[vh] = encodeBlob([a.bytes]);
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
  const vh = versionedHash(2);
  world.blobs[vh] = encodeBlob([other.bytes]);
  store.upload(a.bytes, 'ip');
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(510, 0, a.hash, vh));
  await store.sync();
  assert.equal(store.forToken(TOKEN, ALICE)[0].onchain, null);
  assert.deepEqual(store.forToken(TOKEN, ALICE).map((p) => p.title), ['Real'], 'the unauthorized post in the blob never shows');
});

test('a self-published post needs no upload: its bytes come from the blob', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Only in a blob', 'from **somewhere** else');
  const vh = versionedHash(3);
  world.blobs[vh] = encodeBlob([postBytes('unrelated').bytes, a.bytes]);
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
  const vh = versionedHash(4);
  world.blobs[vh] = encodeBlob([a.bytes]);
  world.logs.push(authorized(500, 0, TOKEN, a.hash, ALICE), published(600, 0, a.hash, vh));
  await store.sync();
  assert.ok(store.forToken(TOKEN, ALICE)[0].onchain);
  assert.equal(world.beaconSlot, Math.floor((world.timestamp(600) - 1606824023) / 12));

  const b = postBytes('Unavailable');
  const vh2 = versionedHash(5);
  world.beaconDown = true;
  world.head = 1100;
  world.logs.push(authorized(1000, 0, TOKEN, b.hash, ALICE), published(1001, 0, b.hash, vh2));
  store.upload(b.bytes, 'ip');
  await store.sync();
  const calls = world.calls.length;
  store.advance(30);
  await store.sync();
  assert.equal(world.calls.filter((u, i) => i >= calls && u.includes(vh2)).length, 0, 'no refetch before the backoff');
  world.blobs[vh2] = encodeBlob([b.bytes]);
  world.blobscanDown = false;
  store.advance(120);
  await store.sync();
  assert.ok(store.forToken(TOKEN, ALICE).find((p) => p.hash === b.hash).onchain, 'fetched once the backoff passes');
});

test('blobs no owner authorized are never fetched', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const vh = versionedHash(6);
  world.blobs[vh] = encodeBlob([postBytes('spam').bytes]);
  world.logs.push(published(500, 0, postBytes('spam').hash, vh));
  await store.sync();
  assert.equal(world.calls.filter((u) => u.includes(vh)).length, 0);
  assert.equal(store.blobBytes(vh), null);
});

test('removal hides a post until its author authorizes it again', async () => {
  const world = fakeWorld();
  const store = makeStore(world);
  const a = postBytes('Removable');
  const vh = versionedHash(7);
  world.blobs[vh] = encodeBlob([a.bytes]);
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
  const a = postBytes('Alice post', 'a', 1_700_000_100);
  const b = postBytes('Bob post', 'b', 1_700_000_200);
  const vh = versionedHash(8);
  world.blobs[vh] = encodeBlob([a.bytes, b.bytes]);
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
