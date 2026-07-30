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

test('renewal makes the 25-year limit explicit and keeps the field in sync', () => {
  const formStart = html.indexOf("case 'renew':");
  const formEnd = html.indexOf("break;", formStart);
  const renewMarkup = html.slice(formStart, formEnd);
  assert.match(renewMarkup, /max="25"/);
  assert.match(renewMarkup, /Maximum 25 years per renewal transaction\./);

  const helperStart = html.indexOf('function renewYearsValue()');
  const helperEnd = html.indexOf('// Live projection for the renew form', helperStart);
  const input = { value: '100' };
  const context = vm.createContext({
    $(id) {
      assert.equal(id, 'renewYears');
      return input;
    }
  });
  vm.runInContext(
    html.slice(helperStart, helperEnd)
      + '\nglobalThis.renewYearsValue = renewYearsValue;',
    context
  );

  assert.equal(context.renewYearsValue(), 25);
  assert.equal(input.value, '25');
});

test('offers SLOW as a timelocked mainnet send with explicit timing', () => {
  const start = html.indexOf('<!-- Send ETH -->');
  const end = html.indexOf('<!-- Verify Name', start);
  const sendMarkup = html.slice(start, end);

  assert.match(sendMarkup, /id="netSlow"[^>]+setNetwork\('slow'\)[^>]*>Timelocked · SLOW</);
  assert.match(sendMarkup, /Send mode · Ethereum/);
  assert.doesNotMatch(sendMarkup, /netBase|setNetwork\('base'\)|→ Base/);
  assert.match(sendMarkup, /id="slowDelay"/);
  assert.match(sendMarkup, /<option value="86400" selected>1 day<\/option>/);
  assert.match(sendMarkup, /reverse the transfer during this window/i);
  assert.match(sendMarkup, /unclaimed for another 30 days/i);
  assert.match(sendMarkup, /https:\/\/github\.com\/z0r0z\/slow/);
  assert.match(
    sendMarkup,
    /https:\/\/etherscan\.io\/address\/0x000000000000888741B254d37e1b27128AfEAaBC#code/
  );
  assert.doesNotMatch(sendMarkup, /https:\/\/slow\.wei\.domains\//);
  assert.match(sendMarkup, /id="slowTransfers"/);
  assert.doesNotMatch(sendMarkup, /slowSendSummary|updateSlowSendSummary/);
  assert.match(sendMarkup, /loadSlowTransfers\(\)/);

  const netGuardStart = html.indexOf('// The Ethereum send modes');
  const netGuardEnd = html.indexOf('// Point the footer', netGuardStart);
  assert.match(html.slice(netGuardStart, netGuardEnd), /NET\.chainId !== 1/);
});

test('SLOW delay formatting uses readable windows', () => {
  const start = html.indexOf('function formatSlowDelay(delay)');
  const end = html.indexOf('async function doSendEth(event)', start);
  assert.notEqual(start, -1, 'SLOW helpers must exist');
  assert.notEqual(end, -1, 'SLOW helper section must be bounded');

  const context = vm.createContext({});
  vm.runInContext(
    html.slice(start, end)
      + '\nglobalThis.formatSlowDelay = formatSlowDelay;',
    context
  );

  assert.equal(context.formatSlowDelay(3600), '1 hour');
  assert.equal(context.formatSlowDelay(86400), '1 day');
  assert.equal(context.formatSlowDelay(259200), '3 days');
});

test('send flow supports only standard and timelocked Ethereum transfers', () => {
  const start = html.indexOf('async function doSendEth(event)');
  const end = html.indexOf('// Verify name', start);
  const sendSource = html.slice(start, end);

  assert.match(
    sendSource,
    /slow\.depositTo\(ethers\.ZeroAddress,\s*to,\s*0n,\s*delay,\s*'0x',\s*\{ value: amount \}\)/
  );
  assert.match(sendSource, /await waitForTx\(tx\)/);
  assert.doesNotMatch(sendSource, /slowTransferIdFromReceipt|Transfer ID/);
  assert.match(sendSource, /signer\.sendTransaction\(\{ to, value: amount \}\)/);
  assert.doesNotMatch(sendSource, /BASE_PORTAL|depositTransaction|sendNetwork === 'base'/);

  const decisionStart = sendSource.indexOf('let delay = null;');
  const slowDecisionEnd = sendSource.indexOf('} else {', decisionStart);
  assert.doesNotMatch(sendSource.slice(decisionStart, slowDecisionEnd), /confirm\(/);
  assert.match(sendSource.slice(slowDecisionEnd), /confirm\(confirmation\)/);
});

test('SLOW lifecycle exposes reverse, claim, and clawback at the right times', () => {
  const start = html.indexOf('function formatSlowRemaining(seconds)');
  const end = html.indexOf('function normalizeSlowTransfer', start);
  assert.notEqual(start, -1, 'SLOW lifecycle helpers must exist');
  assert.notEqual(end, -1, 'SLOW lifecycle helper section must be bounded');

  const context = vm.createContext({});
  vm.runInContext(
    html.slice(start, end)
      + '\nglobalThis.lifecycleApi = { slowActionsForTransfer, countSlowActionableTransfers, slowCounterpartyAddress, slowTransferStatus };',
    context
  );
  const sender = '0x0000000000000000000000000000000000000001';
  const recipient = '0x0000000000000000000000000000000000000002';
  const transfer = { from: sender, to: recipient, unlockAt: 100n, clawbackAt: 200n };

  assert.deepEqual(Array.from(context.lifecycleApi.slowActionsForTransfer(transfer, sender, 99)), ['reverse']);
  assert.deepEqual(Array.from(context.lifecycleApi.slowActionsForTransfer(transfer, sender, 100)), []);
  assert.deepEqual(Array.from(context.lifecycleApi.slowActionsForTransfer(transfer, sender, 200)), ['clawback']);
  assert.deepEqual(Array.from(context.lifecycleApi.slowActionsForTransfer(transfer, recipient, 99)), []);
  assert.deepEqual(Array.from(context.lifecycleApi.slowActionsForTransfer(transfer, recipient, 100)), ['claim']);

  const selfTransfer = { ...transfer, to: sender };
  assert.deepEqual(
    Array.from(context.lifecycleApi.slowActionsForTransfer(selfTransfer, sender, 200)),
    ['claim', 'clawback']
  );
  assert.equal(
    context.lifecycleApi.countSlowActionableTransfers([transfer, selfTransfer], sender, 200),
    2
  );
  assert.equal(
    context.lifecycleApi.countSlowActionableTransfers([transfer], sender, 150),
    0
  );
  assert.equal(context.lifecycleApi.slowCounterpartyAddress(transfer, sender), recipient);
  assert.equal(context.lifecycleApi.slowCounterpartyAddress(transfer, recipient), sender);
  assert.match(context.lifecycleApi.slowTransferStatus(transfer, sender, 150), /clawback in/);
  assert.equal(context.lifecycleApi.slowTransferStatus(transfer, recipient, 150), 'Ready to claim');
});

test('SLOW transfer decoding derives ETH, unlock, and grace timestamps', () => {
  const start = html.indexOf('function normalizeSlowTransfer');
  const end = html.indexOf('async function loadSlowTransferIds', start);
  const context = vm.createContext({ SLOW_CLAWBACK_GRACE: 2592000 });
  vm.runInContext(
    html.slice(start, end)
      + '\nglobalThis.normalizeSlowTransfer = normalizeSlowTransfer;',
    context
  );

  const delay = 86400n;
  const pending = {
    timestamp: 1000n,
    from: '0x0000000000000000000000000000000000000001',
    to: '0x0000000000000000000000000000000000000002',
    id: delay << 160n,
    amount: 5n
  };
  const transfer = context.normalizeSlowTransfer(42n, pending);
  assert.equal(transfer.transferId, '42');
  assert.equal(transfer.token, 0n);
  assert.equal(transfer.delay, delay);
  assert.equal(transfer.unlockAt, 87400n);
  assert.equal(transfer.clawbackAt, 2679400n);
});

test('raw recipients use their valid primary gwei name', async () => {
  const start = html.indexOf('async function resolveRecipient');
  const end = html.indexOf('let transferPreviewDebounce', start);
  const address = '0x0000000000000000000000000000000000000001';
  const context = vm.createContext({
    ethers: { isAddress: value => value === address },
    loadReverseNames: async () => ({ [address]: 'donnoh.gwei' })
  });
  vm.runInContext(
    html.slice(start, end)
      + '\nglobalThis.resolveRecipient = resolveRecipient;',
    context
  );

  const result = await context.resolveRecipient(address);
  assert.equal(result.address, address);
  assert.equal(result.name, 'donnoh.gwei');
});

test('identity addresses use unique reverse-resolved gwei names', async () => {
  const start = html.indexOf('function addressIdentityDisplay');
  const end = html.indexOf('function formatSlowDate', start);
  const calls = [];
  const context = vm.createContext({
    multicall: async batch => {
      calls.push(...batch);
      return batch.map(call => [
        call.args[0] === '0x0000000000000000000000000000000000000001'
          ? 'tornado.gwei'
          : ''
      ]);
    }
  });
  vm.runInContext(
    html.slice(start, end)
      + '\nglobalThis.identityApi = { addressIdentityDisplay, loadReverseNames };',
    context
  );

  const names = await context.identityApi.loadReverseNames([
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000002'
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].fn, 'reverseResolve');
  assert.equal(calls[0].allowFailure, true);
  assert.equal(names['0x0000000000000000000000000000000000000001'], 'tornado.gwei');
  assert.equal(names['0x0000000000000000000000000000000000000002'], undefined);
  assert.equal(
    context.identityApi.addressIdentityDisplay(
      '0x0000000000000000000000000000000000000001',
      names
    ),
    'tornado.gwei'
  );
  assert.equal(
    context.identityApi.addressIdentityDisplay(
      '0x0000000000000000000000000000000000000002',
      names
    ),
    '0x000000…000002'
  );
});

test('SLOW manager bounds enumeration and completes lifecycle payouts', () => {
  const loadStart = html.indexOf('async function loadSlowTransferIds');
  const loadEnd = html.indexOf('function formatSlowDate', loadStart);
  const loadSource = html.slice(loadStart, loadEnd);
  assert.match(loadSource, /SLOW_TRANSFER_LIMIT/);
  assert.match(loadSource, /direction \+ 'TransferCount'/);
  assert.match(loadSource, /direction \+ 'TransferAt'/);
  assert.doesNotMatch(loadSource, /getInboundTransfers|getOutboundTransfers/);

  const actionStart = html.indexOf('async function doSlowAction');
  const actionEnd = html.indexOf('// Verify name', actionStart);
  const actionSource = html.slice(actionStart, actionEnd);
  assert.match(actionSource, /slow\.claim\(transferId\)/);
  assert.match(actionSource, /encodeFunctionData\('withdrawFrom'/);
  assert.match(actionSource, /slow\.multicall\(\[firstCall, withdrawCall\]\)/);
  assert.doesNotMatch(actionSource, /guardians|isWithdrawalApprovalNeeded|slow\.unlock/);
  assert.match(actionSource, /await loadSlowTransfers\(\)/);
  assert.doesNotMatch(actionSource, /confirm\(/);
});

test('collapsed send control reports actionable SLOW transfers', () => {
  const start = html.indexOf('let slowActionableCount = 0;');
  const end = html.indexOf('let sendPreviewDebounce', start);
  const elements = {
    sendForm: {
      classList: {
        open: false,
        contains() { return this.open; },
        add() { this.open = true; },
        remove() { this.open = false; }
      }
    },
    sendToggle: { textContent: '' }
  };
  let selectedNetwork = null;
  const context = vm.createContext({
    $: id => elements[id],
    NET: { chainId: 1 },
    setNetwork: network => { selectedNetwork = network; }
  });
  vm.runInContext(
    html.slice(start, end)
      + '\nglobalThis.indicatorApi = { setSlowActionableCount, updateSendToggle, toggleSend };',
    context
  );

  context.indicatorApi.setSlowActionableCount(2);
  assert.equal(elements.sendToggle.textContent, 'send eth · 2 pending →');
  context.indicatorApi.toggleSend({ preventDefault() {} });
  assert.equal(selectedNetwork, 'slow');
  assert.equal(elements.sendToggle.textContent, '← hide · 2 pending');
  context.indicatorApi.toggleSend({ preventDefault() {} });
  context.indicatorApi.setSlowActionableCount(0);
  assert.equal(elements.sendToggle.textContent, 'send eth →');
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
