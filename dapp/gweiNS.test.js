const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'gweiNS.html'), 'utf8');

function pendingHarness(pending, committedAt) {
  const storage = new Map([
    ['gwei_pending_commits', JSON.stringify(pending)]
  ]);
  let displayed = null;
  let cleared = false;

  const context = vm.createContext({
    STORAGE_KEY: 'gwei_pending_commits',
    clearPending() { cleared = true; },
    console,
    displayPending(value) { displayed = { ...value }; },
    async getRpc() {},
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      removeItem(key) { storage.delete(key); },
      setItem(key, value) { storage.set(key, value); }
    },
    readContract: {
      async commitments() { return BigInt(committedAt); },
      async isAvailable() { return true; }
    },
    showStatus() {}
  });

  const start = html.indexOf('function savePending(data)');
  const end = html.indexOf('function clearPending()', start);
  assert.notEqual(start, -1, 'pending helpers must exist');
  assert.notEqual(end, -1, 'pending helper section must be bounded');

  vm.runInContext(
    html.slice(start, end) +
      '\nglobalThis.pendingApi = { initPending, loadPending, recoverPendingConfirmation };',
    context
  );

  return {
    api: context.pendingApi,
    wasCleared: () => cleared,
    displayed: () => displayed,
    stored: () => JSON.parse(storage.get('gwei_pending_commits'))
  };
}

test('restores a mined commitment after refresh without a transaction hash', async () => {
  const pending = {
    name: 'nachfq',
    secret: '0xsecret',
    owner: '0xowner',
    commitment: '0xcommitment',
    timestamp: 1783429870,
    confirmed: false
  };
  const committedAt = 1783429919;
  const harness = pendingHarness(pending, committedAt);

  const result = await harness.api.initPending();

  assert.equal('txHash' in result, false);
  assert.equal(result.confirmed, true);
  assert.equal(result.timestamp, committedAt);
  assert.deepEqual(harness.displayed(), { ...pending, confirmed: true, timestamp: committedAt });
  assert.equal(harness.stored().confirmed, true);
  assert.equal(harness.stored().timestamp, committedAt);
  assert.equal(harness.wasCleared(), false);
});

test('keeps an unmined commitment pending when the contract timestamp is zero', async () => {
  const pending = {
    name: 'stillpending',
    secret: '0xsecret',
    owner: '0xowner',
    commitment: '0xcommitment',
    timestamp: 1783429870,
    confirmed: false
  };
  const harness = pendingHarness(pending, 0);

  const result = await harness.api.initPending();

  assert.equal(result.confirmed, false);
  assert.equal(result.timestamp, pending.timestamp);
  assert.equal(harness.wasCleared(), false);
});

test('polling and reveal use the on-chain commitment without requiring txHash', () => {
  const timerStart = html.indexOf('async function updateTimer(timerId)');
  const timerEnd = html.indexOf('// Pause/resume timer', timerStart);
  const timerSource = html.slice(timerStart, timerEnd);
  assert.match(timerSource, /recoverPendingConfirmation\(pending\)/);
  assert.doesNotMatch(timerSource, /pending\.txHash\s*&&\s*elapsed/);

  const revealStart = html.indexOf('async function doReveal()');
  const revealEnd = html.indexOf('function savePending(data)', revealStart);
  const revealSource = html.slice(revealStart, revealEnd);
  assert.doesNotMatch(revealSource, /if \(pending\.confirmed === false\)/);
  assert.match(revealSource, /markPendingConfirmed\(pending, committedAt\)/);
});

