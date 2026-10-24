const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'gweiNS.html'), 'utf8');

test('integration cards use valid embedded structured data', () => {
  const match = html.match(/<script type="application\/json" id="integrationData">([\s\S]*?)<\/script>/);
  assert.ok(match, 'embedded integration data must exist');
  const integrations = JSON.parse(match[1]);
  const categories = new Set(['community', 'defi', 'developer', 'name management', 'wallet', 'web access']);
  const linkLabels = new Set(['Chrome Web Store', 'Download', 'GitHub', 'npm', 'Website']);
  const names = new Set();
  const ids = new Set();

  assert.ok(integrations.length > 0);
  for (const integration of integrations) {
    assert.equal(typeof integration.id, 'string');
    assert.match(integration.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(integration.id), false, `duplicate integration id: ${integration.id}`);
    ids.add(integration.id);
    assert.equal(typeof integration.name, 'string');
    assert.ok(integration.name);
    assert.equal(names.has(integration.name), false, `duplicate integration: ${integration.name}`);
    names.add(integration.name);
    assert.equal(categories.has(integration.category), true, `unknown category: ${integration.category}`);
    assert.equal(typeof integration.description, 'string');
    assert.match(integration.logo, /^data:image\/(?:png|svg\+xml);base64,/);
    assert.ok(Array.isArray(integration.links) && integration.links.length > 0);
    for (const link of integration.links) {
      assert.equal(linkLabels.has(link.label), true, `unknown link label: ${link.label}`);
      assert.equal(new URL(link.url).protocol, 'https:');
    }
  }
});

test('integration voting uses both verified deployments without an availability flag', () => {
  const start = html.indexOf('const NETWORKS = {');
  const end = html.indexOf('const NET_STORAGE_KEY', start);
  assert.notEqual(start, -1, 'network configuration must exist');
  assert.notEqual(end, -1, 'network configuration must be bounded');

  const context = vm.createContext({});
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.networks = NETWORKS;',
    context
  );

  assert.equal(
    context.networks.ethereum.voting,
    '0xaA2c0f39F0b1a62A8aEB359bCd67874D2D145005'
  );
  assert.equal(context.networks.ethereum.votingDeployBlock, 25838194);
  assert.equal(
    context.networks.sepolia.voting,
    '0xaA2c0f39F0b1a62A8aEB359bCd67874D2D145005'
  );
  assert.equal(context.networks.sepolia.votingDeployBlock, 11562708);
  assert.deepEqual(Array.from(context.networks.sepolia.rpc), [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.gateway.tenderly.co/public',
    'https://ethereum-sepolia-rpc.blockreq.com/v1/rpc/public'
  ]);
  assert.deepEqual(Array.from(context.networks.sepolia.logsRpcs), [
    'https://sepolia.gateway.tenderly.co/public'
  ]);
  assert.doesNotMatch(html, /\bVOTING_ENABLED\b/);
  assert.doesNotMatch(html, /!VOTING_CONTRACT/);
});

test('ens normalization imports only verified published package bytes', () => {
  assert.doesNotMatch(html, /@adraffy\/ens-normalize@1\.11\.0\/\+esm/);
  assert.match(
    html,
    /rel="modulepreload" href="https:\/\/cdn\.jsdelivr\.net\/npm\/@adraffy\/ens-normalize@1\.11\.0\/dist\/index\.mjs" integrity="sha384-wslUpfrOpXCfaW\/3TssDzpULPqQK2igO\/CDwvXIes3zxHdwdj\+kzqbP7dWuA4G13"/
  );
  assert.match(
    html,
    /const SOURCE_SHA384 = 'wslUpfrOpXCfaW\/3TssDzpULPqQK2igO\/CDwvXIes3zxHdwdj\+kzqbP7dWuA4G13';/
  );
});

function votingHarness() {
  const start = html.indexOf('function votingPowerForLabelLength(length)');
  const end = html.indexOf('// --- integration voting: chain index', start);
  assert.notEqual(start, -1, 'voting allocation helpers must exist');
  assert.notEqual(end, -1, 'voting allocation helpers must be bounded');
  const context = vm.createContext({ console, textEncoder: new TextEncoder() });
  vm.runInContext(
    html.slice(start, end) + `
      globalThis.votingApi = {
        votingPowerForLabelLength,
        normalizeVotingAllocations,
        sumVotingAllocations,
        votingAllocationsEqual,
        aggregateVotingAllocations,
        rebaseVotingDraft,
        computeVotingTallies,
        packVotingDraft,
        buildChangedVotingBallots
      };`,
    context
  );
  return context.votingApi;
}

test('integration voting mirrors the byte-priced name schedule', () => {
  const { votingPowerForLabelLength } = votingHarness();
  assert.equal(votingPowerForLabelLength(0), 0);
  assert.equal(votingPowerForLabelLength(1), 1000);
  assert.equal(votingPowerForLabelLength(2), 200);
  assert.equal(votingPowerForLabelLength(3), 100);
  assert.equal(votingPowerForLabelLength(4), 20);
  assert.equal(votingPowerForLabelLength(5), 1);
  assert.equal(votingPowerForLabelLength(255), 1);
  assert.equal(votingPowerForLabelLength(256), 0);
  assert.equal(votingPowerForLabelLength(Number.MAX_SAFE_INTEGER), 0);
  assert.equal(votingPowerForLabelLength(new TextEncoder().encode('🦄').length), 20);
});

test('a fresh canonical baseline rebases a pooled draft without changing its intent', () => {
  const { rebaseVotingDraft, packVotingDraft, buildChangedVotingBallots } = votingHarness();

  const externalChange = rebaseVotingDraft(
    { ambire: 1, snapshot: 1 },
    { rotki: 2 },
    2
  );
  assert.equal(externalChange.preserved, true);
  assert.equal(JSON.stringify(externalChange.allocations), JSON.stringify({ ambire: 1, snapshot: 1 }));

  const lostPower = rebaseVotingDraft(
    { ambire: 2 },
    { rotki: 1 },
    1
  );
  assert.equal(lostPower.preserved, false);
  assert.equal(JSON.stringify(lostPower.allocations), JSON.stringify({ rotki: 1 }));

  const freshNames = [
    { tokenId: '1', power: 1, allocations: { external: 1 } },
    { tokenId: '2', power: 1, allocations: { ambire: 1 } }
  ];
  const packed = packVotingDraft(freshNames, externalChange.allocations);
  const ballots = buildChangedVotingBallots(freshNames, packed, {
    ambire: '0x' + '11'.repeat(32),
    snapshot: '0x' + '22'.repeat(32)
  });
  assert.equal(ballots.length, 1, 'only the externally changed name needs replacement');
  assert.equal(ballots[0].tokenId, 1n);
  assert.deepEqual(Array.from(ballots[0].votes), [1]);
});

function integrationOrderHarness(storedOrder) {
  const integrations = [{ id: 'alpha' }, { id: 'bravo' }, { id: 'charlie' }];
  const storage = new Map();
  const key = 'gwei_voting_order_11155111_0xvote';
  if (storedOrder !== undefined) storage.set(key, JSON.stringify(storedOrder));
  const tallies = { alpha: 0, bravo: 0, charlie: 0 };
  let dirty = false;
  const start = html.indexOf('const INTEGRATION_ORDER_CACHE_VERSION = 1;');
  const end = html.indexOf('function createIntegrationCard(integration)', start);
  assert.notEqual(start, -1, 'integration order cache helpers must exist');
  assert.notEqual(end, -1, 'integration order cache helpers must be bounded');

  const context = vm.createContext({
    CHAIN_ID: 11155111,
    INTEGRATIONS: integrations,
    INTEGRATION_BY_ID: new Map(integrations.map(integration => [integration.id, integration])),
    INTEGRATION_INDEX: new Map(integrations.map((integration, index) => [integration.id, index])),
    VOTING_CONTRACT: '0xVote',
    integrationVotingCardState(id) { return { total: tallies[id] || 0 }; },
    localStorage: {
      getItem(storageKey) { return storage.get(storageKey) ?? null; },
      setItem(storageKey, value) { storage.set(storageKey, value); }
    },
    votingDraftDirty() { return dirty; },
    votingTalliesReady: true
  });
  vm.runInContext(
    html.slice(start, end) + `
      globalThis.integrationOrderApi = {
        integrationOrderCacheKey,
        integrationOrdersEqual,
        normalizeIntegrationOrderIds,
        rankedIntegrationOrderIds,
        restoreIntegrationOrder,
        saveIntegrationOrder,
        settleIntegrationOrder,
        getOrder: () => integrationDisplayOrder
      };`,
    context
  );
  return {
    api: context.integrationOrderApi,
    key,
    storage,
    tallies,
    setDirty(value) { dirty = value; }
  };
}

test('cached integration order is sanitized against the current catalog', () => {
  const harness = integrationOrderHarness({
    version: 1,
    integrationIds: ['bravo', 'removed', 'bravo', 'alpha']
  });

  harness.api.restoreIntegrationOrder();

  assert.equal(harness.api.integrationOrderCacheKey(), harness.key);
  assert.deepEqual(Array.from(harness.api.getOrder()), ['bravo', 'alpha', 'charlie']);
  harness.api.saveIntegrationOrder();
  const saved = JSON.parse(harness.storage.get(harness.key));
  assert.deepEqual(saved, {
    version: 1,
    integrationIds: ['bravo', 'alpha', 'charlie']
  });
  assert.deepEqual(Object.keys(saved).sort(), ['integrationIds', 'version']);
});

test('background voting refresh changes cached order only when settled ranking changes', () => {
  const harness = integrationOrderHarness({
    version: 1,
    integrationIds: ['bravo', 'alpha', 'charlie']
  });
  harness.api.restoreIntegrationOrder();
  harness.tallies.bravo = 2;
  harness.tallies.alpha = 1;

  assert.equal(harness.api.settleIntegrationOrder(), false, 'the same ranking stays still');
  assert.deepEqual(Array.from(harness.api.getOrder()), ['bravo', 'alpha', 'charlie']);

  harness.tallies.alpha = 3;
  harness.setDirty(true);
  assert.equal(harness.api.settleIntegrationOrder(), false, 'an unsaved draft cannot replace global order');
  assert.deepEqual(Array.from(harness.api.getOrder()), ['bravo', 'alpha', 'charlie']);

  harness.setDirty(false);
  assert.equal(harness.api.settleIntegrationOrder(), true, 'a real ranking change is detected');
  assert.deepEqual(Array.from(harness.api.getOrder()), ['alpha', 'bravo', 'charlie']);
});

test('cached order is restored before first render and refreshed after on-chain loading', () => {
  const bootStart = html.indexOf('// Render the page-native voting surface immediately');
  const bootEnd = html.indexOf('// Check for pending commit on page load', bootStart);
  const boot = html.slice(bootStart, bootEnd);
  assert.ok(boot.indexOf('restoreIntegrationOrder();') < boot.indexOf('updateVotingUi();'));

  const loadStart = html.indexOf('async function loadIntegrationVoting()');
  const loadEnd = html.indexOf('function ensureIntegrationVotingLoaded()', loadStart);
  const load = html.slice(loadStart, loadEnd);
  assert.match(load, /const orderChanged = settleIntegrationOrder\(\);/);
  assert.match(load, /saveIntegrationOrder\(\);/);
  assert.match(load, /updateVotingUi\(\{ animate: orderChanged \}\);/);
});

