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

test('recipient names must pass ENSIP-15, never the lookup fallback', async () => {
  const start = html.indexOf('function normalizeLabelContract');
  const end = html.indexOf('let transferPreviewDebounce', start);
  const labelStart = html.indexOf('function normalizeLabel(label)');
  const labelEnd = html.indexOf('// Normalize a full name', labelStart);
  const target = '0x00000000000000000000000000000000000000aa';
  const resolved = [];
  const window = {};
  const context = vm.createContext({
    window,
    textEncoder: new TextEncoder(),
    ethers: { isAddress: () => false, ZeroAddress: '0x0000000000000000000000000000000000000000' },
    readContract: {
      computeId: async (name) => name,
      resolve: async (name) => { resolved.push(name); return target; },
    },
    isRpcUnavailable: () => false,
  });
  vm.runInContext(
    html.slice(html.indexOf('function contractLabelError'), html.indexOf('\n}\n', html.indexOf('function contractLabelError')) + 3)
      + html.slice(start, html.indexOf('\n}\n', start) + 3)
      + html.slice(labelStart, labelEnd)
      + html.slice(html.indexOf('// Without the ENSIP-15 library'), end)
      + '\nglobalThis.resolveRecipient = resolveRecipient;',
    context
  );
  // Stand-in for ENSIP-15: lowercase ASCII names pass, anything else is rejected.
  context.ens_normalize = (label) => { if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('disallowed'); return label.toLowerCase(); };
  window.ensNormalizeReady = true;

  assert.deepEqual({ ...(await context.resolveRecipient('vitalik.gwei')) }, { address: target, name: 'vitalik.gwei' });
  assert.deepEqual({ ...(await context.resolveRecipient('Pay.Vitalik.gwei')) }, { address: target, name: 'pay.vitalik.gwei' });
  assert.equal(await context.resolveRecipient('vit\u0430lik.gwei'), null);
  assert.equal(await context.resolveRecipient('vitalik\u200d.gwei'), null);
  assert.equal(await context.resolveRecipient('lex_node.gwei'), null);

  context.ens_normalize = null;
  window.ensNormalizeReady = false;
  assert.equal(await context.resolveRecipient('vitalik.gwei'), null, 'no library, no anti-spoof check, no name sends');
  assert.deepEqual(resolved, ['vitalik.gwei', 'pay.vitalik.gwei']);
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
  assert.match(source, /setText\(tokenId, CONTENTCONTRACT, ''\)/);
  assert.match(source, /setContenthash\(tokenId, '0x'\)/);
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

test('the stats wait until the visitor scrolls or their section is about to be seen', async () => {
  const start = html.indexOf('function nearViewport(el)');
  const end = html.indexOf('async function loadStats()', start);
  assert.notEqual(start, -1, 'the viewport helper must exist');
  function load() {
    const observer = { disconnected: false };
    const scroll = new Set();
    class IntersectionObserver {
      constructor(cb) { observer.callback = cb; }
      observe() {}
      disconnect() { observer.disconnected = true; }
    }
    const window = {
      IntersectionObserver,
      addEventListener: (type, fn) => scroll.add(fn),
      removeEventListener: (type, fn) => scroll.delete(fn),
    };
    const context = vm.createContext({ window, IntersectionObserver });
    vm.runInContext(html.slice(start, end) + '\nglobalThis.nearViewport = nearViewport;', context);
    let near = false;
    const waiting = context.nearViewport({}).then(() => { near = true; });
    return { observer, scroll, waiting, near: () => near };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const byObserver = load();
  byObserver.observer.callback([{ isIntersecting: false }]);
  await tick();
  assert.equal(byObserver.near(), false, 'still far below the fold, and nobody scrolled');
  byObserver.observer.callback([{ isIntersecting: true }]);
  await byObserver.waiting;
  assert.equal(byObserver.observer.disconnected, true);
  assert.equal(byObserver.scroll.size, 0, 'the scroll listener is removed too');

  const byScroll = load();
  for (const fn of [...byScroll.scroll]) fn();
  await byScroll.waiting;
  assert.equal(byScroll.observer.disconnected, true);
  assert.equal(byScroll.scroll.size, 0);

  // Nothing is fetched before then.
  const loadStats = html.slice(end, html.indexOf('loadStats();', end));
  assert.ok(loadStats.indexOf('await nearViewport(sec)') < loadStats.indexOf("fetch(POSTS_API + '/stats')"));
});

test('the first paint holds room for what the script draws, and shows the free-name links, so nothing shifts', () => {
  assert.match(html, /\.int-list:empty \{ min-height: 100vh; \}/);
  assert.match(html, /<div class="int-list" id="integrationList"><\/div>/, 'empty until drawn, or :empty never matches');
  for (const id of ['freeCta', 'zkCta']) {
    assert.doesNotMatch(html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))[0], /display:\s*none/, id);
  }
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
  const replies = [];
  const context = vm.createContext({ window: { location }, decodeURIComponent, $: () => input, checkName: () => { checks++; }, openReply: (...args) => replies.push(args) });
  vm.runInContext('let replyPost = null;\n' + strip + html.slice(start, end) + '\nglobalThis.initFromHash = initFromHash;', context);
  assert.doesNotThrow(() => context.initFromHash());
  assert.equal(checks, 0);
  location.hash = '#Donnoh.GWEI';
  context.initFromHash();
  assert.equal(input.value, 'Donnoh');
  assert.equal(checks, 1);
  location.hash = '#reply/0x' + 'AB'.repeat(32);
  context.initFromHash();
  location.hash = '#reply/0x' + 'ab'.repeat(32) + '/alice.gwei/' + encodeURIComponent('Great post!\nCafé / 🦄');
  context.initFromHash();
  location.hash = '#reply/0x' + 'ab'.repeat(32) + '/alice.gwei/%E0%A4%A';
  context.initFromHash();
  const h = '0x' + 'ab'.repeat(32);
  assert.deepEqual(replies, [[h, '', ''], [h, 'alice.gwei', 'Great post!\nCafé / 🦄'], [h, 'alice.gwei', '']],
    'a post page’s Reply opens the reply box with its name and what was typed there (a malformed escape fills nothing)');
  assert.equal(checks, 1, 'and isn’t looked up as a name');
});

// --- page shell -------------------------------------------------------------------

test('icons and the manifest exist and are copied by the Dockerfile', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  for (const file of ['favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.json']) {
    assert.ok(fs.existsSync(path.join(__dirname, file)), `dapp/${file} must exist`);
    assert.match(dockerfile, new RegExp(`^COPY dapp/${file.replace('.', '\\.')} /usr/share/nginx/html/${file.replace('.', '\\.')}$`, 'm'));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(__dirname, icon.src.slice(1))), icon.src);
  assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.json">/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.doesNotMatch(html.match(/<title>([^<]*)<\/title>/)[1], /^GNS$|—/);
});

