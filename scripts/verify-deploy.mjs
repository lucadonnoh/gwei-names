// Waits until production serves <commit>, then smoke-tests it. Exits non-zero (with the reason) if
// the gateway or the dapp is still on another commit after the timeout, or a page is broken.
//
//   node scripts/verify-deploy.mjs <commit-sha> [--gateway] [--dapp]   (both when neither is given)
//
// The gateway reports its commit at gwei.domains/api/version, the dapp at gwei.domains/version.txt.

const TIMEOUT_MS = 10 * 60 * 1000;
const args = process.argv.slice(2);
const sha = args.find((a) => !a.startsWith('--'));
if (!/^[0-9a-f]{40}$/.test(sha || '')) {
  console.error('usage: node scripts/verify-deploy.mjs <full commit sha> [--gateway] [--dapp]');
  process.exit(2);
}
const only = new Set(args.filter((a) => a.startsWith('--')));
const want = (part) => only.size === 0 || only.has(`--${part}`);

async function get(url) {
  // A fresh query string on every poll, so no cache in between can answer with an old copy.
  const bust = `${url.includes('?') ? '&' : '?'}verify=${Date.now()}`;
  const res = await fetch(url + bust, { headers: { 'user-agent': 'gwei-names-deploy-check' }, redirect: 'manual' });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const checks = [];
const read = (url, parse) => async () => {
  const r = await get(url);
  return r.status === 200 ? parse(r.text) : `HTTP ${r.status}`;
};
if (want('gateway')) checks.push(['gateway', read('https://gwei.domains/api/version', (t) => JSON.parse(t).commit)]);
if (want('dapp')) checks.push(['dapp', read('https://gwei.domains/version.txt', (t) => t.trim())]);

const deadline = Date.now() + TIMEOUT_MS;
const pending = new Map(checks);
const seen = {};
while (pending.size && Date.now() < deadline) {
  for (const [part, read] of pending) {
    const live = await read().catch((error) => `error: ${error.message}`);
    if (live !== seen[part]) console.log(`${part}: ${live}`);
    seen[part] = live;
    if (live === sha) pending.delete(part);
  }
  if (pending.size) await new Promise((resolve) => setTimeout(resolve, 10_000));
}
if (pending.size) {
  for (const part of pending.keys()) console.error(`${part} still serves ${seen[part]} after ${TIMEOUT_MS / 60000} minutes, not ${sha}`);
  process.exit(1);
}

// The live pages a deploy must not break.
const smoke = [
  ['https://gwei.domains/', (r) => r.status === 200 && r.text.includes('og:title')],
  ['https://gwei.domains/api/posts/recent', (r) => r.status === 200 && Array.isArray(JSON.parse(r.text).posts)],
  ['https://donnoh.gwei.limo/', (r) => r.status === 200 && r.text.includes('<title>donnoh.gwei')],
  ['https://donnoh.gwei.domains/', (r) => r.status === 200],
  ['https://gwei.limo/', (r) => r.status === 302 && (r.headers.get('location') || '').startsWith('https://gwei.domains/?')],
];
let broken = 0;
for (const [url, ok] of smoke) {
  const r = await get(url).catch((error) => ({ status: 0, text: String(error), headers: new Headers() }));
  let pass = false;
  try { pass = ok(r); } catch {}
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${url} (${r.status})`);
  if (!pass) broken++;
}
if (broken) process.exit(1);
console.log(`production serves ${sha.slice(0, 7)}`);
