#!/bin/sh
# Every offline test suite, the way CI runs them. A suite whose toolchain or dependencies aren't
# installed here is skipped, and says so; CI runs all of them.
#
#   scripts/test-all.sh
set -u
cd "$(dirname "$0")/.."
root=$(pwd)
failed=""
skipped=""

run() { # name, directory, command...
  name=$1; dir=$2; shift 2
  printf '\n== %s\n' "$name"
  if (cd "$root/$dir" && "$@"); then :; else failed="$failed $name"; fi
}
skip() { printf '\n== %s: skipped (%s)\n' "$1" "$2"; skipped="$skipped $1"; }

run ci-rules . node --test scripts/ci-changes.test.mjs
run gateway gateway node --test *.test.js
run dapp dapp node --test gweiNS.test.js

if command -v forge >/dev/null; then
  run contracts . forge test --no-match-contract 'ForkTest$|^SubdomainRegistrarTest$'
else skip contracts "no forge"; fi

if [ -d sdk/node_modules ]; then
  run sdk sdk sh -c 'pnpm check && pnpm exec tsx --test $(ls src/*.test.ts | grep -v client.test.ts)'
else skip sdk "run: cd sdk && pnpm install --frozen-lockfile"; fi

if [ -d snap/node_modules ]; then
  run snap snap sh -c 'npm test && git diff --exit-code snap.manifest.json'
else skip snap "run: cd snap && npm ci"; fi

python=${POSTER_PYTHON:-python3}
setup=${POSTER_TRUSTED_SETUP:-posts/poster/trusted_setup.txt}
case $setup in /*) ;; *) setup="$root/$setup" ;; esac
if "$python" -c 'import ckzg, coincurve, Crypto' 2>/dev/null && [ -f "$setup" ]; then
  run poster posts/poster env POSTER_TRUSTED_SETUP="$setup" "$python" -m unittest test_poster
else skip poster "needs ckzg, coincurve and pycryptodome (POSTER_PYTHON) and the trusted setup (POSTER_TRUSTED_SETUP)"; fi

printf '\n'
[ -n "$skipped" ] && echo "skipped:$skipped"
if [ -n "$failed" ]; then echo "FAILED:$failed"; exit 1; fi
echo "all suites that ran passed"