test('the dapp and the guide preview as large 1200x630 cards that the image copies', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const guide = fs.readFileSync(path.join(__dirname, 'guide.html'), 'utf8');
  for (const [page, file, url] of [[html, 'og-card.png', 'https://gwei.domains/'], [guide, 'og-card-guide.png', 'https://gwei.domains/guide/']]) {
    const head = page.slice(0, page.indexOf('</head>'));
    const meta = (key) => (new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(head) || [])[1];
    assert.equal(meta('og:image'), `https://gwei.domains/${file}`);
    assert.equal(meta('twitter:image'), `https://gwei.domains/${file}`);
    assert.equal(meta('twitter:card'), 'summary_large_image');
    assert.deepEqual([meta('og:image:width'), meta('og:image:height'), meta('og:image:type')], ['1200', '630', 'image/png']);
    assert.equal(meta('og:url'), url);
    for (const key of ['og:title', 'og:description', 'og:site_name', 'og:image:alt', 'twitter:title', 'twitter:description']) {
      assert.ok(meta(key), `${file}: ${key}`);
      assert.doesNotMatch(meta(key), /—/, `${file}: ${key}`);
    }
    const png = fs.readFileSync(path.join(__dirname, file));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], file);
    assert.match(dockerfile, new RegExp(`^COPY dapp/${file.replace('.', '\\.')} /usr/share/nginx/html/${file.replace('.', '\\.')}$`, 'm'));
  }
  // Crawlers read the charset from the header, which the server sends for every text type.
  assert.match(fs.readFileSync(path.join(__dirname, 'nginx.conf.template'), 'utf8'), /^\s*charset utf-8;$/m);
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
  assert.match(html, /\.dark-toggle:hover, :root\.dark \.dark-toggle:hover \{ opacity:1; background:var\(--bg\);/, 'hover keeps the page-coloured disc despite button:hover');
  assert.match(html, /<button class="dark-toggle" onclick="toggleDark\(\)" title="Switch light or dark" aria-label="Switch light or dark mode"><svg class="moon"[^]*<svg class="sun"/, 'a moon and a sun icon');
  assert.match(html, /:root\.dark \.dark-toggle \.sun \{ display:block; \}/, 'dark mode shows the sun');
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
  assert.deepEqual([...api.PROFILE_KEYS], ['avatar', 'display', 'description', 'url', 'com.twitter', 'com.github', 'org.telegram', 'org.signal', 'email', 'header', 'gwei-page']);
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

function postsHarness() {
  const start = html.indexOf('const POST_MAX_BYTES = ');
  const end = html.indexOf('let currentPostFee = null;', start);
  assert.notEqual(start, -1, 'post helpers must exist');
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(html.slice(start, end) + `
    globalThis.api = { POST_MAX_BYTES, postBytesFrom, postPathFor, postFeeFrom, tokenHexOf, postBlobFrom };`, context);
  return context.api;
}

test('posts: the dapp builds the bytes, paths and fees the gateway and publisher expect', async () => {
  const api = postsHarness();
  const gateway = await import('../gateway/posts-format.js');
  const bytes = api.postBytesFrom('Exploring the blobspace', 'Body *md* ü');
  assert.deepEqual([...bytes], [...gateway.encodePost({ title: 'Exploring the blobspace', body: 'Body *md* ü' })]);
  assert.deepEqual(gateway.parsePost(bytes), { title: 'Exploring the blobspace', body: 'Body *md* ü' });
  assert.equal(api.POST_MAX_BYTES, gateway.MAX_POST_BYTES);
  for (const title of ['Exploring the blobspace', 'Café über alles', '🦄', 'Forced txs vs based sequencing']) {
    const hash = '0x' + 'ab12'.repeat(16);
    assert.equal(api.postPathFor(hash, title), gateway.postPath(hash, title));
  }
  // gwei_poster.quote(base=0.1 gwei, tip=0.05 gwei (raised to the minimum), blob=0.006 gwei), rounded up to a gwei.
  assert.equal(api.postFeeFrom(100000000n, 100000n, 6000000n), (3n * (54500n * 150000000n + 131072n * 6000000n) + 999999999n) / 10n ** 9n * 10n ** 9n);
  const capped = 3n * (54500n * (100000000n + 2000000000n) + 131072n * 6000000n);
  assert.equal(api.postFeeFrom(100000000n, 10n ** 12n, 6000000n), (capped + 999999999n) / 10n ** 9n * 10n ** 9n, 'tip capped at 2 gwei');
  assert.equal(api.tokenHexOf(0x1234n), '0x' + '1234'.padStart(64, '0'));
});

test('posts: the form has no date: a post is dated by its blob', () => {
  assert.doesNotMatch(html, /id="ppDate"/);
  const api = postsHarness();
  assert.equal(new TextDecoder().decode(api.postBytesFrom('T', 'B')), '{"v":1,"title":"T","body":"B"}');
});

function repliesHarness() {
  const start = html.indexOf('const REPLIES_RECORD = ');
  const end = html.indexOf('async function doToggleReplies(', start);
  assert.notEqual(start, -1, 'reply helpers must exist');
  const context = vm.createContext({ TextEncoder, crypto });
  vm.runInContext(html.slice(start, end) + `
    globalThis.api = { REPLIES_RECORD, REPLY_MAX_BYTES, replyRoomFor, replyInputFrom, repliesOnFor, repliesRecordWith };`, context);
  return context.api;
}

test('replies: the dapp sends to the room, with the input, the gateway indexes', async () => {
  const api = repliesHarness();
  const gateway = await import('../gateway/replies-format.js');
  assert.equal(api.REPLIES_RECORD, gateway.REPLIES_RECORD);
  assert.equal(api.REPLY_MAX_BYTES, gateway.MAX_REPLY_BYTES);
  for (const hash of ['0x' + 'ab12'.repeat(16), '0x634CD7F83CCD' + '0'.repeat(52)]) {
    assert.equal(await api.replyRoomFor(hash), await gateway.replyRoom(hash));
  }
  for (const text of ['first!', 'Café 🦄\nline two', 'x'.repeat(1024)]) {
    assert.equal(api.replyInputFrom(text), gateway.encodeReply(text));
    assert.equal(gateway.decodeReply(api.replyInputFrom(text)), text);
  }
  assert.throws(() => api.replyInputFrom(''), /1 to 1,024 bytes/);
  assert.throws(() => api.replyInputFrom('é'.repeat(513)), /1 to 1,024 bytes/);
  const hash = '0x634cd7f83ccd' + '00'.repeat(26);
  for (const [postReplies, record] of [[undefined, ''], [false, ''], [false, '634cd7f83ccd:on'], [undefined, 'x 634CD7F83CCD:off'], [undefined, '634cd7f83ccd:off 634cd7f83ccd:on']]) {
    assert.equal(api.repliesOnFor(hash, postReplies, record), gateway.repliesOn(hash, postReplies, record), `${postReplies} ${record}`);
  }
  for (const [record, on] of [['', true], ['aaaaaaaaaaaa:off 634cd7f83ccd:on', false], ['634CD7F83CCD:off bbbbbbbbbbbb:on', true]]) {
    assert.equal(api.repliesRecordWith(record, hash, on), gateway.setRepliesRecord(record, hash, on));
  }
});

test('replies: a name’s site is linked only when a URL reads it as exactly its labels', async () => {
  const start = html.indexOf('function nameSiteOrigin(');
  const end = html.indexOf('// gwei.domains/#reply/<post hash>', start);
  const { ens_normalize } = await import('../gateway/ens-normalize.js');
  const context = vm.createContext({ URL, GWEI_GATEWAY: 'gwei.limo', ethers: { ensNormalize: ens_normalize } });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.nameSiteOrigin = nameSiteOrigin;', context);
  const o = context.nameSiteOrigin;
  assert.equal(o('alice.gwei'), 'https://alice.gwei.limo');
  assert.equal(o('alice.gwei', 'gwei.domains'), 'https://alice.gwei.domains');
  assert.equal(o('🦄.gwei'), 'https://xn--3s9h.gwei.limo');
  assert.equal(o('blog.alice.gwei'), 'https://blog.alice.gwei.limo', 'subnames have hosts too');
  for (const bad of ['evil．com/.gwei', '16843009#.gwei', 'a@evil.com.gwei', 'x/y.gwei', 'ａ.gwei', 'Alice.gwei', 'a..b.gwei', 'a:1.gwei', '.gwei', 'alice.eth', null]) {
    assert.equal(o(bad), null, String(bad));
  }
});

test('replies: they are opt-in, and the composer opts a post in unless the box is unchecked', async () => {
  const api = postsHarness();
  const gateway = await import('../gateway/posts-format.js');
  assert.match(html, /<input type="checkbox" id="ppReplies" checked/, 'new posts take replies unless the author unchecks it');
  assert.match(html, /const replies = \$\('ppReplies'\) \? \$\('ppReplies'\)\.checked : false;/);
  const on = api.postBytesFrom('T', 'B', true);
  assert.equal(new TextDecoder().decode(on), '{"v":1,"title":"T","body":"B","replies":true}');
  assert.deepEqual([...on], [...gateway.encodePost({ title: 'T', body: 'B', replies: true })]);
  assert.deepEqual([...api.postBytesFrom('T', 'B', false)], [...gateway.encodePost({ title: 'T', body: 'B' })], 'off: the field is left out, as in old posts');
  const hash = '0x634cd7f83ccd' + '00'.repeat(26);
  const replies = repliesHarness();
  assert.equal(replies.repliesOnFor(hash, undefined, ''), false, 'a post that never chose replies has none');
  assert.equal(replies.repliesOnFor(hash, undefined, '634cd7f83ccd:on'), true, 'until its author turns them on');
});

test('replies: #reply/<post> opens the reply box, sending 1 wei from the connected wallet after checking the room has no code', () => {
  assert.match(html, /window\.opener\.postMessage\(\{ type: 'gwei-reply', hash: post\.hash, tx: tx\.hash, text \}, origin\)/, 'the post’s page hears about the sent reply');
  assert.doesNotMatch(html, /postMessage\([^)]*'\*'\)/, 'and no other page does');
  assert.match(html, /if \(replyPost !== post \|\| \$\('replyText'\)\.value !== text\) throw/, 'a window pointed elsewhere mid-send sends nothing');
  assert.doesNotMatch(html, /addEventListener\('message'/, 'and nothing a page sends this window is ever acted on');
  assert.match(html, /getCode\(room\)\) !== '0x'\) throw/);
  assert.match(html, /if \(own !== '0x' && !own\.startsWith\('0xef0100'\)\) throw/, 'contract wallets would pay for a reply nobody indexes');
  assert.match(html, /signer\.sendTransaction\(\{ to: room, value: 1n, data \}\)/);
  assert.match(html, /if \(isProcessing \|\| !post\?\.ready \|\| post\.off\) return;/, 'no sending before the post is checked, nor to one with replies off');
  assert.doesNotMatch(html, /REPLIES_RECORD\)\.catch\(\(\) => currentRepliesRecord\)|currentRepliesRecord/, 'the record is never rebuilt from a guess');
  assert.match(html, /repliesRecordWith\(await contract\.text\(tokenId, REPLIES_RECORD\), hash, on\)/, 'and is read through the wallet’s node before it is rewritten');
});