test('voting rebases before signing, applies the receipt immediately, then refreshes in the background', () => {
  assert.match(html, /const VOTING_REFRESH_INTERVAL_MS = 60000;/);
  assert.match(html, /setInterval\(refreshIntegrationVotingInBackground, VOTING_REFRESH_INTERVAL_MS\)/);
  assert.match(html, /Date\.now\(\) - votingLastLoadedAt >= VOTING_FOCUS_REFRESH_AGE_MS/);

  const submitStart = html.indexOf('async function submitVotingDraft()');
  const submitEnd = html.indexOf('const eip6963Providers', submitStart);
  const submit = html.slice(submitStart, submitEnd);
  const refresh = submit.indexOf('await refreshIntegrationVoting({ preserveDraft: true })');
  const pack = submit.indexOf('packVotingDraft(ownedVotingNames, votingDraft)');
  const estimate = submit.indexOf('voting.cast.estimateGas(ballots)');
  const receipt = submit.indexOf('const receipt = await waitForTx(tx)');
  const applyReceipt = submit.indexOf('applyMinedVotingReceipt(receipt, ballots, requestedDraft, connectedAddress)');
  const success = submit.indexOf("showStatus('Votes counted.'");
  assert.ok(refresh >= 0 && refresh < pack && pack < estimate, 'fresh state must be packed before estimation');
  assert.ok(receipt >= 0 && receipt < applyReceipt && applyReceipt < success,
    'the canonical receipt must update state before success is shown');
  assert.doesNotMatch(
    submit.slice(submit.indexOf('\n', receipt), success),
    /\bawait\b/,
    'no RPC refresh may block the mined success state'
  );
  assert.doesNotMatch(submit, /await ensureIntegrationVotingLoaded\(\{ force: true \}\)/);
  assert.match(submit, /refreshIntegrationVotingInBackground\(\);/);
  assert.doesNotMatch(submit, /Number\.MAX_SAFE_INTEGER/, 'the UI must not synthesize missing events');
});

test('voting is discoverable with mobile WalletConnect recovery', () => {
  assert.match(html, /id="votingExplorerLink" href="https:\/\/etherscan\.io\/address\/0xaA2c0f39F0b1a62A8aEB359bCd67874D2D145005"/);
  assert.doesNotMatch(html, /votingExplorerSeparator|id="votingExplorerLink"[^>]*display:none/);
  assert.match(html, /EXPLORER \+ '\/address\/' \+ VOTING_CONTRACT/);
  assert.match(html, /rpcMap: \{ \[CHAIN_ID\]: RPC_ENDPOINTS\[0\] \}/);
  assert.match(html, /if \(deepLink && isMobile && !insideWalletBrowser\)/);
  assert.match(html, /window\.location\.href = deepLink/);
  assert.match(html, /}, 2000\);/);
  assert.equal((html.match(/static\.cloudflareinsights\.com\/beacon\.min\.js/g) || []).length, 1);
});

test('transaction confirmation races wallet waiting against one-second public receipt polling', async () => {
  const start = html.indexOf('const TX_RECEIPT_POLL_MS = 1000;');
  const end = html.indexOf('// Multicall3 for batching RPC calls', start);
  assert.notEqual(start, -1, 'receipt polling interval must exist');
  assert.notEqual(end, -1, 'receipt waiter must be bounded');
  const receipt = { status: 1, transactionHash: '0xtx' };
  let walletWaitCalled = false;
  const context = vm.createContext({
    isWalletConnect: false,
    console,
    async getRpc() {
      return { async getTransactionReceipt(hash) {
        assert.equal(hash, '0xtx');
        return receipt;
      } };
    },
    setTimeout() { return 1; },
    clearTimeout() {}
  });
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.waitForTx = waitForTx;',
    context
  );

  const result = await context.waitForTx({
    hash: '0xtx',
    wait() {
      walletWaitCalled = true;
      return new Promise(() => {});
    }
  });

  assert.equal(result, receipt);
  assert.equal(walletWaitCalled, true, 'both confirmation sources must start');
  assert.match(html.slice(start, end), /Promise\.race\(\[[\s\S]*tx\.wait\(\),[\s\S]*usablePublicPoll/);
});

test('integration tallies require the active top-level current owner and epoch', () => {
  const { computeVotingTallies } = votingHarness();
  const ballots = [
    { tokenId: '1', voter: '0xalice', epoch: '2', integrationIds: ['0xaaa', '0xbbb'], votes: [4, 2] },
    { tokenId: '2', voter: '0xalice', epoch: '1', integrationIds: ['0xaaa'], votes: [100] },
    { tokenId: '3', voter: '0xalice', epoch: '1', integrationIds: ['0xaaa'], votes: [100] },
    { tokenId: '4', voter: '0xalice', epoch: '1', integrationIds: ['0xaaa'], votes: [100] },
    { tokenId: '5', voter: '0xalice', epoch: '1', integrationIds: ['0xunknown'], votes: [100] },
    { tokenId: '6', voter: '0xprevious-owner', epoch: '1', integrationIds: ['0xaaa'], votes: [100] }
  ];
  const records = {
    1: { label: 'ok', parent: '0', expiresAt: 1000, epoch: '2', owner: '0xalice' },
    2: { label: 'old', parent: '0', expiresAt: 499, epoch: '1', owner: '0xalice' },
    3: { label: 'sub', parent: '9', expiresAt: 1000, epoch: '1', owner: '0xalice' },
    4: { label: 'new epoch', parent: '0', expiresAt: 1000, epoch: '2', owner: '0xalice' },
    5: { label: 'unknown', parent: '0', expiresAt: 1000, epoch: '1', owner: '0xalice' },
    6: { label: 'transferred', parent: '0', expiresAt: 1000, epoch: '1', owner: '0xnew-owner' }
  };
  const result = computeVotingTallies(ballots, records, { '0xaaa': 'ambire', '0xbbb': 'snapshot' }, 500);
  assert.equal(result.ambire, 4);
  assert.equal(result.snapshot, 2);
  assert.deepEqual(Object.keys(result).sort(), ['ambire', 'snapshot']);
});

test('integration ballots stop and resume with ownership, expiry, and registration epoch', () => {
  const { computeVotingTallies } = votingHarness();
  const ballot = {
    tokenId: '1',
    voter: '0xalice',
    epoch: '7',
    integrationIds: ['0xaaa'],
    votes: [1]
  };
  const known = { '0xaaa': 'ambire' };
  const tally = (record, now = 1000) =>
    computeVotingTallies([ballot], { 1: record }, known, now).ambire || 0;
  const active = { label: 'alice', parent: '0', expiresAt: 1000, epoch: '7', owner: '0xalice' };

  assert.equal(tally(active), 1, 'the exact expiry timestamp is still active');
  assert.equal(tally({ ...active, owner: '0xbob' }), 0, 'transfer-away stops the old ballot');
  assert.equal(tally(active), 1, 'transfer-back in the same epoch revives it');
  assert.equal(tally({ ...active, expiresAt: 999 }), 0, 'expiry stops it');
  assert.equal(tally({ ...active, expiresAt: 2000 }), 1, 'renewal in the same epoch revives it');
  assert.equal(tally({ ...active, epoch: '8' }), 0, 're-registration cannot revive an old ballot');

  const intermediateClear = { ...ballot, voter: '0xbob', integrationIds: [], votes: [] };
  assert.equal(
    computeVotingTallies([intermediateClear], { 1: active }, known, 1000).ambire || 0,
    0,
    'an intermediate owner replacement remains the latest ballot after transfer-back'
  );
});

function votingLogHarness() {
  const start = html.indexOf('function votingLogPosition(log)');
  const end = html.indexOf('async function loadVotingBallots()', start);
  assert.notEqual(start, -1, 'voting event helpers must exist');
  assert.notEqual(end, -1, 'voting event helpers must be bounded');
  const context = vm.createContext({
    VOTING_IFACE: {
      parseLog(log) {
        if (log.invalid) throw new Error('invalid log');
        return log.parsed;
      }
    }
  });
  vm.runInContext(
    html.slice(start, end) +
      '\nglobalThis.votingLogApi = { votingLogPosition, applyVotingBallotLog };',
    context
  );
  return context.votingLogApi;
}

function votingRangeHarness(votingGetLogs, votingGetBlockLogs = async () => {
  throw new Error('unexpected single-block fallback');
}) {
  const start = html.indexOf('async function scanVotingRanges(');
  const end = html.indexOf('function votingLogPosition(log)', start);
  assert.notEqual(start, -1, 'voting range scanner must exist');
  assert.notEqual(end, -1, 'voting range scanner must be bounded');
  const context = vm.createContext({
    votingGetLogs,
    votingGetBlockLogs,
    VOTING_LOG_MAX_BLOCK_SPAN: 100000,
    VOTING_LOG_RESULT_THRESHOLD: 1000
  });
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.scanVotingRanges = scanVotingRanges;',
    context
  );
  return context.scanVotingRanges;
}

function votingReceiptHarness(statsRpc) {
  const start = html.indexOf('function votingLogMatches(');
  const end = html.indexOf('async function scanVotingRanges(', start);
  assert.notEqual(start, -1, 'voting receipt fallback must exist');
  assert.notEqual(end, -1, 'voting receipt fallback must be bounded');
  const context = vm.createContext({ statsRpc });
  vm.runInContext(
    html.slice(start, end) +
      '\nglobalThis.votingReceiptApi = { votingLogMatches, votingGetBlockLogs };',
    context
  );
  return context.votingReceiptApi;
}

function votingCheckpointHarness(statsRpc) {
  const start = html.indexOf('async function loadVotingHeads(');
  const end = html.indexOf('function votingLogPosition(log)', start);
  assert.notEqual(start, -1, 'voting checkpoint helpers must exist');
  assert.notEqual(end, -1, 'voting checkpoint helpers must be bounded');
  const context = vm.createContext({
    statsRpc,
    VOTING_FINALITY_FALLBACK_BLOCKS: 64
  });
  vm.runInContext(
    html.slice(start, end) + `
      globalThis.votingCheckpointApi = {
        loadVotingHeads,
        votingBlockHash,
        votingCheckpointMatches
      };`,
    context
  );
  return context.votingCheckpointApi;
}

function votingOwnedFastPathHarness({
  logs = [],
  results,
  indexerTimeoutMs = 3000,
  fetchImpl = async () => { throw new Error('unexpected indexer request'); }
}) {
  const start = html.indexOf('async function proveOwnedVotingTokenIds(');
  const end = html.indexOf('async function loadIntegrationVoting()', start);
  assert.notEqual(start, -1, 'fast ownership proof must exist');
  assert.notEqual(end, -1, 'fast ownership proof must be bounded');
  const calls = [];
  const context = vm.createContext({
    CONTRACT: '0xnames',
    VOTING_TRANSFER_TOPIC: '0xtransfer',
    VOTING_INDEXER: 'https://indexer.example',
    VOTING_INDEXER_TIMEOUT_MS: indexerTimeoutMs,
    VOTING_INDEXER_TOTAL_TIMEOUT_MS: 5000,
    VOTING_INDEXER_MAX_PAGES: 20,
    VOTING_INDEXER_MAX_TOKENS: 2000,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    ethers: { zeroPadValue: () => '0xowner-topic' },
    async votingGetLogs(...args) {
      calls.push({ type: 'logs', args });
      return logs;
    },
    async votingMulticallAt(callBatch, blockNumber) {
      calls.push({ type: 'multicall', callBatch, blockNumber });
      return results;
    }
  });
  vm.runInContext(
    html.slice(start, end) + `
      globalThis.votingOwnedFastPathApi = {
        proveOwnedVotingTokenIds,
        tryLoadIndexedOwnedVotingTokenIds,
        tryLoadLoggedOwnedVotingTokenIds
      };`,
    context
  );
  return { ...context.votingOwnedFastPathApi, calls };
}

