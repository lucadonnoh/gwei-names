#!/bin/sh
# Deploys the gateway Worker by hand. CI normally does this after the tests pass on main
# (.github/workflows/deploy.yml); use this only when CI can't.
#
# It refuses a dirty tree or a commit that isn't main's tip, so production never runs code that main
# doesn't have (a deploy from a stale tree would silently undo newer changes). The Worker is tagged
# with the commit, and the script waits until gwei.domains/api/version reports it.
#
#   scripts/deploy-gateway.sh
set -eu
cd "$(dirname "$0")/.."
git fetch -q origin main
if [ -n "$(git status --porcelain)" ]; then echo "refusing: the working tree has uncommitted changes" >&2; exit 1; fi
head=$(git rev-parse HEAD)
tip=$(git rev-parse origin/main)
if [ "$head" != "$tip" ]; then echo "refusing: HEAD $head is not origin/main $tip (push first, or check out main)" >&2; exit 1; fi

(cd gateway && node --test *.test.js)
(cd gateway && npx wrangler deploy --message "$(git log -1 --format='%h %s' | cut -c1-100)" --var "GIT_COMMIT:$head")
node scripts/verify-deploy.mjs "$head" --gateway