test('posts: mainnet points at the deployed GnsPosts and the gwei.domains publisher', () => {
  const start = html.indexOf('const NETWORKS = {');
  const end = html.indexOf('const NET_STORAGE_KEY', start);
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end) + '\nglobalThis.networks = NETWORKS;', context);
  assert.equal(context.networks.ethereum.posts, '0x73849f6f2785BA7fd2f41b5B4573B75554417981');
  assert.equal(context.networks.ethereum.postsPublisher, '0x244C707FA9Fbb1907Dc394075633BabD2351F18d');
  assert.equal(context.networks.sepolia.posts, undefined, 'no posts on Sepolia');
});

test('posts: the Posts button and recent posts stay hidden until GnsPosts and the publisher are configured', () => {
  assert.match(html, /\$\{postsEnabled\(\) \? `<button onclick="showManageForm\('posts'\)">Posts<\/button>` : ''\}/);
  assert.match(html, /if \(!sec \|\| !list \|\| !postsEnabled\(\)\) return;/);
  assert.match(html, /<iframe id="ppPreview" class="post-preview" sandbox title="Post preview"><\/iframe>/, 'previews render in a script-less sandbox');
});

test('the theme choice is shared with name pages through a gwei.domains cookie', () => {
  const boot = html.slice(html.indexOf('// Dark mode: apply'), html.indexOf('</script>', html.indexOf('// Dark mode: apply')));
  const run = (cookie, stored, systemDark) => {
    const classes = new Set();
    const writes = [];
    const context = vm.createContext({
      document: {
        get cookie() { return cookie; }, set cookie(v) { writes.push(v); },
        documentElement: { classList: { add: (c) => classes.add(c), toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)) } },
      },
      localStorage: { getItem: () => stored, setItem: () => {} },
      matchMedia: () => ({ matches: systemDark }),
    });
    vm.runInContext(boot, context);
    return { dark: classes.has('dark'), toggle: () => { vm.runInContext('toggleDark()', context); return writes.at(-1); } };
  };
  assert.equal(run('', null, true).dark, true, 'system dark');
  assert.equal(run('', null, false).dark, false, 'system light');
  assert.equal(run('a=1; gwei-theme=light', null, true).dark, false, 'the cookie beats the system');
  assert.equal(run('gwei-theme=dark', '0', false).dark, true, 'the cookie beats the old local flag');
  assert.equal(run('', '1', false).dark, true, 'the old local flag still counts');
  assert.equal(run('', null, false).toggle(), 'gwei-theme=dark;domain=gwei.domains;path=/;max-age=31536000;samesite=lax;secure');
});