test('cold ownership discovery accepts a capped response only when balance proves completeness', async () => {
  const address = '0x0000000000000000000000000000000000000abc';
  const tokenTopics = Array.from({ length: 1519 }, (_, index) => {
    const tokenId = index < 1513 ? 1 : index - 1511;
    return { topics: ['0xtransfer', '0xfrom', '0xto', '0x' + tokenId.toString(16)] };
  });
  const complete = votingOwnedFastPathHarness({
    logs: tokenTopics,
    results: [[7n], ...Array.from({ length: 7 }, () => [address])]
  });

  const ids = await complete.tryLoadLoggedOwnedVotingTokenIds(address, 10, 42);

  assert.deepEqual(Array.from(ids), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(complete.calls.filter(call => call.type === 'logs').length, 1);
  const proof = complete.calls.find(call => call.type === 'multicall');
  assert.equal(proof.callBatch[0].fn, 'balanceOf');
  assert.equal(proof.callBatch.length, 8, 'one balance plus seven unique owner checks');
  assert.equal(proof.blockNumber, 42, 'logs and ownership must use the same block');

  const incomplete = votingOwnedFastPathHarness({
    logs: Array.from({ length: 1000 }, () => tokenTopics[0]),
    results: [[2n], [address]]
  });
  assert.equal(
    await incomplete.tryLoadLoggedOwnedVotingTokenIds(address, 10, 42),
    null,
    'a missing current token must force the complete recursive fallback'
  );
  assert.match(html, /cache\.lastBlock === deployBlock - 1[\s\S]*tryLoadLoggedOwnedVotingTokenIds/);
});

test('indexed ownership pages are accepted only after the same onchain balance proof', async () => {
  const address = '0x0000000000000000000000000000000000000abc';
  const urls = [];
  const pages = [
    { items: [{ id: '10' }], next_page_params: { unique_token: 10 } },
    { items: [{ id: '20' }], next_page_params: null }
  ];
  const harness = votingOwnedFastPathHarness({
    results: [[2n], [address], [address]],
    async fetchImpl(url) {
      urls.push(String(url));
      return { ok: true, async json() { return pages.shift(); } };
    }
  });

  const ids = await harness.tryLoadIndexedOwnedVotingTokenIds(address, 77);

  assert.deepEqual(Array.from(ids), ['10', '20']);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /holder_address_hash=0x0000000000000000000000000000000000000abc/);
  assert.match(urls[1], /unique_token=10/);
  const proof = harness.calls.find(call => call.type === 'multicall');
  assert.equal(proof.blockNumber, 77);
  assert.equal(proof.callBatch[0].fn, 'balanceOf');

  const stale = votingOwnedFastPathHarness({
    results: [[3n], [address], [address]],
    async fetchImpl() {
      return { ok: true, async json() {
        return { items: [{ id: '10' }, { id: '20' }], next_page_params: null };
      } };
    }
  });
  assert.equal(
    await stale.tryLoadIndexedOwnedVotingTokenIds(address, 77),
    null,
    'a lagging indexer cannot hide a third currently owned token'
  );
  assert.match(html, /if \(indexedIds !== null\) return indexedIds;/);
});

test('the indexer timeout covers the complete response body', async () => {
  let responseSignal;
  const stalledBody = votingOwnedFastPathHarness({
    results: [],
    indexerTimeoutMs: 10,
    async fetchImpl(_url, { signal }) {
      responseSignal = signal;
      return {
        ok: true,
        json() {
          return new Promise((resolve, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
      };
    }
  });
  const result = await Promise.race([
    stalledBody.tryLoadIndexedOwnedVotingTokenIds('0xabc', 77),
    new Promise(resolve => setTimeout(() => resolve('hung'), 100))
  ]);
  assert.equal(result, null, 'a stalled JSON body must fall back instead of hanging');
  assert.equal(responseSignal.aborted, true);
});

test('historical RPC requests have a bounded per-provider timeout', () => {
  assert.match(html, /const STATS_RPC_TIMEOUT_MS = 8000;/);
  assert.match(html, /const VOTING_INDEXER_TOTAL_TIMEOUT_MS = 5000;/);
  assert.match(html, /const controller = new AbortController\(\);/);
  assert.match(html, /signal: controller\.signal/);
  assert.match(html, /clearTimeout\(timeout\);/);
});

test('voting ownership discovery uses one filtered historical request when supported', async () => {
  const calls = [];
  const scanVotingRanges = votingRangeHarness(async (address, topics, fromBlock, toBlock) => {
    calls.push({ address, topics, fromBlock, toBlock });
    return [{ token: '1' }, { token: '2' }];
  });
  const consumed = [];

  await scanVotingRanges('0xnames', ['0xtransfer'], 10, 25000, log => consumed.push(log.token));

  assert.deepEqual(calls, [{
    address: '0xnames',
    topics: ['0xtransfer'],
    fromBlock: 10,
    toBlock: 25000
  }]);
  assert.deepEqual(consumed, ['1', '2']);
});

test('voting ownership discovery recursively retries capped ranges sequentially', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const scanVotingRanges = votingRangeHarness(async (_address, _topics, fromBlock, toBlock) => {
    calls.push([fromBlock, toBlock]);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (calls.length === 1) throw new Error('range capped');
      return [{ fromBlock, toBlock }];
    } finally {
      active--;
    }
  });
  const consumed = [];

  await scanVotingRanges('0xnames', ['0xtransfer'], 0, 20000, log => consumed.push(log));

  assert.deepEqual(calls, [
    [0, 20000],
    [0, 10000],
    [10001, 20000]
  ]);
  assert.equal(maxActive, 1, 'fallback requests must not create an RPC burst');
  assert.deepEqual(consumed, [
    { fromBlock: 0, toBlock: 10000 },
    { fromBlock: 10001, toBlock: 20000 }
  ]);
});

test('voting ownership discovery keeps bisecting when small ranges are capped', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const scanVotingRanges = votingRangeHarness(async (_address, _topics, fromBlock, toBlock) => {
    calls.push([fromBlock, toBlock]);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (toBlock - fromBlock >= 1000) throw new Error('range capped');
      return [{ fromBlock, toBlock }];
    } finally {
      active--;
    }
  });
  const consumed = [];

  await scanVotingRanges('0xnames', ['0xtransfer'], 0, 5000, log => consumed.push(log));

  assert.ok(calls.some(([from, to]) => to - from < 9000), 'fallback must go below the old fixed chunk');
  assert.equal(maxActive, 1, 'recursive requests must remain sequential');
  assert.equal(consumed[0].fromBlock, 0);
  assert.equal(consumed.at(-1).toBlock, 5000);
  for (let i = 1; i < consumed.length; i++) {
    assert.equal(consumed[i].fromBlock, consumed[i - 1].toBlock + 1);
  }
});

test('voting log discovery splits suspicious successful result caps', async () => {
  const calls = [];
  const scanVotingRanges = votingRangeHarness(async (_address, _topics, fromBlock, toBlock) => {
    calls.push([fromBlock, toBlock]);
    if (fromBlock !== toBlock) return Array.from({ length: 1000 }, () => ({}));
    return [{ blockNumber: fromBlock }];
  });
  const consumed = [];

  await scanVotingRanges('0xvoting', ['0xballot'], 20, 23, log => consumed.push(log));

  assert.deepEqual(consumed, [
    { blockNumber: 20 },
    { blockNumber: 21 },
    { blockNumber: 22 },
    { blockNumber: 23 }
  ]);
  assert.ok(calls.length > consumed.length);
});

test('voting log discovery recovers a dense single block from complete receipts', async () => {
  const completeLogs = Array.from({ length: 1200 }, (_, index) => ({ blockNumber: 42, index }));
  const scanVotingRanges = votingRangeHarness(
    async () => Array.from({ length: 1000 }, () => ({})),
    async (_address, _topics, blockNumber) => {
      assert.equal(blockNumber, 42);
      return completeLogs;
    }
  );
  const consumed = [];

  await scanVotingRanges('0xvoting', ['0xballot'], 42, 42, log => consumed.push(log));

  assert.equal(consumed.length, 1200);
  assert.equal(consumed[0].index, 0);
  assert.equal(consumed.at(-1).index, 1199);
});

test('voting log discovery also uses receipts when a single-block query errors', async () => {
  const scanVotingRanges = votingRangeHarness(
    async () => { throw new Error('response too large'); },
    async () => [{ blockNumber: 42, recovered: true }]
  );
  const consumed = [];
  await scanVotingRanges('0xvoting', ['0xballot'], 42, 42, log => consumed.push(log));
  assert.deepEqual(consumed, [{ blockNumber: 42, recovered: true }]);
});

test('single-block recovery filters complete standard transaction receipts', async () => {
  const calls = [];
  const blockHash = '0xblock';
  const receipts = {
    '0xtx1': {
      blockHash,
      transactionHash: '0xtx1',
      logs: [
        { address: '0xVoting', topics: ['0xBallot'], token: 'keep' },
        { address: '0xOther', topics: ['0xBallot'], token: 'wrong address' }
      ]
    },
    '0xtx2': {
      blockHash,
      transactionHash: '0xtx2',
      logs: [
        { address: '0xVoting', topics: ['0xOther'], token: 'wrong topic' },
        { address: '0xVoting', topics: ['0xBallot'], token: 'also keep' }
      ]
    }
  };
  const { votingGetBlockLogs } = votingReceiptHarness(async (method, params) => {
    calls.push([method, ...Array.from(params)]);
    if (method === 'eth_getBlockByNumber') {
      return { hash: blockHash, transactions: ['0xtx1', '0xtx2'] };
    }
    if (method === 'eth_getBlockReceipts') throw new Error('unsupported');
    if (method === 'eth_getTransactionReceipt') return receipts[params[0]];
    throw new Error(`unexpected method ${method}`);
  });

  const logs = await votingGetBlockLogs('0xVoting', ['0xBallot'], 42);

  assert.deepEqual(Array.from(logs, log => log.token), ['keep', 'also keep']);
  assert.equal(calls.filter(([method]) => method === 'eth_getTransactionReceipt').length, 2);
});

test('voting caches accept only a matching canonical block checkpoint', async () => {
  let canonicalHash = '0xaaa';
  const api = votingCheckpointHarness(async (method, params) => {
    assert.equal(method, 'eth_getBlockByNumber');
    assert.deepEqual(Array.from(params), ['0x2a', false]);
    return { number: '0x2a', hash: canonicalHash };
  });
  const cache = { lastBlock: 42, lastBlockHash: '0xaaa' };

  assert.equal(await api.votingCheckpointMatches(cache, 10), true);
  canonicalHash = '0xbbb';
  assert.equal(await api.votingCheckpointMatches(cache, 10), false);
  assert.equal(await api.votingCheckpointMatches({ lastBlock: 9, lastBlockHash: null }, 10), true);
});

test('voting caches invalidate incomplete historical RPC results', () => {
  assert.match(html, /const VOTING_BALLOT_CACHE_VERSION = 4;/);
  assert.match(html, /const VOTING_OWNED_CACHE_VERSION = 3;/);
  assert.match(html, /stored\?\.version === VOTING_BALLOT_CACHE_VERSION/);
  assert.match(html, /stored\?\.version === VOTING_OWNED_CACHE_VERSION/);
  assert.match(html, /await votingCheckpointMatches\(stored, deployBlock\)/);
  assert.match(html, /cache\.lastBlockHash = await votingBlockHash\(stableHead, deployBlock\)/);
});

test('voting event indexing keeps the latest replacement and accepts an empty clear', () => {
  const { applyVotingBallotLog } = votingLogHarness();
  const ballots = {};
  const log = (blockNumber, logIndex, integrationIds, votes) => ({
    blockNumber,
    logIndex,
    parsed: {
      name: 'BallotCast',
      args: { tokenId: 7n, voter: '0xAlice', epoch: 4n, integrationIds, votes }
    }
  });

  assert.equal(applyVotingBallotLog(ballots, log('0xa', '0x1', ['0xAAA'], [2])), '7');
  assert.equal(ballots['7'].votes[0], 2);
  assert.equal(ballots['7'].integrationIds[0], '0xaaa');

  applyVotingBallotLog(ballots, log('0x9', '0x8', ['0xBBB'], [9]));
  assert.equal(ballots['7'].votes[0], 2, 'an older log cannot replace the ballot');

  applyVotingBallotLog(ballots, log('0xa', '0x2', ['0xBBB'], [5]));
  assert.equal(ballots['7'].votes[0], 5, 'the later log in one block wins');
  assert.equal(ballots['7'].integrationIds[0], '0xbbb');

  applyVotingBallotLog(ballots, log('0xb', '0x0', [], []));
  assert.deepEqual(Array.from(ballots['7'].integrationIds), []);
  assert.deepEqual(Array.from(ballots['7'].votes), []);

  assert.equal(applyVotingBallotLog(ballots, { invalid: true }), undefined);
});

