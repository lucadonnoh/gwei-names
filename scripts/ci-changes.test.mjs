// Which suites and deployed parts a change runs (scripts/ci-changes.mjs). CI runs this before using it.
//   node --test scripts/ci-changes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUTS, affected } from './ci-changes.mjs';

const ALL = Object.keys(INPUTS);
const runs = (...changed) => Object.entries(affected(changed, ALL)).filter(([, hit]) => hit).map(([name]) => name).sort();

test('a change runs the suites built from it, and deploys the parts that ship it', () => {
  assert.deepEqual(runs('README.md', 'DEPLOY.md', 'audit/report.md'), [], 'docs run nothing');
  assert.deepEqual(runs('gateway/markdown.js'), ['deploy-gateway', 'gateway']);
  assert.deepEqual(runs('gateway/worker.test.js'), ['deploy-gateway', 'gateway']);
  assert.deepEqual(runs('dapp/gweiNS.html'), ['dapp', 'deploy-dapp']);
  assert.deepEqual(runs('Dockerfile'), ['deploy-dapp']);
  assert.deepEqual(runs('test/NameNFT.t.sol'), ['contracts']);
  assert.deepEqual(runs('src/NameNFT.sol'), ['contracts', 'poster', 'sdk']);
  assert.deepEqual(runs('lib/solady'), ['contracts', 'poster', 'sdk'], 'a submodule bump');
  assert.deepEqual(runs('foundry.toml'), ['contracts', 'poster', 'sdk']);
  assert.deepEqual(runs('sdk/src/index.ts'), ['sdk']);
  assert.deepEqual(runs('snap/src/index.ts'), ['snap']);
  assert.deepEqual(runs('posts/poster/gwei_poster.py'), ['poster']);
});

test('files another directory imports count for it', () => {
  // gweiNS.test.js imports posts-format.js, which imports web3-auto.js; the poster runs the post index.
  assert.deepEqual(runs('gateway/posts-format.js'), ['dapp', 'deploy-gateway', 'gateway', 'poster']);
  assert.deepEqual(runs('gateway/web3-auto.js'), ['dapp', 'deploy-gateway', 'gateway', 'poster']);
  assert.deepEqual(runs('gateway/posts-store.js'), ['deploy-gateway', 'gateway', 'poster']);
  assert.deepEqual(runs('gateway/rpc-pool.js'), ['deploy-gateway', 'gateway', 'poster']);
  // The Worker bundles the dapp's KZG; the gateway's and poster's tests run it.
  assert.deepEqual(runs('dapp/vendor/kzg.bundle.mjs'), ['dapp', 'deploy-dapp', 'deploy-gateway', 'gateway', 'poster']);
  assert.deepEqual(runs('dapp/vendor/entry.js'), ['dapp', 'deploy-dapp']);
});

test('a workflow change, or one to the rules themselves, runs everything', () => {
  assert.deepEqual(runs('.github/workflows/ci.yml'), ALL.slice().sort());
  assert.deepEqual(runs('scripts/ci-changes.mjs'), ALL.slice().sort());
});