test('posts: editing the form clears a stale form error', () => {
  const start = html.indexOf('function updatePostCost() {');
  const end = html.indexOf('\nfunction postsFormHtml()', start);
  const classes = new Set(['status', 'show', 'error']);
  const status = { classList: { contains: (c) => classes.has(c), remove: (c) => classes.delete(c) } };
  const context = vm.createContext({ $: (id) => (id === 'status' ? status : null) });
  vm.runInContext(html.slice(start, end) + '\nupdatePostCost();', context);
  assert.equal(classes.has('show'), false);
});

test('posts: the dapp builds the same blob as the gateway, and the vendored KZG gives the hash c-kzg does', async () => {
  const api = postsHarness();
  const gateway = await import('../gateway/posts-format.js');
  for (const bytes of [api.postBytesFrom('Hello', 'First **post**'), api.postBytesFrom('Ü', 'x'.repeat(100000))]) {
    assert.deepEqual([...api.postBlobFrom(bytes)], [...gateway.encodeBlob([bytes])]);
  }
  const { blobVersionedHash } = await import('./vendor/kzg.bundle.mjs');
  // c-kzg (posts/poster): blob_hash(encode_blob([b'{"v":1,"title":"Hello","body":"First **post**"}']))
  assert.equal(blobVersionedHash(api.postBlobFrom(api.postBytesFrom('Hello', 'First **post**'))),
    '0x01ae02694140d76f1cbf0ed33d43812b488d10206a410c513760f05a8d00d274');
  assert.throws(() => blobVersionedHash(new Uint8Array(10)), /131072/);
});