function minedVotingReceiptHarness() {
  const allocationStart = html.indexOf('function votingAllocationsForName(');
  const allocationEnd = html.indexOf('async function loadVotingBallots()', allocationStart);
  const receiptStart = html.indexOf('function applyMinedVotingReceipt(');
  const receiptEnd = html.indexOf('function refreshIntegrationVoting(', receiptStart);
  assert.notEqual(allocationStart, -1, 'ballot allocation helper must exist');
  assert.notEqual(receiptStart, -1, 'mined receipt helper must exist');
  const address = '0x0000000000000000000000000000000000000abc';
  const hashA = '0xaaa';
  const hashB = '0xbbb';
  const counters = { recompute: 0, settle: 0, saveOrder: 0, saveDraft: 0 };
  const normalizedEntries = value => Object.entries(value || {})
    .filter(([, amount]) => Number.isSafeInteger(Number(amount)) && Number(amount) > 0)
    .map(([id, amount]) => [id, Number(amount)])
    .sort(([a], [b]) => a.localeCompare(b));
  const context = vm.createContext({
    VOTING_CONTRACT: '0xvote',
    VOTING_ID_BY_HASH: new Map([[hashA, 'ambire'], [hashB, 'rotki']]),
    votingBallots: new Map([['2', {
      tokenId: '2', voter: address, epoch: '1', integrationIds: [hashB], votes: [1]
    }]]),
    ownedVotingNames: [
      { tokenId: '1', epoch: '1', allocations: {} },
      { tokenId: '2', epoch: '1', allocations: { rotki: 1 } }
    ],
    votingConfirmed: { rotki: 1 },
    votingDraft: { ambire: 1, rotki: 1 },
    applyVotingBallotLog(ballots, log) {
      ballots[String(log.ballot.tokenId)] = { ...log.ballot };
      return String(log.ballot.tokenId);
    },
    votingAllocationsEqual(left, right) {
      return JSON.stringify(normalizedEntries(left)) === JSON.stringify(normalizedEntries(right));
    },
    aggregateVotingAllocations(names) {
      const result = {};
      for (const name of names) {
        for (const [id, amount] of Object.entries(name.allocations)) {
          result[id] = (result[id] || 0) + amount;
        }
      }
      return result;
    },
    recomputeVotingTallies() { counters.recompute++; },
    settleIntegrationOrder() { counters.settle++; },
    saveIntegrationOrder() { counters.saveOrder++; },
    saveVotingDraft() { counters.saveDraft++; }
  });
  vm.runInContext(
    html.slice(allocationStart, allocationEnd) + '\n' +
      html.slice(receiptStart, receiptEnd) + `
      globalThis.minedVotingReceiptApi = {
        applyMinedVotingReceipt,
        getState: () => ({ votingBallots, ownedVotingNames, votingConfirmed, votingDraft })
      };`,
    context
  );
  return { api: context.minedVotingReceiptApi, address, hashA, counters };
}

test('a mined vote is settled entirely from its verified receipt before background RPC work', () => {
  const { api, address, hashA, counters } = minedVotingReceiptHarness();
  const expectedBallots = [{ tokenId: 1n, integrationIds: [hashA], votes: [1] }];
  const expectedDraft = { ambire: 1, rotki: 1 };

  assert.throws(
    () => api.applyMinedVotingReceipt({ logs: [] }, expectedBallots, expectedDraft, address),
    /Could not verify mined ballot/,
    'a successful status alone cannot synthesize a missing event'
  );
  assert.deepEqual(counters, { recompute: 0, settle: 0, saveOrder: 0, saveDraft: 0 });

  api.applyMinedVotingReceipt({
    logs: [{
      address: '0xVote',
      ballot: {
        tokenId: '1', voter: address, epoch: '1', integrationIds: [hashA], votes: [1]
      }
    }]
  }, expectedBallots, expectedDraft, address);

  const state = api.getState();
  assert.deepEqual({ ...state.votingConfirmed }, expectedDraft);
  assert.deepEqual({ ...state.votingDraft }, expectedDraft);
  assert.deepEqual({ ...state.ownedVotingNames[0].allocations }, { ambire: 1 });
  assert.deepEqual(counters, { recompute: 1, settle: 1, saveOrder: 1, saveDraft: 1 });
});

test('a pooled draft is packed across names while preserving signed placements', () => {
  const { packVotingDraft, buildChangedVotingBallots } = votingHarness();
  const names = [
    { tokenId: '20', power: 1, allocations: { ambire: 1 } },
    { tokenId: '10', power: 3, allocations: { ambire: 1, snapshot: 2 } }
  ];
  const packed = packVotingDraft(names, { ambire: 2, snapshot: 1, zswap: 1 });
  const byToken = Object.fromEntries(Array.from(packed, name => [name.tokenId, { ...name.allocations }]));
  assert.deepEqual(byToken['10'], { ambire: 1, snapshot: 1, zswap: 1 });
  assert.deepEqual(byToken['20'], { ambire: 1 });

  const ballots = buildChangedVotingBallots(names, packed, {
    ambire: '0x' + '33'.repeat(32),
    snapshot: '0x' + '11'.repeat(32),
    zswap: '0x' + '22'.repeat(32)
  });
  assert.equal(ballots.length, 1, 'the unchanged name is not rewritten');
  assert.equal(ballots[0].tokenId, 10n);
  assert.deepEqual(Array.from(ballots[0].integrationIds), [
    '0x' + '11'.repeat(32),
    '0x' + '22'.repeat(32),
    '0x' + '33'.repeat(32)
  ]);
  assert.deepEqual(Array.from(ballots[0].votes), [1, 1, 1]);
});

test('pooled votes split at name capacity and clearing emits an empty replacement ballot', () => {
  const { packVotingDraft, buildChangedVotingBallots } = votingHarness();
  const names = [
    { tokenId: '1', power: 2, allocations: {} },
    { tokenId: '2', power: 1, allocations: {} }
  ];
  const split = packVotingDraft(names, { ambire: 3 });
  assert.equal(split[0].allocations.ambire, 2);
  assert.equal(split[1].allocations.ambire, 1);

  const clearingNames = [{ tokenId: '3', power: 1, allocations: { ambire: 1 } }];
  const cleared = packVotingDraft(clearingNames, {});
  const ballots = buildChangedVotingBallots(clearingNames, cleared, { ambire: '0x' + '44'.repeat(32) });
  assert.equal(ballots.length, 1);
  assert.deepEqual(Array.from(ballots[0].integrationIds), []);
  assert.deepEqual(Array.from(ballots[0].votes), []);
});

test('integration voting stays page-native and submits every changed name in one cast', () => {
  assert.match(html, /class="vote-dock" id="voteDock" aria-live="polite" aria-hidden="true" inert/);
  assert.match(html, /id="voteDockCount"/);
  assert.match(html, /onclick="submitVotingDraft\(\)"/);
  assert.match(html, /bindVotingHold\(plus, integration\.id, 1\)/);
  assert.match(html, /localStorage\.setItem\(key, JSON\.stringify/);
  assert.match(html, /voting\.cast\(ballots\)/);
  assert.equal((html.match(/voting\.cast\(ballots\)/g) || []).length, 1);
  assert.doesNotMatch(html, /vote-review-modal|voting dashboard|select names to vote/i);
});

test('integration links share one compact footer with voting controls', () => {
  assert.doesNotMatch(html, /many-links/);
  assert.match(html, /\.int-links \{[^}]*min-width: 0;[^}]*gap: 2px 14px;[^}]*flex-wrap: wrap;/);
  assert.match(html, /\.int-vote \{[^}]*flex: 0 0 auto;/);
  assert.match(html, /const displayLabel = link\.label === 'Chrome Web Store' \? 'Chrome' : link\.label;/);
  assert.match(html, /if \(displayLabel !== link\.label\) anchor\.title = link\.label;/);
});

function votingPowerUiHarness({ names = [], totalPower = 0, loading = false } = {}) {
  const start = html.indexOf('function renderVotingPower()');
  const end = html.indexOf('function updateVotingUi(', start);
  assert.notEqual(start, -1, 'the voting-power renderer must exist');
  assert.notEqual(end, -1, 'the voting-power renderer must be bounded');

  function makeElement(className = '', textContent = '') {
    const classes = new Set(className ? className.split(' ') : []);
    return {
      className,
      textContent,
      title: '',
      tabIndex: -1,
      open: true,
      children: [],
      classList: {
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        contains(name) { return classes.has(name); }
      },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }
    };
  }

  const elements = {
    integrationVoteDetails: makeElement(),
    integrationVotePower: makeElement('int-power'),
    integrationVotePowerSummary: makeElement(),
    integrationVotePowerSection: makeElement('int-power-section'),
    integrationVotePowerList: makeElement('int-power-list')
  };
  const context = vm.createContext({
    connectedAddress: '0x1234',
    votingReady: !loading,
    votingLoading: loading,
    ownedVotingNames: names,
    votingTotalPower: totalPower,
    $: id => elements[id],
    formatVoteCount: value => Number(value).toLocaleString('en-US'),
    integrationElement: (_tag, className, textContent) => makeElement(className, textContent)
  });
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.renderVotingPower = renderVotingPower;',
    context
  );
  context.renderVotingPower();
  return elements;
}

test('integration heading uses one disclosure so Chrome keeps voting context on one line', () => {
  const start = html.indexOf('<div class="int-vote-caption" id="integrationVoteCaption">');
  const end = html.indexOf('<div class="int-list" id="integrationList">', start);
  assert.notEqual(start, -1, 'the integration voting caption must exist');
  assert.notEqual(end, -1, 'the integration voting caption must be bounded');
  const caption = html.slice(start, end);

  assert.equal((caption.match(/<details\b/g) || []).length, 1);
  assert.match(caption, /<details class="int-vote-details" id="integrationVoteDetails">/);
  assert.match(caption, /<summary><span class="int-vote-summary-label">vote ranking<\/span><span class="int-power" id="integrationVotePower">/);
  assert.doesNotMatch(caption, /<summary>shorter names carry more weight<\/summary>/);
  assert.match(caption, /class="int-power-separator" aria-hidden="true"> · <\/span>/);
  assert.match(html, /\.int-vote-caption summary \{[^}]*display: inline-block;[^}]*white-space: nowrap;/);
  assert.match(html, /\.int-vote-caption \.int-power \{ display: none;/);
  assert.match(html, /\.int-vote-caption \.int-power\.show \{ display: inline; \}/);
  assert.match(html, /power\.classList\.toggle\('show', show\);/);
  assert.match(html, /details\.open = false;/);
  assert.match(
    html,
    /summary\.textContent = `\$\{ownedVotingNames\.length\} \$\{nameWord\} · \$\{formatVoteCount\(votingTotalPower\)\} \$\{voteWord\}`;/
  );
});

