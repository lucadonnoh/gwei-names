// Which test suites (ci.yml) and deployed parts (deploy.yml) a change touches: prints `<name>=true` or
// `<name>=false` per name, in the format of $GITHUB_OUTPUT, with the reasons on stderr.
//
//   node scripts/ci-changes.mjs <base-commit> [name...]    (the CI suites when no name is given)
//
// A name is true when a file it is built from differs between <base-commit> and HEAD. Everything is
// true when the base is missing or can't be compared (a new branch, history rewritten past it), or when
// the workflows or this script changed. Local imports are followed from each name's entry points, so a
// file that one directory's tests or bundle pull in from another counts as that name's input too.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOLIDITY = ['src/', 'lib/', 'foundry.toml', 'foundry.lock', '.gitmodules'];
// paths: files, or directories ending in '/'. entries: files (or `dir/*.ext`) whose imports count.
export const INPUTS = {
  // CI suites
  contracts: { paths: [...SOLIDITY, 'test/', 'script/'] },
  gateway: { paths: ['gateway/'], entries: ['gateway/*.test.js'] },
  dapp: { paths: ['dapp/'], entries: ['dapp/gweiNS.test.js'] },
  sdk: { paths: ['sdk/', ...SOLIDITY] }, // abi:check compiles NameNFT
  snap: { paths: ['snap/'] },
  poster: { paths: ['posts/poster/', ...SOLIDITY], entries: ['posts/poster/*.mjs'] }, // deploys the contracts on anvil
  image: { paths: ['Dockerfile', 'dapp/', '.railwayignore', 'scripts/check-dapp-image.sh'] }, // the dapp's container
  // gwei-mirror: its tests (which compare it with the gateway's contract settings) and its image.
  mirror: { paths: ['mirror/', 'gateway/wrangler.toml'], entries: ['mirror/*.test.mjs', 'mirror/gwei-mirror.mjs'] },
  // Deployed parts: what the Worker bundles, and what the Dockerfile copies.
  'deploy-gateway': { paths: ['gateway/'], entries: ['gateway/index.js'] },
  'deploy-dapp': { paths: ['dapp/', 'Dockerfile', '.railwayignore', 'scripts/railway-deploy.mjs'] },
};
const SUITES = ['contracts', 'gateway', 'dapp', 'sdk', 'snap', 'poster', 'image', 'mirror'];
const EVERYTHING = ['.github/', 'scripts/ci-changes.mjs'];

const IMPORT = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

// Repo-relative paths of an entry's local imports, followed transitively.
export function localImports(entries, dir = root) {
  const files = entries.flatMap((entry) => {
    const star = /^(.*)\/\*(\.[a-z.]+)$/.exec(entry);
    if (!star) return [entry];
    return readdirSync(join(dir, star[1])).filter((f) => f.endsWith(star[2])).map((f) => `${star[1]}/${f}`);
  });
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !existsSync(join(dir, file))) return;
    seen.add(file);
    if (!/\.(m?js|cjs)$/.test(file)) return;
    for (const m of readFileSync(join(dir, file), 'utf8').matchAll(IMPORT)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (spec.startsWith('./') || spec.startsWith('../')) visit(posix.normalize(posix.join(posix.dirname(file), spec)));
    }
  };
  files.forEach(visit);
  return [...seen];
}

export function affected(changed, names, dir = root) {
  const covers = (paths, file) => paths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
  const everything = changed.find((file) => covers(EVERYTHING, file));
  const result = {};
  for (const name of names) {
    const { paths, entries = [] } = INPUTS[name];
    const inputs = [...paths, ...localImports(entries, dir)];
    const hit = everything || changed.find((file) => covers(inputs, file));
    result[name] = hit || null;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, ...requested] = process.argv.slice(2);
  const names = requested.length ? requested : SUITES;
  for (const name of names) if (!INPUTS[name]) throw new Error(`unknown name ${name}`);
  let changed = null;
  if (/^[0-9a-f]{40}$/.test(base || '')) {
    try {
      changed = execFileSync('git', ['diff', '--name-only', '--no-renames', base, 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(Boolean);
    } catch {}
  }
  if (!changed) console.error(`no usable base (${base || 'none'}): everything runs`);
  else console.error(`${changed.length} files changed since ${base.slice(0, 7)}`);
  const hits = changed ? affected(changed, names) : Object.fromEntries(names.map((n) => [n, 'no base']));
  for (const name of names) {
    console.error(`  ${name}: ${hits[name] ? `yes (${hits[name]})` : 'no'}`);
    console.log(`${name}=${Boolean(hits[name])}`);
  }
}