test('posts: the dapp authorizes against the blob hash and offers refunds for undelivered posts', () => {
  assert.match(html, /posts\.authorize\(tokenId, hash, blob, POSTS_PUBLISHER, \{ value: fee \}\)/);
  assert.match(html, /const fee = delivered \? 0n : currentPostFee;/, 'no fee for a blob the publisher already delivered');
  assert.match(html, /const blob = blobVersionedHash\(postBlobFrom\(bytes\)\);/);
  assert.match(html, /posts\.refund\(blob, publisher\)/);
  assert.match(html, /'function authorize\(uint256 tokenId, bytes32 postHash, bytes32 blobHash, address publisher\) payable'/);
});

test('posts: refunds are found from this browser and from the index, and only what the contract holds is offered', async () => {
  const start = html.indexOf('const paidPostsKey = ');
  const end = html.indexOf('async function previewPost() {', start);
  const B = (n) => '0x01' + String(n).repeat(62).slice(0, 62);
  const PUB = '0x' + '24'.repeat(20);
  const ME = '0x' + 'A1'.repeat(20);
  const TOKEN = '0x' + '0'.repeat(62) + '2a';
  const store = { [`gwei_paid_posts_1_${TOKEN}`]: JSON.stringify([{ hash: '0x' + 'aa'.repeat(32), blob: B(1), publisher: PUB, title: 'Local' }]) };
  const chain = {
    [`${B(1)}|${PUB}`]: { delivered: false, amount: 5n, at: 1 }, // refundable now
    [`${B(2)}|${PUB}`]: { delivered: false, amount: 7n, at: 1 }, // only the index knows it
    [`${B(3)}|${PUB}`]: { delivered: true, amount: 0n, at: 1 }, // delivered
    [`${B(4)}|${PUB}`]: { delivered: false, amount: 0n, at: 1 }, // refunded already
    [`${B(5)}|${PUB}`]: { delivered: false, amount: 9n, at: 4102444800 }, // not due yet
  };
  const fetched = [];
  const context = vm.createContext({
    CHAIN_ID: 1, POSTS_CONTRACT: '0x' + 'c0'.repeat(20), POSTS_ABI: [], POSTS_API: 'https://gwei.domains/api', connectedAddress: ME, Date,
    tokenHexOf: (id) => '0x' + BigInt(id).toString(16).padStart(64, '0'),
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    escapeHtml: (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    getRpc: async () => ({}),
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, json: async () => ({ authorizations: [
        { hash: '0x' + 'bb'.repeat(32), blob: B(2), publisher: PUB, token: TOKEN, title: null },
        { hash: '0x' + 'aa'.repeat(32), blob: B(1), publisher: PUB, token: TOKEN, title: 'Local' }, // also in this browser
        { blob: B(3), publisher: PUB, token: TOKEN }, { blob: B(4), publisher: PUB, token: TOKEN }, { blob: B(5), publisher: PUB, token: TOKEN, title: 'Later' },
        { blob: B(6), publisher: PUB, token: '0x' + '0'.repeat(63) + '1' }, // another name
        { blob: "0x01');alert(1);//", publisher: PUB, token: TOKEN }, // never reaches the markup
      ] }) };
    },
    ethers: {
      keccak256: (x) => x, concat: (parts) => parts.join('|'), zeroPadValue: (v) => v, formatEther: (v) => String(v),
      Contract: class {
        delivered(key) { return chain[key].delivered; }
        deposits(key) { return { amount: chain[key].amount, refundableAt: BigInt(chain[key].at) }; }
      },
    },
  });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.refundRows = refundRows;', context);
  const out = await context.refundRows(42n);
  assert.deepEqual(fetched, [`https://gwei.domains/api/authors/${ME.toLowerCase()}/paid`]);
  assert.match(out, new RegExp(`doRefundPost\\('${B(1)}', '${PUB}'\\)">Refund 5 ETH`));
  assert.match(out, new RegExp(`doRefundPost\\('${B(2)}', '${PUB}'\\)">Refund 7 ETH`), 'found through the index');
  assert.match(out, /Post 0xbbbbbbbb/, 'a post whose bytes the index dropped still gets a row');
  assert.equal(out.split('Refund 5 ETH').length, 2, 'one row per blob and publisher');
  assert.match(out, /Later<\/span><span class="post-state">refundable /);
  assert.doesNotMatch(out, new RegExp(B(3) + '|' + B(4) + '|' + B(6) + '|alert'));
  assert.deepEqual(JSON.parse(store[`gwei_paid_posts_1_${TOKEN}`]).map((p) => p.blob), [B(1), B(2), B(5)]);
});