test('expanded voting details share one compact panel', () => {
  const panelStart = html.indexOf('<div class="int-vote-panel">');
  const rulesStart = html.indexOf('<div class="int-vote-rules">', panelStart);
  const namesStart = html.indexOf('<div class="int-power-section" id="integrationVotePowerSection">', rulesStart);
  assert.notEqual(panelStart, -1, 'the combined voting panel must exist');
  assert.ok(panelStart < rulesStart && rulesStart < namesStart, 'rules and names must share one ordered panel');
  assert.match(html, /<div class="int-power-heading">your names<\/div>/);
  assert.match(html, /\.int-vote-panel \{[^}]*width: min\(100%, 320px\);[^}]*border: 1px solid var\(--border-muted\);/);
  assert.match(html, /\.int-power-section \{[^}]*display: none;[^}]*border-top: 1px solid var\(--border-muted\);/);
  assert.match(html, /\.int-power-section\.show \{ display: block; \}/);
  assert.match(html, /section\.classList\.toggle\('show', show\);/);
});

test('voting-power details handle empty, ordinary, and 100-name wallets', () => {
  const empty = votingPowerUiHarness();
  assert.equal(empty.integrationVotePowerSummary.textContent, 'no active names');
  assert.equal(empty.integrationVotePowerList.children.length, 1);
  assert.equal(empty.integrationVotePowerList.children[0].textContent, 'register a name to vote');

  const singular = votingPowerUiHarness({ names: [{ label: 'solo', power: 1 }], totalPower: 1 });
  assert.equal(singular.integrationVotePowerSummary.textContent, '1 name · 1 vote');
  assert.equal(singular.integrationVotePowerList.tabIndex, -1);

  const ordinary = votingPowerUiHarness({
    names: [
      { label: 'charlie', power: 1 },
      { label: 'alpha', power: 1 },
      { label: 'bravo', power: 1 }
    ],
    totalPower: 3
  });
  assert.equal(ordinary.integrationVotePowerSummary.textContent, '3 names · 3 votes');
  assert.deepEqual(
    ordinary.integrationVotePowerList.children.map(row => row.children[0].textContent),
    ['alpha.gwei', 'bravo.gwei', 'charlie.gwei']
  );
  assert.equal(ordinary.integrationVotePowerList.children[0].children[0].title, 'alpha.gwei');
  assert.equal(ordinary.integrationVotePowerList.tabIndex, -1);

  const hundredNames = Array.from({ length: 100 }, (_, index) => ({
    label: `name${String(index).padStart(3, '0')}`,
    power: 100
  }));
  const large = votingPowerUiHarness({ names: hundredNames, totalPower: 10_000 });
  assert.equal(large.integrationVotePowerSummary.textContent, '100 names · 10,000 votes');
  assert.equal(large.integrationVotePowerList.children.length, 100);
  assert.equal(large.integrationVotePowerList.tabIndex, 0);

  const loading = votingPowerUiHarness({ loading: true });
  assert.equal(loading.integrationVotePowerSummary.textContent, 'finding names…');
  assert.equal(loading.integrationVoteDetails.open, false);
});

test('voting detail rows share one rhythm and the names list stays bounded', () => {
  assert.match(html, /\.int-vote-rules div \{[^}]*padding: 2px 0;[^}]*font-size: 11px;/);
  assert.match(html, /\.int-power-section \{[^}]*padding: 10px 12px;/);
  assert.match(html, /\.int-power-heading \{ margin-bottom: 6px;/);
  assert.match(html, /\.int-power-list \{[^}]*max-height: 105px;[^}]*overflow-y: auto;/);
  assert.match(html, /\.int-power-list:focus-visible \{[^}]*outline: 1px solid var\(--fg-muted\);/);
  assert.match(html, /\.int-power-row \{[^}]*padding: 2px 0;[^}]*font-size: 11px;/);
  assert.match(html, /\.int-power-row span:first-child \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(html, /id="integrationVotePowerList" aria-label="your names and voting power" tabindex="-1"/);
});

test('the signing dock appears only after the voter changes an allocation', () => {
  assert.match(
    html,
    /const showDock = votingReady && ownedVotingNames\.length > 0 && votingDraftDirty\(\);/
  );
  assert.match(html, /dock\.classList\.toggle\('show', showDock\);/);
  assert.match(html, /dock\.setAttribute\('aria-hidden', String\(!showDock\)\);/);
  assert.match(html, /dock\.inert = !showDock;/);
});

function votingControlsHarness({ ready = true, submitting = false, connected = true, totalPower = 5 } = {}) {
  const start = html.indexOf('function renderIntegrationVotingControls(refs, state)');
  const end = html.indexOf('function renderIntegrations(', start);
  assert.notEqual(start, -1, 'the voting-control renderer must exist');
  assert.notEqual(end, -1, 'the voting-control renderer must be bounded');
  const context = vm.createContext({
    formatVoteCount: value => Number(value).toLocaleString('en-US'),
    votingReady: ready,
    votingSubmitting: submitting,
    connectedAddress: connected ? '0x1234' : null,
    votingTotalPower: totalPower
  });
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.renderVotingControls = renderIntegrationVotingControls;',
    context
  );
  return context;
}

function votingControlRefs() {
  const classes = new Set();
  return {
    classes,
    refs: {
      vote: { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } },
      total: {},
      own: {},
      minus: {},
      plus: {},
      exact: {}
    }
  };
}

test('settled vote controls stay quiet and draft controls expose one stepper', () => {
  const context = votingControlsHarness();
  const settled = votingControlRefs();
  context.renderVotingControls(settled.refs, {
    total: 5,
    own: 4,
    remaining: 1,
    draft: false,
    loading: false
  });
  assert.equal(settled.classes.has('has-own'), true);
  assert.equal(settled.classes.has('draft'), false);
  assert.equal(settled.refs.total.textContent, '5 votes');
  assert.equal(settled.refs.own.textContent, '4 yours');
  assert.equal(settled.refs.plus.disabled, false);
  assert.equal(settled.refs.own.disabled, false);
  assert.equal(settled.refs.exact.max, '5');

  const clearedDraft = votingControlRefs();
  context.renderVotingControls(clearedDraft.refs, {
    total: 1,
    own: 0,
    remaining: 5,
    draft: true,
    loading: false
  });
  assert.equal(clearedDraft.classes.has('has-own'), false);
  assert.equal(clearedDraft.classes.has('draft'), true);
  assert.equal(clearedDraft.refs.own.textContent, '0 yours');
  assert.equal(clearedDraft.refs.minus.disabled, true);

  assert.doesNotMatch(html, /\.int-vote\.draft \.int-vote-total::after/);
  assert.match(html, /\.int-vote\.has-own:not\(\.draft\):not\(\.editing\) \.int-vote-total::after \{ content: ' ·';/);
  assert.match(html, /\.int-vote\.draft \.int-vote-stepper, \.int-vote\.editing \.int-vote-stepper \{ gap: 0; box-shadow: inset 0 0 0 1px var\(--border-muted\); \}/);
  assert.match(html, /\.int-vote\.draft \.int-vote-stepper button, \.int-vote\.editing \.int-vote-stepper button \{ height: 34px;/);
  assert.match(html, /\.int-vote\.editing \.int-vote-exact \{ display: inline-block; height: 34px;/);
  assert.match(html, /\.int-vote\.draft \.int-vote-minus, \.int-vote\.editing \.int-vote-minus \{ display: inline-flex; \}/);
  assert.match(html, /stepper\.append\(minus, own, exact, plus\);\s*vote\.append\(total, stepper\);/);
  assert.match(html, /stepper\.setAttribute\('role', 'group'\);/);
});

test('vote controls keep stable targets, optical centering, and accessible labels', () => {
  assert.match(
    html,
    /\.int-vote button \{[^}]*width: 34px;[^}]*height: 34px;[^}]*display: inline-flex;[^}]*align-items: center;[^}]*justify-content: center;[^}]*letter-spacing: 0;/
  );
  assert.match(html, /\.int-vote-stepper \{[^}]*justify-content: flex-end;[^}]*height: 34px;/);
  assert.match(html, /\.int-vote \.int-vote-own \{[^}]*border: 0;[^}]*background: transparent;[^}]*text-transform: none;/);
  assert.match(html, /\.int-vote-plus-arrow \{ display: block; transform: translateY\(-2px\); \}/);
  assert.match(html, /const plusArrow = integrationElement\('span', 'int-vote-plus-arrow', '↑'\);/);
  assert.match(html, /plusArrow\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(html, /plus\.setAttribute\('aria-label', `Add one vote to \$\{integration\.name\}`\);/);
  assert.match(html, /stepper\.setAttribute\('aria-label', `Vote allocation for \$\{integration\.name\}`\);/);
  assert.doesNotMatch(html, /own\.setAttribute\('aria-label'/);
  assert.match(html, /refs\.own\.disabled = !votingReady \|\| votingSubmitting;/);
  assert.match(html, /refs\.exact\.disabled = !votingReady \|\| votingSubmitting;/);
});

test('integration voting estimates the complete batch before opening the wallet', () => {
  const start = html.indexOf('async function submitVotingDraft()');
  const end = html.indexOf('const eip6963Providers', start);
  const source = html.slice(start, end);
  const estimate = source.indexOf('voting.cast.estimateGas(ballots)');
  const cast = source.indexOf('voting.cast(ballots)');

  assert.notEqual(estimate, -1);
  assert.notEqual(cast, -1);
  assert.ok(estimate < cast, 'gas estimation must happen before the signing request');
  assert.match(source, /estimatedGas >= VOTING_MAX_TX_GAS/);
  assert.match(html, /const VOTING_MAX_TX_GAS = 1n << 24n;/);
  assert.match(source, /too large for one Ethereum transaction/i);
});

