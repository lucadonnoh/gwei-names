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
      + '\nglobalThis.lifecycleApi = { slowActionsForTransfer, countSlowActionableTransfers, slowTransferStatus };',
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