test('share card name types only mark the registrars\' own children', () => {
  const start = html.indexOf('function shareNameType(name) {');
  const end = html.indexOf('\n}\n', start) + 3;
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  assert.equal(context.shareNameType('alice.zkpassport.gwei'), 'PROOF OF HUMANITY');
  assert.equal(context.shareNameType('bob.id.gwei'), 'FREE NAME');
  assert.equal(context.shareNameType('bot.alice.zkpassport.gwei'), null);
  assert.equal(context.shareNameType('x.bob.id.gwei'), null);
  assert.equal(context.shareNameType('alice.gwei'), null);
});

test('manage actions keep targeting the name they started on when a lookup replaces it mid-await', async () => {
  const slice = (name) => {
    const start = html.indexOf(`async function ${name}(`);
    return html.slice(start, html.indexOf('\n}\n', start) + 3);
  };
  const sent = [];
  const context = vm.createContext({
    signer: {}, connectedAddress: '0xowner', event: undefined, CONTRACT: '0xnft',
    $: () => ({ value: 'bob.gwei', classList: { remove() {} } }),
    renewYearsValue: () => 1, byteLength: (s) => s.length,
    showStatus() {}, toggleWallet() {}, handleError: (e) => { throw e; }, doCheckName() {}, confirm: () => true,
    waitForTx: async () => {}, wcTransaction: async (p) => p,
  });
  vm.runInContext(`
    let isProcessing = false, currentTokenId = 1n, currentTokenName = 'alice', currentRenewFee = null;
    const lookUpAnotherName = () => { currentTokenId = 2n; currentTokenName = 'mallory'; };
    const contract = {
      renew: async (id) => { sent.push(['renew', id]); return { hash: '0x1' }; },
      transferFrom: async (from, to, id) => { sent.push(['transferFrom', id]); return { hash: '0x2' }; },
    };
    const readContract = { getFee: async (len) => { sent.push(['getFee', len]); lookUpAnotherName(); return 1n; } };
    const resolveRecipient = async () => { lookUpAnotherName(); return { address: '0xbob', name: 'bob.gwei' }; };
    ${slice('doRenew')}
    ${slice('doTransfer')}
    globalThis.run = async () => {
      await doRenew();
      currentTokenId = 1n; currentTokenName = 'alice';
      await doTransfer();
    };`, Object.assign(context, { sent }));
  await context.run();
  assert.deepEqual(sent.map((x) => [...x]), [['getFee', 5], ['renew', 1n], ['transferFrom', 1n]]);
});

test('names and the gateway URLs built from them are escaped wherever they reach HTML', () => {
  // The registry accepts " < > / = in a label, and a lookup of such a name reaches showManage
  // and the owner forms, so a raw interpolation into markup is markup injection on this origin.
  const raw = /\$\{(name|currentTokenName|tokenName|gatewayUrl|pageUrl|base)\}/;
  const offenders = html.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => raw.test(line) && /<[a-z]/i.test(line));
  assert.deepEqual(offenders, []);
});

test('a coin-60 record that disagrees with the address is flagged and cleared by Set Address', async () => {
  const slice = (marker) => {
    const start = html.indexOf(marker);
    return html.slice(start, html.indexOf('\n}\n', start) + 3);
  };
  const A = '0x00000000000000000000000000000000000000aa';
  const SELLER = '0x00000000000000000000000000000000000000Bb';
  const sent = [];
  const context = vm.createContext({
    CONTRACT: '0xnft', event: undefined,
    $: () => ({ value: A }),
    ethers: { isAddress: () => true },
    showStatus() {}, handleError: (e) => { throw e; }, doCheckName() {},
    waitForTx: async () => {}, wcTransaction: async (p) => p,
  });
  vm.runInContext(`
    let isProcessing = false, currentTokenId = 7n, currentCoin60Stale = null, batching = false, batches = [];
    const connectedAddress = '${A}';
    const contract = {
      interface: { encodeFunctionData: (fn, args) => [fn, ...args] },
      setAddr: async (id, a) => { sent.push(['setAddr', id, a]); return { hash: '0x1' }; },
      setAddrForCoin: async (id, coin, value) => { sent.push(['setAddrForCoin', id, coin, value]); return { hash: '0x2' }; },
    };
    const sendRecordBatch = async (calls) => { if (calls.length < 2 || !batching) return false; batches.push(calls.map((c) => c.data)); return true; };
    ${slice('function coin60Mismatch(')}
    ${slice('async function doSetAddr(')}
    globalThis.api = {
      coin60Mismatch, doSetAddr,
      set: (stale, batch) => { currentCoin60Stale = stale; batching = batch; },
      batches: () => batches,
    };`, Object.assign(context, { sent }));
  const { coin60Mismatch, doSetAddr, set, batches } = context.api;

  assert.equal(coin60Mismatch('0x', A), null, 'empty: lookups fall back to the address');
  assert.equal(coin60Mismatch(null, A), null, 'unreadable: nothing to claim');
  assert.equal(coin60Mismatch(A.toUpperCase().replace('0X', '0x'), A), null);
  assert.equal(coin60Mismatch(SELLER, A), SELLER.toLowerCase());
  assert.equal(coin60Mismatch('0x1234', A), '0x1234', 'not even an address still disagrees');

  await doSetAddr();
  assert.deepEqual(sent.map((x) => [...x]), [['setAddr', 7n, A]], 'no stale record, one transaction');

  sent.length = 0;
  set(SELLER.toLowerCase(), false);
  await doSetAddr();
  assert.deepEqual(sent.map((x) => [...x]), [['setAddr', 7n, A], ['setAddrForCoin', 7n, 60n, '0x']]);

  sent.length = 0;
  set(SELLER.toLowerCase(), true);
  await doSetAddr();
  assert.deepEqual(sent, [], 'a batching wallet gets both calls in one approval');
  assert.deepEqual(Array.from(batches(), (b) => Array.from(b, (c) => [...c])), [[['setAddr', 7n, A], ['setAddrForCoin', 7n, 60n, '0x']]]);
});