test('integration voting translates contract reverts into useful messages', () => {
  const abiStart = html.indexOf('const VOTING_ABI = [');
  const abiEnd = html.indexOf('const VOTING_IFACE', abiStart);
  const abiSource = html.slice(abiStart, abiEnd);
  const helpStart = html.indexOf('const CONTRACT_ERROR_HELP = {');
  const helpEnd = html.indexOf('function decodeContractError', helpStart);
  const helpSource = html.slice(helpStart, helpEnd);

  for (const error of ['NotNameOwner', 'InactiveName', 'TooManyAllocations', 'TooManyVotes']) {
    assert.match(abiSource, new RegExp(`error ${error}\\(`));
    assert.match(helpSource, new RegExp(`${error}:`));
  }
  assert.match(helpSource, /0x6babcc29': 'NotNameOwner'/);
  assert.match(helpSource, /0x12d4e92d': 'InactiveName'/);
});

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
    if (/\bsrc\s*=|\btype\s*=\s*["'](?:module|application\/json)["']/i.test(attributes)) continue;
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
  const end = html.indexOf('async function doClearContenthash()', start);
  const source = html.slice(start, end);
  assert.match(source, /parseWeb3Url\(input\)/);
  assert.match(source, /setText\(tokenId, CONTENTCONTRACT, formatContentContract\(pointer\)\)/);
  assert.match(source, /setContenthash\(tokenId, contenthash\)/);
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
  const end = html.indexOf('async function doClearContenthash()', start);
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
    currentTokenName: 'ethereumrock',
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

// --- switching a shadowed contract to the live website --------------------------

function switchNote(state) {
  const start = html.indexOf('function websiteSwitchNote()');
  const end = html.indexOf('function showManageForm(action)', start);
  assert.notEqual(start, -1, 'websiteSwitchNote must exist');
  assert.notEqual(end, -1, 'websiteSwitchNote must sit above showManageForm');
  const context = vm.createContext({
    escapeHtml: (value) => String(value),
    formatWeb3Url: (pointer) => `web3://${pointer.address}:${pointer.chainId}/`,
    ...state
  });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.note = websiteSwitchNote();', context);
  return context.note;
}

test('Set Website offers the switch only when a contenthash shadows a contract', () => {
  const pointer = { chainId: 1, address: ROCK };
  const shown = switchNote({ currentHasContenthash: true, currentContentContract: pointer });
  assert.match(shown, /doClearContenthash\(\)/);
  assert.ok(shown.includes(`web3://${ROCK}:1/`), 'names the contract the website switches to');
  // Either record on its own is an ordinary state the input already handles.
  assert.equal(switchNote({ currentHasContenthash: true, currentContentContract: null }), '');
  assert.equal(switchNote({ currentHasContenthash: false, currentContentContract: pointer }), '');
});

test('the switch note leads the Set Website form', () => {
  const start = html.indexOf("case 'setContent':");
  const end = html.indexOf("case 'setText':", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end);
  assert.match(source, /\$\{websiteSwitchNote\(\)\}/);
  assert.ok(source.indexOf('websiteSwitchNote()') < source.indexOf('id="contentHash"'));
});

function setContentHarness({ onWait } = {}) {
  const start = html.indexOf('async function doSetContent()');
  const end = html.indexOf('async function doClearContenthash()', start);
  assert.notEqual(start, -1, 'doSetContent must exist');
  assert.notEqual(end, -1);
  const calls = [];
  const forms = [];
  let context;
  context = vm.createContext({
    CONTENTCONTRACT: 'contentcontract',
    GWEI_GATEWAY: 'gwei.domains',
    contract: {
      setText(tokenId) { calls.push(['setText', tokenId]); return { hash: '0xset' }; },
      setContenthash(tokenId) { calls.push(['setContenthash', tokenId]); return { hash: '0xset' }; }
    },
    currentContentContract: { chainId: 1, address: ROCK },
    currentHasContenthash: true,
    currentTokenId: 1n,
    currentTokenName: 'ethereumrock',
    async doCheckName() {},
    encodeContenthash() { throw new Error('unexpected contenthash'); },
    event: { target: { disabled: false } },
    formatContentContract() { return `eth:${ROCK}`; },
    handleError(error) { throw error; },
    isProcessing: false,
    parseWeb3Url() { return { chainId: 1, address: ROCK }; },
    showManageForm(action) { forms.push([action, context.currentTokenId]); },
    showStatus() {},
    async waitForTx() { onWait?.(context); },
    async wcTransaction(tx) { return tx; },
    $() { return { value: `web3://${ROCK}:1/`, classList: { remove() {} } }; }
  });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.setContent = doSetContent;', context);
  return { calls, forms, run: () => context.setContent() };
}

test('Set Website does not reopen on a different name selected during confirmation', async () => {
  const harness = setContentHarness({
    onWait(context) {
      context.currentTokenId = 2n;
      context.currentTokenName = 'another-name';
      context.currentHasContenthash = true;
      context.currentContentContract = { chainId: 1, address: ROCK };
    }
  });

  await harness.run();
  await Promise.resolve(); // Let the refresh continuation run.

  assert.deepEqual(harness.calls, [['setText', 1n]]);
  assert.deepEqual(harness.forms, []);
});

function clearContenthashHarness(state = {}) {
  const start = html.indexOf('async function doClearContenthash()');
  const end = html.indexOf('async function doSetPrimary()', start);
  assert.notEqual(start, -1, 'doClearContenthash must exist');
  assert.notEqual(end, -1);
  const { onWait, ...overrides } = state;
  const calls = [];
  const statuses = [];
  let context;
  context = vm.createContext({
    GWEI_GATEWAY: 'gwei.domains',
    contract: {
      setText(tokenId, key) { calls.push(['setText', key]); return { hash: '0xtext' }; },
      setContenthash(tokenId, value) { calls.push(['setContenthash', tokenId, value]); return { hash: '0xcleared' }; }
    },
    currentContentContract: { chainId: 1, address: ROCK },
    currentHasContenthash: true,
    currentTokenId: 1n,
    currentTokenName: 'ethereumrock',
    async doCheckName() {},
    event: { target: { disabled: false } },
    handleError(error) { throw error; },
    isProcessing: false,
    showStatus(message, type) { statuses.push({ message, type }); },
    async waitForTx() { onWait?.(context); },
    async wcTransaction(tx) { return tx; },
    $() { return { classList: { remove() {} } }; },
    ...overrides
  });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.clearContenthash = doClearContenthash;', context);
  return { calls, statuses, run: () => context.clearContenthash() };
}

test('Remove contenthash sends one transaction and keeps the contract pointer', async () => {
  const harness = clearContenthashHarness();

  await harness.run();

  assert.deepEqual(harness.calls, [['setContenthash', 1n, '0x']]);
  assert.equal(harness.statuses.at(-1).type, 'success');
  assert.match(harness.statuses.at(-1).message, /ethereumrock\.gwei\.domains/);
});

test('Remove contenthash refuses a name with no contract to switch to', async () => {
  const harness = clearContenthashHarness({ currentContentContract: null });

  await harness.run();

  assert.deepEqual(harness.calls, []);
  assert.equal(harness.statuses.at(-1).type, 'error');
});

test('Remove contenthash keeps the original name in its transaction and success link', async () => {
  const harness = clearContenthashHarness({
    onWait(context) {
      context.currentTokenId = 2n;
      context.currentTokenName = 'another-name';
    }
  });

  await harness.run();

  assert.deepEqual(harness.calls, [['setContenthash', 1n, '0x']]);
  assert.match(harness.statuses.at(-1).message, /ethereumrock\.gwei\.domains/);
  assert.doesNotMatch(harness.statuses.at(-1).message, /another-name/);
});

function recentWebsites(cache, limit) {
  const start = html.indexOf('function recentWebsiteLabels(cache, limit)');
  const end = html.indexOf('async function loadStats()', start);
  assert.notEqual(start, -1, 'the recent-websites helper must exist');
  assert.notEqual(end, -1, 'the recent-websites helper must be bounded');

  const context = vm.createContext({});
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.recentWebsiteLabels = recentWebsiteLabels;',
    context
  );
  return [...context.recentWebsiteLabels(cache, limit)]; // copy out of the vm realm so deepEqual works
}

test('a re-registration drops website records from the prior record version', () => {
  const start = html.indexOf('function statsRecordName(cache, node, label, len, top)');
  const end = html.indexOf('// Names that serve a website', start);
  assert.notEqual(start, -1, 'the name-record helper must exist');
  assert.notEqual(end, -1, 'the name-record helper must be bounded');
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end) + '\nglobalThis.statsRecordName = statsRecordName;', context);

  const cache = {
    names: { node: { label: 'old-owner', len: 9, top: true } },
    ch: { node: { len: 36, block: 50 } },
    cc: { node: { len: 46, block: 60 } }
  };
  context.statsRecordName(cache, 'node', 'new-owner', 9, true);

  assert.equal(cache.names.node.label, 'new-owner');
  assert.equal(cache.ch.node, undefined);
  assert.equal(cache.cc.node, undefined);
});

// One name per case: an IPFS, a Swarm and an IPNS contenthash, a web3:// contract, a name whose
// contenthash was cleared in favour of its contract, a name with neither record left, a subdomain
// and a name that never set anything.
const websiteCache = {
  names: {
    '0x01': { label: 'ipfs-site', top: true },
    '0x02': { label: 'swarm-site', top: true },
    '0x03': { label: 'ipns-site', top: true },
    '0x04': { label: 'ethereumrock', top: true },
    '0x05': { label: 'switched', top: true },
    '0x06': { label: 'cleared', top: true },
    '0x07': { label: 'sub', top: false },
    '0x08': { label: 'no-site', top: true }
  },
  ch: {
    '0x01': { len: 38, block: 300 },
    '0x02': { len: 38, block: 100 },
    '0x03': { len: 38, block: 200 },
    '0x05': { len: 0, block: 400 },
    '0x06': { len: 0, block: 420 },
    '0x07': { len: 38, block: 500 }
  },
  cc: {
    '0x04': { len: 45, block: 250 },
    '0x05': { len: 45, block: 150 },
    '0x06': { len: 0, block: 430 },
    '0x07': { len: 45, block: 500 }
  }
};

test('recent websites rank contenthash and web3:// contract sites together', () => {
  assert.deepEqual(recentWebsites(websiteCache, 50), [
    'ipfs-site',
    'ethereumrock',
    'ipns-site',
    'switched',
    'swarm-site'
  ]);
});

test('recent websites date a name by the record the gateway serves', () => {
  const cache = {
    names: { '0x01': { label: 'shadowed', top: true }, '0x02': { label: 'contract-only', top: true } },
    ch: { '0x01': { len: 38, block: 100 } },
    cc: { '0x01': { len: 45, block: 900 }, '0x02': { len: 45, block: 500 } }
  };

  // 0x01 serves its contenthash, so the newer shadowed contract record must not move it up.
  assert.deepEqual(recentWebsites(cache, 50), ['contract-only', 'shadowed']);
});

test('recent websites keep the limit', () => {
  assert.deepEqual(recentWebsites(websiteCache, 2), ['ipfs-site', 'ethereumrock']);
});

test('the stats scan reads contentcontract records alongside contenthashes', () => {
  const start = html.indexOf('const STATS_NAME_TOPIC');
  const end = html.indexOf('loadStats();', start);
  assert.notEqual(start, -1, 'the stats section must exist');
  assert.notEqual(end, -1, 'the stats section must be bounded');
  const statsSource = html.slice(start, end);

  // TextChanged(bytes32,string,string) and keccak256('contentcontract'), its indexed key.
  assert.match(statsSource, /STATS_TEXT_TOPIC = '0xd8c9334b1a9c2f9da342a0a2b32629c1a229b6445dad78947f674b44444a7550'/);
  assert.match(statsSource, /STATS_CC_KEY = '0x58d1a44eb778f49875f62ace52dcda3a77ed4f1b085b6668edba23e2aea510ec'/);
  assert.match(statsSource, /topics: \[\[STATS_NAME_TOPIC, STATS_CH_TOPIC, STATS_TEXT_TOPIC\]\]/);
  assert.match(statsSource, /log\.topics\[2\] === STATS_CC_KEY/);
  // A cache from before contentcontract was scanned has to be discarded, not resumed from.
  assert.match(statsSource, /c\.names && c\.ch && c\.cc &&/);
});

// --- read RPC failover ---------------------------------------------------------

function rpcHarness(fetchImpl) {
  const start = html.indexOf('const RPC_TIMEOUT_MS');
  const end = html.indexOf('function getRpc()', start);
  assert.notEqual(start, -1, 'read RPC helpers must exist');
  assert.notEqual(end, -1, 'read RPC helpers must be bounded');
  const timers = [];
  const context = vm.createContext({
    console: { warn() {}, log() {}, error() {} },
    AbortController,
    fetch: fetchImpl,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    ethers: { JsonRpcProvider: class { constructor() {} } }
  });
  vm.runInContext(
    html.slice(start, end) +
      '\nglobalThis.rpcApi = { FailoverRpcProvider, isRpcCapacityError, isRpcUnavailable, RPC_UNAVAILABLE_MESSAGE };',
    context
  );
  return { api: context.rpcApi, timers };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('read RPC fails over on a rate limit and sticks with the endpoint that answered', async () => {
  const calls = [];
  const { api } = rpcHarness(async url => {
    calls.push(url);
    if (url === 'https://a') return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } }, 429);
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1' });
  });
  const provider = new api.FailoverRpcProvider(['https://a', 'https://b'], {});
  const first = await provider._send({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] });
  assert.equal(first[0].result, '0x1');
  assert.deepEqual(calls, ['https://a', 'https://b']);
  assert.equal(provider.rpcIndex, 1);
  await provider._send({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] });
  assert.deepEqual(calls, ['https://a', 'https://b', 'https://b'], 'the throttled endpoint is not retried first');
});

