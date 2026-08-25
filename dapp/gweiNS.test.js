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

test('integration voting is enabled only for the verified Sepolia deployment', () => {
  const start = html.indexOf('const NETWORKS = {');
  const end = html.indexOf('const NET_STORAGE_KEY', start);
  assert.notEqual(start, -1, 'network configuration must exist');
  assert.notEqual(end, -1, 'network configuration must be bounded');

  const context = vm.createContext({});
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.networks = NETWORKS;',
    context
  );

  assert.equal(context.networks.ethereum.voting, null);
  assert.equal(context.networks.ethereum.votingDeployBlock, null);
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
  assert.match(
    html,
    /const VOTING_ENABLED = Boolean\(VOTING_CONTRACT && VOTING_DEPLOY_BLOCK\);/
  );
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
  const context = vm.createContext({ console });
  vm.runInContext(
    html.slice(start, end) + `
      globalThis.votingApi = {
        votingPowerForLabelLength,
        normalizeVotingAllocations,
        sumVotingAllocations,
        votingAllocationsEqual,
        aggregateVotingAllocations,
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
    VOTING_ENABLED: true,
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
    votes: [3]
  };
  const known = { '0xaaa': 'ambire' };
  const tally = (record, now = 1000) =>
    computeVotingTallies([ballot], { 1: record }, known, now).ambire || 0;
  const active = { label: 'alice', parent: '0', expiresAt: 1000, epoch: '7', owner: '0xalice' };

  assert.equal(tally(active), 3, 'the exact expiry timestamp is still active');
  assert.equal(tally({ ...active, owner: '0xbob' }), 0, 'transfer-away stops the old ballot');
  assert.equal(tally(active), 3, 'transfer-back in the same epoch revives it');
  assert.equal(tally({ ...active, expiresAt: 999 }), 0, 'expiry stops it');
  assert.equal(tally({ ...active, expiresAt: 2000 }), 3, 'renewal in the same epoch revives it');
  assert.equal(tally({ ...active, epoch: '8' }), 0, 're-registration cannot revive an old ballot');
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

function votingRangeHarness(votingGetLogs) {
  const start = html.indexOf('async function scanVotingRanges(');
  const end = html.indexOf('function votingLogPosition(log)', start);
  assert.notEqual(start, -1, 'voting range scanner must exist');
  assert.notEqual(end, -1, 'voting range scanner must be bounded');
  const context = vm.createContext({ votingGetLogs });
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.scanVotingRanges = scanVotingRanges;',
    context
  );
  return context.scanVotingRanges;
}

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

test('voting ownership discovery retries capped ranges sequentially', async () => {
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
    [0, 9000],
    [9001, 18001],
    [18002, 20000]
  ]);
  assert.equal(maxActive, 1, 'fallback requests must not create an RPC burst');
  assert.deepEqual(consumed, [
    { fromBlock: 0, toBlock: 9000 },
    { fromBlock: 9001, toBlock: 18001 },
    { fromBlock: 18002, toBlock: 20000 }
  ]);
});

test('voting caches invalidate incomplete historical RPC results', () => {
  assert.match(html, /const VOTING_BALLOT_CACHE_VERSION = 3;/);
  assert.match(html, /const VOTING_OWNED_CACHE_VERSION = 2;/);
  assert.match(html, /stored\?\.version === VOTING_BALLOT_CACHE_VERSION/);
  assert.match(html, /stored\?\.version === VOTING_OWNED_CACHE_VERSION/);
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
  assert.match(html, /\.int-power-list\.show \{ display: block; \}/);
  assert.match(html, /power\.classList\.toggle\('show', show\);/);
  assert.match(html, /list\.classList\.toggle\('show', show\);/);
  assert.match(html, /details\.open = false;/);
  assert.match(
    html,
    /summary\.textContent = `\$\{ownedVotingNames\.length\} \$\{nameWord\} · \$\{formatVoteCount\(votingTotalPower\)\} \$\{voteWord\}`;/
  );
});

test('the signing dock appears only after the voter changes an allocation', () => {
  assert.match(
    html,
    /const showDock = VOTING_ENABLED && votingReady && ownedVotingNames\.length > 0 && votingDraftDirty\(\);/
  );
  assert.match(html, /dock\.classList\.toggle\('show', showDock\);/);
  assert.match(html, /dock\.setAttribute\('aria-hidden', String\(!showDock\)\);/);
  assert.match(html, /dock\.inert = !showDock;/);
});

test('vote characters are centered without inherited button letter spacing', () => {
  assert.match(
    html,
    /\.int-vote button \{[^}]*display: inline-flex;[^}]*align-items: center;[^}]*justify-content: center;[^}]*letter-spacing: 0;/
  );
  assert.match(html, /\.int-vote\.has-own \.int-vote-minus \{ display: inline-flex; \}/);
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