test('the QR encoder is vendored and encodes exactly like the qrcode package', async () => {
  assert.match(html, /import\("\/vendor\/qrcode\.bundle\.mjs"\)/);
  assert.doesNotMatch(html, /esm\.sh/, 'no unpinned CDN modules');
  const { default: QRCode } = await import('./vendor/qrcode.bundle.mjs');
  // Module hashes from qrcode 1.5.4's own (unbundled, Node) encoder with the dapp's options.
  const expected = [
    ['https://zkpassport.id/r?d=' + 'a1b2c3d4'.repeat(40), 73, '4136e149c2c3664ee26254cb33276b32eabaec654bef05bfd8530ef1523343d1'],
    ['https://gwei.domains/', 25, 'c2f57681a6f3d823a02f6f988af298dc7b4d27fb8aa44a806b467d0b15d355dc'],
  ];
  for (const [url, size, hash] of expected) {
    const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M', margin: 2 });
    assert.equal(modules.size, size);
    assert.equal(require('node:crypto').createHash('sha256').update(modules.data).digest('hex'), hash);
  }
  assert.equal(typeof QRCode.toCanvas, 'function');
  assert.equal(typeof QRCode.toDataURL, 'function');
});

test('name sites are linked under the short gwei.limo domain', () => {
  assert.match(html, /^const GWEI_GATEWAY = 'gwei\.limo';$/m);
  // Every <name>.gwei.domains link goes through GWEI_GATEWAY now; only the diff service is left.
  const left = [...html.matchAll(/[a-z0-9-]+\.gwei\.domains/gi)].map((m) => m[0].toLowerCase());
  assert.deepEqual([...new Set(left)], ['diff.gwei.domains']);
});

test('the Signal username field accepts only Signal-shaped usernames', () => {
  const start = html.indexOf('const SIGNAL_USERNAME');
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, html.indexOf('\n', start)) + '\nglobalThis.re = SIGNAL_USERNAME;', context);
  for (const ok of ['alice.01', 'Alice_.42', '_bob.123', 'a_b.999999999', 'x'.repeat(32) + '.10']) assert.ok(context.re.test(ok), ok);
  for (const bad of ['alice', 'al.42', '1alice.42', 'alice.4', 'alice.00', 'alice.042', 'ali-ce.42', 'alice.1234567890', 'x'.repeat(33) + '.10', 'alice.42 ']) {
    assert.ok(!context.re.test(bad), bad);
  }
  assert.match(html, /\{ key: 'org\.signal', label: 'Signal username', placeholder: 'name\.01' \}/);
  assert.match(html, /next\['org\.signal'\] && !SIGNAL_USERNAME\.test\(next\['org\.signal'\]\)/, 'saving checks it');
});

test('the page is Ethereum only, even for a visitor who once picked Sepolia', () => {
  const start = html.indexOf("const NET_STORAGE_KEY = 'gwei_network';");
  const end = html.indexOf('const ACTIVE_NET', start);
  const store = new Map([['gwei_network', 'sepolia']]);
  const context = vm.createContext({ localStorage: { getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) } });
  vm.runInContext(html.slice(start, end) + '\nglobalThis.picked = pickActiveNetwork();', context);
  assert.equal(context.picked, 'ethereum');
  assert.equal(store.has('gwei_network'), false, 'the old choice is cleared');
  assert.doesNotMatch(html, /id="netBar"|setActiveNetwork|net-pill/, 'no network picker left');
});

test('the stats come from the gateway, and a stats index still catching up is not shown', async () => {
  const start = html.indexOf('async function loadStats()');
  const end = html.indexOf('\n}\n', start) + 3;
  const els = {};
  const el = (id) => (els[id] ||= { id, style: {}, textContent: '', innerHTML: '', children: [], appendChild(c) { this.children.push(c); } });
  const run = async (answer) => {
    for (const k of Object.keys(els)) delete els[k];
    const fetched = [], removed = [];
    const context = vm.createContext({
      CHAIN_ID: 1, POSTS_API: 'https://gwei.domains/api', GWEI_GATEWAY: 'gwei.limo', BigInt, Number, Object, Array,
      document: { getElementById: el, createElement: () => ({}) },
      localStorage: { removeItem: (k) => removed.push(k) },
      nearViewport: async () => {},
      fetch: async (url) => { fetched.push(url); return { ok: true, json: async () => answer }; },
    });
    vm.runInContext(html.slice(start, end) + '\nglobalThis.loadStats = loadStats;', context);
    await context.loadStats();
    return { fetched, removed };
  };
  const { fetched, removed } = await run({ ready: true, names: 4382, subdomains: 120, burnedWei: '1500000000000000000', lengths: { 3: 10, 20: 2 }, sites: ['donnoh', 'reality'] });
  assert.deepEqual(fetched, ['https://gwei.domains/api/stats'], 'one small request, no log scan');
  assert.deepEqual(removed, ['gwei_stats_1'], 'the old scan cache is cleared');
  assert.equal(els.statNames.textContent, (4382).toLocaleString());
  assert.equal(els.statBurned.textContent, '1.50');
  assert.match(els.statsHist.innerHTML, /20\+/);
  assert.deepEqual(els.sitesList.children.map((a) => a.href), ['https://donnoh.gwei.limo', 'https://reality.gwei.limo']);
  assert.equal(els.statsContent.style.display, '');

  await run({ ready: false, names: 3 });
  assert.equal(els.statsSection.style.display, 'none', 'partial counts while the index catches up are hidden');
});