test('read RPC treats a 200 rate-limit reply as a failure but passes reverts through', async () => {
  const calls = [];
  const { api } = rpcHarness(async url => {
    calls.push(url);
    if (url === 'https://a') return jsonResponse([{ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests' } }]);
    return jsonResponse([{ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0xceea21b6' } }]);
  });
  const provider = new api.FailoverRpcProvider(['https://a', 'https://b'], {});
  const reply = await provider._send([{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }]);
  assert.equal(reply[0].error.message, 'execution reverted', 'a revert is an answer, not an outage');
  assert.deepEqual(calls, ['https://a', 'https://b']);

  assert.equal(api.isRpcCapacityError({ error: { code: -32005, message: 'limit exceeded' } }), true);
  assert.equal(api.isRpcCapacityError({ error: { code: -32000, message: 'header not found, try again later' } }), true);
  assert.equal(api.isRpcCapacityError({ error: { code: -32000, message: 'execution reverted' } }), false);
  assert.equal(api.isRpcCapacityError({ error: { code: 3, message: 'execution reverted: rate' } }), false);
  assert.equal(api.isRpcCapacityError({ error: { code: -32603, message: 'internal error', data: '0x08c379a0' } }), false, 'revert data is an answer');
  assert.equal(api.isRpcCapacityError({ error: { code: -32000, message: 'out of gas: gas limit reached' } }), false);
  assert.equal(api.isRpcCapacityError({ result: '0x' }), false);
});

test('read RPC moves on from a hanging endpoint after its timeout', async () => {
  const calls = [];
  const { api, timers } = rpcHarness((url, init) => {
    calls.push(url);
    if (url === 'https://a') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x2' }));
  });
  const provider = new api.FailoverRpcProvider(['https://a', 'https://b'], {});
  const pending = provider._send({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 1, 'each attempt arms a timeout');
  timers[0]();
  const reply = await pending;
  assert.equal(reply[0].result, '0x2');
  assert.deepEqual(calls, ['https://a', 'https://b']);
});

test('read RPC reports a clear error when every endpoint fails', async () => {
  const { api } = rpcHarness(async () => jsonResponse({}, 503));
  const provider = new api.FailoverRpcProvider(['https://a', 'https://b'], {});
  await assert.rejects(provider._send({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }), error => {
    assert.equal(error.code, 'RPC_UNAVAILABLE');
    assert.equal(error.message, api.RPC_UNAVAILABLE_MESSAGE);
    assert.equal(api.isRpcUnavailable(error), true);
    return true;
  });
  assert.equal(api.isRpcUnavailable(new Error('execution reverted')), false);
});

test('lookups surface an unreachable RPC with a retry instead of hanging or saying "not found"', () => {
  const lookup = html.slice(html.indexOf('function showLookupError(e)'), html.indexOf('// reveal() mints with safeMint'));
  assert.match(lookup, /isRpcUnavailable\(e\) \? RPC_UNAVAILABLE_MESSAGE/);
  assert.match(lookup, /class="retry-btn" onclick="checkName\(\)"/);
  const resolve = html.slice(html.indexOf('async function resolveRecipient'), html.indexOf('let transferPreviewDebounce'));
  assert.match(resolve, /if \(isRpcUnavailable\(e\)\) throw e;/);
  const manage = html.slice(html.indexOf('async function showManage('), html.indexOf('function websiteSwitchNote()'));
  assert.match(manage, /retry\.onclick = \(\) => showManage\(tokenId, name\);/);
});

// --- name validation -------------------------------------------------------------

function labelHarness({ library = true } = {}) {
  const start = html.indexOf('// Contract-compatible normalization (matches on-chain validation)');
  const end = html.indexOf('let checkDebounce = null;', start);
  assert.notEqual(start, -1, 'label helpers must exist');
  assert.notEqual(end, -1, 'label helpers must be bounded');
  // A small stand-in for @adraffy/ens-normalize with the behaviours these tests rely on.
  function ensNormalize(s) {
    if (/[^_]_/.test(s)) throw new Error('underscore allowed only at start');
    if (/[Ѐ-ӿ]/.test(s) && /[a-z]/i.test(s)) throw new Error('illegal mixture: Cyrillic + Latin "p"‎ {70}');
    if (/\s/.test(s)) throw new Error('disallowed character: " "‎ {20}');
    return s.toLowerCase();
  }
  const context = vm.createContext({ textEncoder: new TextEncoder(), ...(library ? { ens_normalize: ensNormalize } : {}) });
  vm.runInContext(
    html.slice(start, end) +
      '\nglobalThis.labelApi = { normalizeLabel, normalizeLabelForLookup, normalizeLabelContract, normalizeFullName, getNormalizationError, contractLabelError, stripGweiSuffix };',
    context
  );
  return context.labelApi;
}

test('registration labels apply ENSIP-15 and then the registry rules', () => {
  const api = labelHarness();
  assert.equal(api.normalizeLabel('Donnoh'), 'donnoh');
  // ENSIP-15 accepts a leading/trailing hyphen; the contract does not (isAvailable() would say "taken").
  assert.equal(api.normalizeLabel('-abc'), null);
  assert.equal(api.normalizeLabel('abc-'), null);
  assert.equal(api.getNormalizationError('-abc'), 'Name cannot start or end with a hyphen');
  assert.equal(api.contractLabelError('x'.repeat(256)), 'Name too long (max 255 bytes)');
  // Names ENSIP-15 rejects are invalid for registration, with its reason...
  assert.equal(api.normalizeLabel('a_b'), null);
  assert.equal(api.getNormalizationError('a_b'), 'Underscores are only allowed at the start');
  assert.equal(api.normalizeLabel('аpple'), null);
  assert.match(api.getNormalizationError('аpple'), /^Mixes scripts \(Cyrillic \+ Latin "p"\), possible look-alike$/);
  // ...but existing on-chain names with such labels can still be looked up.
  assert.equal(api.normalizeLabelForLookup('Lex_Node'), 'lex_node');
  assert.equal(api.normalizeLabelForLookup('-abc'), null, 'the registry can never hold a hyphen-edged label');
  assert.equal(api.normalizeFullName('Sub.lex_node.gwei'), 'sub.lex_node');
});

test('the contract-only fallback is used only when the ENSIP-15 library is missing', () => {
  const api = labelHarness({ library: false });
  assert.equal(api.normalizeLabel('A_b'), 'a_b');
  assert.equal(api.normalizeLabel('-abc'), null);
  assert.ok(html.includes('const ENS_LIBRARY_WARNING ='), 'the lookup shows a visible warning then');
});

test('a trailing .gwei is stripped case-insensitively before validation', () => {
  const api = labelHarness();
  assert.equal(api.stripGweiSuffix('donnoh.gwei'), 'donnoh');
  assert.equal(api.stripGweiSuffix(' Donnoh.GWEI '), 'Donnoh');
  assert.equal(api.stripGweiSuffix('gwei'), 'gwei');
  assert.equal(api.normalizeLabel(api.stripGweiSuffix('donnoh.gwei')), 'donnoh');
  const lookup = html.slice(html.indexOf('async function doCheckName()'), html.indexOf('// reveal() mints with safeMint'));
  assert.match(lookup, /const label = stripGweiSuffix\(raw\);/);
  assert.match(html, /const name = normalizeLabel\(stripGweiSuffix\(\$\('nameInput'\)\.value\)\);/, 'Commit strips it too');
});

test('a lookup supersedes stale responses and never offers an invalid name', () => {
  const check = html.slice(html.indexOf('function showCheckingState()'), html.indexOf('function setCommitButton('));
  assert.match(check, /checkVersion\+\+;/);
  assert.match(check, /hideManage\(\);/);
  assert.match(check, /showCheckingState\(\);\s*checkDebounce = setTimeout/);
  const lookup = html.slice(html.indexOf('async function doCheckName()'), html.indexOf('// reveal() mints with safeMint'));
  const firstAwait = lookup.indexOf('await ');
  assert.ok(lookup.indexOf('const thisVersion = ++checkVersion;') < firstAwait, 'every run bumps the version before awaiting');
  assert.match(lookup, /if \(available && invalidReason\) \{[\s\S]*?commitBtn\.style\.display = 'none';/);
  assert.match(html, /function hideManage\(\) \{\s*manageVersion\+\+;/, 'hiding Manage cancels an in-flight load');
});

// --- commit / pending -------------------------------------------------------------

function commitButtonHarness({ signer = null, pending = null } = {}) {
  const start = html.indexOf('function setCommitButton(name)');
  const end = html.indexOf('function showLookupError(e)', start);
  const elements = { commitBtn: { style: {}, textContent: '', disabled: false }, commitHint: { textContent: '' } };
  const context = vm.createContext({ $: id => elements[id], loadPending: () => pending, signer });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.setCommitButton = setCommitButton;', context);
  return { set: context.setCommitButton, elements };
}

test('Commit asks for a wallet instead of sitting disabled, and explains a pending commit', () => {
  let h = commitButtonHarness();
  h.set('donnoh');
  assert.equal(h.elements.commitBtn.textContent, 'Connect wallet to register');
  assert.equal(h.elements.commitBtn.disabled, false);
  assert.equal(h.elements.commitHint.textContent, 'Registering takes two transactions about a minute apart: Commit, then Register.');

  h = commitButtonHarness({ signer: {} });
  h.set('donnoh');
  assert.equal(h.elements.commitBtn.textContent, 'Commit');
  assert.equal(h.elements.commitBtn.disabled, false);

  h = commitButtonHarness({ signer: {}, pending: { name: 'other' } });
  h.set('donnoh');
  assert.equal(h.elements.commitBtn.disabled, true);
  assert.match(h.elements.commitHint.textContent, /other\.gwei is pending \(one registration at a time\)/);

  h = commitButtonHarness();
  h.set(null);
  assert.equal(h.elements.commitBtn.textContent, 'Commit');
  assert.equal(h.elements.commitBtn.disabled, true);

  assert.match(html, /async function doCommit\(\) \{\s*if \(!signer\) \{ showStatus\('Connect your wallet to register', ''\); toggleWallet\(\); return; \}/);
  assert.doesNotMatch(html, /[Rr]eady to reveal|then reveal|able to reveal/, 'user-facing copy says register, not reveal');
});

test('the fee is shown per year, matching the one-year registration period', () => {
  const contract = fs.readFileSync(path.join(__dirname, '..', 'src', 'NameNFT.sol'), 'utf8');
  assert.match(contract, /uint256 constant REGISTRATION_PERIOD = 365 days;/);
  assert.match(contract, /expiresAt: parentId == 0 \? uint64\(block\.timestamp \+ REGISTRATION_PERIOD\) : 0/);
  assert.match(html, /let feeText = ethers\.formatEther\(fee\) \+ ' ETH \/ year';/);
});

function migrationHarness(entries) {
  const start = html.indexOf('function migrateLegacyPending(');
  const end = html.indexOf('try { migrateLegacyPending(', start);
  const storage = new Map(Object.entries(entries));
  const context = vm.createContext({ LEGACY_STORAGE_KEY: 'gwei_pending_commits' });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.migrate = migrateLegacyPending;', context);
  const api = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  };
  return { run: (chainId) => context.migrate(api, chainId, 'gwei_pending_commits_' + chainId), storage };
}

test('pending commits are kept per chain and old entries move to mainnet without losing a secret', () => {
  assert.match(html, /const STORAGE_KEY = LEGACY_STORAGE_KEY \+ '_' \+ CHAIN_ID;/);

  let h = migrationHarness({ gwei_pending_commits: '{"name":"a"}' });
  h.run(11155111);
  assert.equal(h.storage.get('gwei_pending_commits'), '{"name":"a"}', 'Sepolia leaves the unlabelled entry alone');
  assert.equal(h.storage.has('gwei_pending_commits_11155111'), false);
  h.run(1);
  assert.equal(h.storage.get('gwei_pending_commits_1'), '{"name":"a"}');
  assert.equal(h.storage.has('gwei_pending_commits'), false);

  h = migrationHarness({ gwei_pending_commits: '{"name":"old"}', gwei_pending_commits_1: '{"name":"new"}' });
  h.run(1);
  assert.equal(h.storage.get('gwei_pending_commits_1'), '{"name":"new"}');
  assert.equal(h.storage.get('gwei_pending_commits'), '{"name":"old"}', 'a conflicting secret is never deleted');
});

test('cancelling a commitment that was already sent asks first', () => {
  const start = html.indexOf('function pendingCommitSent(pending)');
  const end = html.indexOf('// A background tab', start);
  let asked = 0, cleared = 0, answer = false, pending = null;
  const context = vm.createContext({
    loadPending: () => pending,
    confirm: message => { asked++; assert.match(message, /gas paid for the commit is lost/); return answer; },
    clearPending: () => { cleared++; }
  });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.cancelPending = cancelPending;', context);

  pending = { name: 'x', confirmed: false };
  context.cancelPending();
  assert.deepEqual([asked, cleared], [0, 1], 'nothing was sent yet: cancel straight away');

  pending = { name: 'x', confirmed: false, txHash: '0xabc' };
  context.cancelPending();
  assert.deepEqual([asked, cleared], [1, 1], 'declining keeps the secret');

  pending = { name: 'x', confirmed: true };
  answer = true;
  context.cancelPending();
  assert.deepEqual([asked, cleared], [2, 2]);
  assert.match(html, /<button class="secondary" onclick="cancelPending\(\)">Cancel<\/button>/);
});

test('the tab title says when a commitment is ready to register and is restored afterwards', () => {
  const start = html.indexOf("const PAGE_TITLE = ");
  const end = html.indexOf('// The countdown pauses while the tab is hidden', start);
  const document = { title: '' };
  const context = vm.createContext({ document, clearTimeout() {} });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.api = { setPendingReadyTitle, applyPageTitle, setPage: t => { pageTitle = t; } };', context);
  context.api.setPage('donnoh.gwei - GNS');
  context.api.applyPageTitle();
  assert.equal(document.title, 'donnoh.gwei - GNS');
  context.api.setPendingReadyTitle({ name: 'donnoh' });
  assert.equal(document.title, 'ready to register · donnoh.gwei');
  assert.doesNotMatch(document.title, /—/);
  context.api.setPendingReadyTitle(null);
  assert.equal(document.title, 'donnoh.gwei - GNS');
});

test('a malformed URL hash is treated as no name', () => {
  const strip = html.slice(html.indexOf('function stripGweiSuffix(input)'), html.indexOf('// Normalize a label for registration'));
  const start = html.indexOf('function initFromHash()');
  const end = html.indexOf('// Update URL hash and page title', start);
  let checks = 0;
  const input = { value: '' };
  const location = { hash: '#%E0%A4%A' };
  const context = vm.createContext({ window: { location }, decodeURIComponent, $: () => input, checkName: () => { checks++; } });
  vm.runInContext(strip + html.slice(start, end) + '\nglobalThis.initFromHash = initFromHash;', context);
  assert.doesNotThrow(() => context.initFromHash());
  assert.equal(checks, 0);
  location.hash = '#Donnoh.GWEI';
  context.initFromHash();
  assert.equal(input.value, 'Donnoh');
  assert.equal(checks, 1);
});

// --- page shell -------------------------------------------------------------------

test('icons and the manifest exist and are copied by the Dockerfile', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  for (const file of ['favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.json']) {
    assert.ok(fs.existsSync(path.join(__dirname, file)), `dapp/${file} must exist`);
    assert.match(dockerfile, new RegExp(`^COPY dapp/${file.replace('.', '\\.')} /www/${file.replace('.', '\\.')}$`, 'm'));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(__dirname, icon.src.slice(1))), icon.src);
  assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.json">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/gwei\.domains\/icon-512\.png">/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.doesNotMatch(html.match(/<title>([^<]*)<\/title>/)[1], /^GNS$|—/);
});

test('heavy libraries load on demand and ethers no longer blocks rendering', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.doesNotMatch(head, /<script[^>]+src=/, 'no external script blocks the first paint');
  assert.doesNotMatch(html, /<script[^>]+walletconnect/i, 'WalletConnect is not a page script');
  assert.match(html, /const WALLETCONNECT_SRI = 'sha384-ACTo60vL1\/AfeYkCCXRvB1G0ugjHF0\/SHU9YN7e4\/KH\/mitAIYpLcw5PKXW\/\+ekM';/);
  assert.match(html, /script\.integrity = WALLETCONNECT_SRI;/);
  assert.doesNotMatch(html, /^import .* from "\/vendor\/entry\.js";/m, 'the ZKPassport SDK is not imported up front');
  assert.match(html, /import\("\/vendor\/entry\.js"\)/);
  // ethers still loads before the main script that needs it synchronously.
  assert.ok(html.indexOf('ethers.umd.min.js') < html.indexOf('// Global error handler for debugging on mobile'));
});

test('analytics uses the standard manual Cloudflare snippet', () => {
  assert.match(html, /<script defer src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon='\{"token": "be57eb6251e840a591ab66afaffe7d83"\}'><\/script>/);
  assert.doesNotMatch(html, /beacon\.min\.js\/v/);
});

test('integration and OpenSea links point at live URLs', () => {
  const integrations = JSON.parse(html.match(/<script type="application\/json" id="integrationData">([\s\S]*?)<\/script>/)[1]);
  assert.equal(integrations.some(i => i.id === 'cleave'), false, 'cleave.market is disabled');
  const walletchan = integrations.find(i => i.id === 'walletchan');
  assert.ok(walletchan.links.some(l => l.url === 'https://github.com/walletchan/walletchan'));
  assert.doesNotMatch(html, /github\.com\/apoorvlathey\/walletchan|opensea\.io\/assets/);
  assert.match(html, /asset: 'https:\/\/opensea\.io\/item\/ethereum', collection: 'https:\/\/opensea\.io\/contract\/ethereum'/);
});

test('dialogs and controls are keyboard accessible', () => {
  assert.equal((html.match(/role="dialog" aria-modal="true"/g) || []).length, 2);
  assert.match(html, /if \(event\.key === 'Escape'\)/);
  assert.match(html, /<label for="nameInput">Name<\/label>/);
  assert.match(html, /id="nameInput"[^>]*autocapitalize="off" autocorrect="off" spellcheck="false"/);
  assert.match(html, /id="sendAmount"[^>]*inputmode="decimal"/);
  assert.match(html, /<div id="availability" class="availability" aria-live="polite">/);
  assert.match(html, /<div id="status" class="status" aria-live="polite">/);
  assert.doesNotMatch(html, /<(?:div|span)[^>]*onclick="toggle(?:Free|Zk)Panel\(\)"/, 'panel toggles are buttons');
  assert.match(html, /:root\.dark \.dark-toggle, :root\.dark \.dark-toggle:hover \{ background-color:#fff; \}/, 'dark mode keeps background-clip');
  assert.match(html, /\.dark-toggle:hover \{[^}]*background-clip:content-box;/, 'hover keeps background-clip despite button:hover');
});

test('verify name takes the token ID, not the contract address, from marketplace and explorer URLs', () => {
  const start = html.indexOf('function parseTokenId(input) {');
  const end = html.indexOf('\n}\n', start) + 2;
  assert.notEqual(start, -1, 'parseTokenId must exist');
  const context = vm.createContext({ URL });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.parseTokenId = parseTokenId;', context);
  const id = '84108560248320321058182615469218441650470417229077422920202485267551307868599';
  const nft = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
  for (const input of [
    `https://opensea.io/item/ethereum/${nft}/${id}`,
    `https://opensea.io/assets/ethereum/${nft}/${id}`,
    `https://etherscan.io/nft/${nft}/${id}`,
    `https://etherscan.io/token/${nft}?a=${id}`,
    id,
  ]) {
    assert.equal(String(context.parseTokenId(input)), id, input);
  }
  assert.equal(String(context.parseTokenId('0x2a')), '42');
});

test('mainnet reads have three independent RPC endpoints to fail over between', () => {
  const start = html.indexOf('const NETWORKS = {');
  const end = html.indexOf('const NET_STORAGE_KEY', start);
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end) + '\nglobalThis.networks = NETWORKS;', context);
  const hosts = context.networks.ethereum.rpc.map((url) => new URL(url).host);
  assert.equal(new Set(hosts).size, 3);
});

function profileEditorHarness() {
  const start = html.indexOf('const PROFILE_FIELDS = [');
  const end = html.indexOf('function readProfileForm()', start);
  assert.notEqual(start, -1, 'profile editor helpers must exist');
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end) + `
    globalThis.api = { PROFILE_KEYS, parseGweiPage, buildGweiPage, profileChanges, isImageRef, profileImagePreview };`, context);
  return context.api;
}

test('profile editor: gwei-page keeps unknown properties, and only changed records are saved', () => {
  const api = profileEditorHarness();
  assert.deepEqual([...api.PROFILE_KEYS], ['avatar', 'display', 'description', 'url', 'com.twitter', 'com.github', 'org.telegram', 'email', 'header', 'gwei-page']);
  assert.equal(api.buildGweiPage('', '#175640', 'a.example\n\n b.example '), '{"color":"#175640","links":["a.example","b.example"]}');
  assert.equal(api.buildGweiPage('{"color":"#000000","theme":"x"}', '', ''), '{"theme":"x"}', 'unknown properties survive');
  assert.equal(api.buildGweiPage('{"color":"#000000"}', 'red', ''), '', 'an invalid colour clears it; empty means clear the record');
  assert.equal(JSON.parse(api.buildGweiPage('', '', Array.from({ length: 12 }, (_, i) => `${i}.example`).join('\n'))).links.length, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(api.profileChanges({ avatar: 'a', url: 'x.example' }, { avatar: 'a', url: '', display: 'Alice' }))),
    [['url', ''], ['display', 'Alice']]);
  const stored = '{"color":"#402370","links":["a.example"],"theme":"x"}';
  assert.equal(api.buildGweiPage(stored, '#402370', 'a.example'), stored, 'an unchanged record serializes identically');
  assert.equal(api.profileChanges({ 'gwei-page': '{ "links": ["a.example"], "color": "#402370" }' },
    { 'gwei-page': '{"color":"#402370","links":["a.example"]}' }).length, 0, 'compared by content');
});

test('profile editor: image references and previews', () => {
  const api = profileEditorHarness();
  for (const ok of ['', 'https://img.example/a.png', 'ipfs://bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644', 'eip155:1/erc721:0xaa6612f03443517ced2bdcf27958c22353ceeab9/8977']) {
    assert.equal(api.isImageRef(ok), true, ok);
  }
  assert.equal(api.isImageRef('javascript:alert(1)'), false);
  assert.equal(api.profileImagePreview('ipfs://bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644/a.png'),
    'https://ipfs.filebase.io/ipfs/bafybeif4fkci4bylob5wmge5mwavvzuk6mjjq6cj2f46egyuqt5on5e644/a.png');
  assert.equal(api.profileImagePreview('eip155:1/erc721:0xaa6612f03443517ced2bdcf27958c22353ceeab9/1'), null, 'NFTs are shown on the page, not previewed');
});

test('profile editor: one bundled confirmation via EIP-5792 when the wallet supports it, else one transaction per record', () => {
  assert.match(html, /showManageForm\('profile'\)">Edit Profile<\/button>/);
  assert.match(html, /method: 'wallet_getCapabilities'/);
  assert.match(html, /method: 'wallet_sendCalls',\s*params: \[\{ version: '2\.0\.0', chainId: chainHex, from: connectedAddress, atomicRequired: true, calls \}\]/);
  assert.match(html, /method: 'wallet_getCallsStatus'/);
  assert.match(html, /if \(!\(await sendRecordBatch\(calls\)\)\) \{\s*for \(let i = 0; i < changes\.length; i\+\+\)/);
  assert.match(html, /const textKeys = PROFILE_KEYS;/, 'Manage reads every profile record');
});