test('classic inline scripts remain valid JavaScript', () => {
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const [, attributes, source] of scripts) {
    if (/\bsrc\s*=|\btype\s*=\s*["']module["']/i.test(attributes)) continue;
    assert.doesNotThrow(() => new vm.Script(source));
  }
});

// --- web3:// websites (ERC-6821 contentcontract) ------------------------------

function web3Harness() {
  const context = vm.createContext({ console });
  // The chain tables live with the other config; the parsers live beside encodeContenthash.
  const configStart = html.indexOf('const WEB3_CHAINS =');
  const configEnd = html.indexOf('const ABI = [', configStart);
  const fnStart = html.indexOf('function parseWeb3Url(input)');
  const fnEnd = html.indexOf('async function doSetContent()', fnStart);
  for (const [name, i] of [['config', configStart], ['config end', configEnd], ['parsers', fnStart], ['parsers end', fnEnd]]) {
    assert.notEqual(i, -1, `web3:// ${name} section must exist`);
  }
  vm.runInContext(
    html.slice(configStart, configEnd) +
      html.slice(fnStart, fnEnd) +
      '\nglobalThis.web3Api = { parseWeb3Url, parseContentContract, formatContentContract, formatWeb3Url };',
    context
  );
  return context.web3Api;
}

const ROCK = '0x6485b8b75a8ad382340abe333e1f6ee10e39f818';
// The harness runs in its own vm realm, so objects it returns don't share this realm's Object
// prototype and deepStrictEqual would reject them on that alone. Compare the fields.
const plain = (o) => (o ? { chainId: o.chainId, address: o.address } : o);

test('parseWeb3Url accepts the forms a user is likely to paste', () => {
  const { parseWeb3Url } = web3Harness();
  assert.deepEqual(plain(parseWeb3Url(`web3://${ROCK}:1/`)), { chainId: 1, address: ROCK });
  assert.deepEqual(plain(parseWeb3Url(`web3://${ROCK}`)), { chainId: 1, address: ROCK });
  assert.deepEqual(plain(parseWeb3Url(`web3://${ROCK}:11155111/`)), { chainId: 11155111, address: ROCK });
  assert.deepEqual(plain(parseWeb3Url(`  W3://${ROCK.toUpperCase().replace('0X', '0x')}:1/ `)), { chainId: 1, address: ROCK });
});

test('parseWeb3Url leaves storage-network input alone', () => {
  const { parseWeb3Url } = web3Harness();
  for (const input of ['bafybeiabc', 'Qmfoo', 'ipfs://bafy', 'ipns://k51abc', 'bzz://' + 'a'.repeat(64), '0xe301aa', '']) {
    assert.equal(parseWeb3Url(input), null, `expected null for ${input}`);
  }
});

test('parseWeb3Url rejects what cannot be stored, with a readable message', () => {
  const { parseWeb3Url } = web3Harness();
  assert.throws(() => parseWeb3Url(`web3://${ROCK}:1/page`), /path cannot be stored/);
  assert.throws(() => parseWeb3Url(`web3://${ROCK}:8453/`), /Unsupported chain 8453/);
  assert.throws(() => parseWeb3Url('web3://0xnothex:1/'), /40 hex characters/);
});

test('contentcontract records round-trip', () => {
  const { parseWeb3Url, parseContentContract, formatContentContract, formatWeb3Url } = web3Harness();
  const pointer = parseWeb3Url(`web3://${ROCK}:11155111/`);
  assert.equal(formatContentContract(pointer), `sep:${ROCK}`);
  assert.deepEqual(plain(parseContentContract(`sep:${ROCK}`)), plain(pointer));
  assert.deepEqual(plain(parseContentContract(ROCK)), { chainId: 1, address: ROCK }, 'bare address is mainnet');
  assert.equal(formatWeb3Url(pointer), `web3://${ROCK}:11155111/`);
  for (const bad of ['', 'base:' + ROCK, 'eth:0xdead', 'nonsense', null, undefined]) {
    assert.equal(parseContentContract(bad), null, `expected null for ${String(bad)}`);
  }
});

test('Set Website routes web3:// to setText and everything else to setContenthash', () => {
  const start = html.indexOf('async function doSetContent()');
  const end = html.indexOf('async function doSetPrimary()', start);
  const source = html.slice(start, end);
  assert.match(source, /parseWeb3Url\(input\)/);
  assert.match(source, /setText\(currentTokenId, CONTENTCONTRACT, formatContentContract\(pointer\)\)/);
  assert.match(source, /setContenthash\(currentTokenId, contenthash\)/);
  // Clearing must be able to remove either record, not just the contenthash.
  assert.match(source, /setText\(currentTokenId, CONTENTCONTRACT, ''\)/);
  assert.match(source, /setContenthash\(currentTokenId, '0x'\)/);
});

test('Visit via link uses the muted theme color without container opacity', () => {
  const marker = 'Visit via:';
  const at = html.indexOf(marker);
  assert.notEqual(at, -1);
  const snippet = html.slice(html.lastIndexOf('<div', at), html.indexOf('</div>', at));
  assert.match(snippet, /color:var\(--fg-muted\)/);
  assert.match(snippet, /<a [^>]*style="color:inherit;"/);
  assert.doesNotMatch(snippet, /opacity:/);
});

function contenthashHarness() {
  const context = vm.createContext({
    ethers: {
      concat(parts) {
        const arrays = parts.map((part) => typeof part === 'string' ? this.getBytes(part) : part);
        const length = arrays.reduce((sum, part) => sum + part.length, 0);
        const result = new Uint8Array(length);
        let offset = 0;
        for (const part of arrays) {
          result.set(part, offset);
          offset += part.length;
        }
        return result;
      },
      getBytes(hex) {
        const value = hex.startsWith('0x') ? hex.slice(2) : hex;
        if (value.length % 2 || !/^[0-9a-f]*$/i.test(value)) throw new Error('invalid hex');
        return Uint8Array.from(value.match(/../g) || [], (byte) => parseInt(byte, 16));
      },
    },
  });
  const start = html.indexOf('// Base58 alphabet (Bitcoin style)');
  const end = html.indexOf('// Parse `web3://', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.contenthashApi = { encodeContenthash };',
    context,
  );
  return context.contenthashApi;
}

test('Set Website accepts canonical IPNS names and encodes the IPNS namespace', () => {
  const { encodeContenthash } = contenthashHarness();
  const name = 'k2k4r8ng8uzrtqb5ham8kao889m8qezu96z4w3lpinyqghum43veb6n3';
  const expected = 'e50101721220a1dc5d90d7272c0fd9150414f14c80c71de5d243c2f23165e2ddb495cbbcd05f';
  const inlineName = 'k51qzi5uqu5dm7u9ns1a5utzqrufm5p8znj2pwl38amnzmwkdmf52ntlg06m8d';
  const inlineExpected = 'e5010172002408011220f2209793528adf06812d942e80d68f34e37119cd305f9d05d1e20f5cc3b7860d';
  const hex = (bytes) => Buffer.from(bytes).toString('hex');

  assert.equal(hex(encodeContenthash(`ipns://${name}`)), expected);
  assert.equal(hex(encodeContenthash(`/ipns/${name}`)), expected);
  assert.equal(hex(encodeContenthash(name)), expected);
  assert.equal(hex(encodeContenthash(`ipns://${inlineName}`)), inlineExpected);
  assert.equal(hex(encodeContenthash(`0x${expected}`)), expected, 'raw ENSIP-7 bytes remain supported');
});

test('Set Website rejects malformed IPNS names and paths', () => {
  const { encodeContenthash } = contenthashHarness();
  assert.throws(() => encodeContenthash('ipns://example.com'), /CIDv1 libp2p-key/);
  assert.throws(() => encodeContenthash('ipns://k51abc/assets/app.js'), /must not include a path/);
  assert.throws(() => encodeContenthash('ipns://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), /CIDv1 libp2p-key/);
});

test('Set Website copy and placeholder list IPNS', () => {
  assert.match(html, /paste an IPFS CID, an IPNS name, a Swarm bzz:\/\/ reference, or a web3:\/\/ contract URL/);
  assert.match(html, /placeholder="[^"]*ipns:\/\/k51… \(IPNS\)[^"]*"/);
});

test('Clear Website removes a shadowed contentcontract before the active contenthash', async () => {
  const start = html.indexOf('async function doSetContent()');
  const end = html.indexOf('async function doSetPrimary()', start);
  const source = html.slice(start, end);
  const calls = [];
  const context = vm.createContext({
    CONTENTCONTRACT: 'contentcontract',
    contract: {
      setText() {
        calls.push('contentcontract');
        return { hash: '0xcontract' };
      },
      setContenthash() {
        calls.push('contenthash');
        return { hash: '0xcontenthash' };
      }
    },
    currentContentContract: { chainId: 1, address: ROCK },
    currentHasContenthash: true,
    currentTokenId: 1n,
    doCheckName() {},
    event: { target: { disabled: false } },
    handleError(error) { throw error; },
    isProcessing: false,
    showStatus() {},
    async waitForTx() {},
    async wcTransaction(tx) { return tx; },
    $() { return { value: '', classList: { remove() {} } }; }
  });
  vm.runInContext(`${source}\nglobalThis.clearWebsite = doSetContent;`, context);

  await context.clearWebsite();

  assert.deepEqual(calls, ['contentcontract', 'contenthash']);
});