function websiteCheckHarness(fetchImpl) {
  const start = html.indexOf('const IPFS_ROUTING =');
  const end = html.indexOf('const WARN_STYLE =', start);
  const b32 = html.indexOf('function base32Encode(bytes)');
  assert.notEqual(start, -1, 'website check helpers must exist');
  assert.notEqual(end, -1, 'website check helpers must be bounded');
  const context = vm.createContext({
    ethers: { getBytes: (v) => (typeof v === 'string' ? Uint8Array.from(Buffer.from(v.replace(/^0x/, ''), 'hex')) : v) },
    fetch: fetchImpl, AbortSignal,
  });
  const alphabet = html.match(/const BASE32_ALPHABET = [^;]+;/)[0];
  vm.runInContext(
    alphabet + '\n' + html.slice(b32, html.indexOf('\n}\n', b32) + 3) + html.slice(start, end) +
      '\nglobalThis.api = { contenthashRef, websiteOnline };',
    context
  );
  return context.api;
}

test('a website record names what the IPFS network is asked about', () => {
  const { contenthashRef } = websiteCheckHarness();
  // ben.gwei (Ed25519 IPNS key), xav.gwei (RSA key), and an IPFS CID.
  assert.deepEqual({ ...contenthashRef('0xe501017200240801122044ab7266fc5b094a08febc30d6fd1b57ab67a0250a886576b2373416fd27cb89') },
    { kind: 'ipns', ref: 'k51qzi5uqu5dhw7cei5g9dcdgpjg57b0dpanijycw30m54igdc78uprjjmdu2x' });
  assert.deepEqual({ ...contenthashRef('0xe50101721220a1dc5d90d7272c0fd9150414f14c80c71de5d243c2f23165e2ddb495cbbcd05f') },
    { kind: 'ipns', ref: 'k2k4r8ng8uzrtqb5ham8kao889m8qezu96z4w3lpinyqghum43veb6n3' });
  const ipfs = contenthashRef('0xe30101551220' + '58'.repeat(32));
  assert.equal(ipfs.kind, 'ipfs');
  assert.match(ipfs.ref, /^bafkrei[a-z2-7]+$/);
  assert.equal(contenthashRef('0xe40101fa011b20' + 'ab'.repeat(32)), null, 'Swarm is not asked');
  assert.equal(contenthashRef('0x'), null);
});

test('whether a website is online comes from the routing service, and an error is no answer', async () => {
  const answers = [];
  const api = websiteCheckHarness(async (url, init) => {
    answers.push([url, init.headers.accept]);
    if (url.endsWith('/providers/bafnobody')) return new Response(JSON.stringify({ Providers: [] }));
    if (url.endsWith('/providers/bafserved')) return new Response(JSON.stringify({ Providers: [{ ID: 'a' }, { ID: 'b' }] }));
    if (url.endsWith('/ipns/kexpired')) return new Response('not found', { status: 404 });
    if (url.endsWith('/ipns/klive')) return new Response(new Uint8Array([1]));
    throw new TypeError('network down');
  });
  assert.deepEqual({ ...await api.websiteOnline({ kind: 'ipfs', ref: 'bafnobody' }) }, { online: false, providers: 0 });
  assert.deepEqual({ ...await api.websiteOnline({ kind: 'ipfs', ref: 'bafserved' }) }, { online: true, providers: 2 });
  assert.deepEqual({ ...await api.websiteOnline({ kind: 'ipns', ref: 'kexpired' }) }, { online: false, providers: 0 });
  assert.equal((await api.websiteOnline({ kind: 'ipns', ref: 'klive' })).online, true);
  assert.equal(await api.websiteOnline({ kind: 'ipfs', ref: 'bafunreachable' }), null);
  assert.equal(answers[0][0], 'https://delegated-ipfs.dev/routing/v1/providers/bafnobody');
  assert.equal(answers[2][1], 'application/vnd.ipfs.ipns-record', 'IPNS asks for the record itself');
});

test('the Set Website form checks the content as it is typed, and the panel warns when the site is offline', () => {
  assert.match(html, /id="contentHash"[^>]*oninput="scheduleContentCheck\(\)"/);
  assert.match(html, /<div id="contentCheck"><\/div>/);
  assert.match(html, /if \(hasContenthash\) void warnIfWebsiteOffline\(contentHash, isOwner, thisManageVersion\);/);
  assert.doesNotMatch(html.slice(html.indexOf('const IPFS_ROUTING'), html.indexOf('function decodeContenthash(hex)')), /—/, 'no em dashes in the copy');
});
