#!/bin/sh
# Deploys the publisher (this directory) to eth-node: backs up its database, installs the code,
# rebuilds the image, restarts the container and prints its status. Approve an eth-node SSH window
# first (homelab-unlock ... --hosts eth-node).
#
#   posts/poster/deploy.sh                                   new code, same contract and database
#   posts/poster/deploy.sh --contract 0x... --from-block N   switch to another GnsPosts deployment
#   posts/poster/deploy.sh --dry-run [...]                   print the remote script, change nothing
#
# A contract switch also starts a fresh database: the cursor, jobs and blobs belong to one deployment
# (gwei_poster.py refuses a database bound to another contract). The old one is kept next to it.
# Switch the gateway and the dapp first: until they point at the new contract, payments still go to
# the old one, and only the old poster delivers them.
set -eu
cd "$(dirname "$0")"
HOST=${POSTER_HOST:-eth-node}
contract="" from_block="" dry_run=""
while [ $# -gt 0 ]; do
  case $1 in
    --contract) contract=$2; shift 2 ;;
    --from-block) from_block=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$contract$from_block" ]; then
  echo "$contract" | grep -Eq '^0x[0-9a-fA-F]{40}$' || { echo "--contract needs an address" >&2; exit 2; }
  echo "$from_block" | grep -Eq '^[0-9]+$' || { echo "--from-block needs a block number" >&2; exit 2; }
fi

files="gwei_poster.py Dockerfile docker-compose.yml requirements.txt"
sums=$(shasum -a 256 $files)

# Runs on eth-node. Stops at the first failure, before the container is touched if a check fails.
remote=$(cat <<EOF
set -eu
cd /opt/gwei-poster
ts=\$(date -u +%Y%m%d-%H%M%S)
data=/var/lib/gwei-poster
pending=\$(sudo docker exec gwei-poster python -c "import sqlite3; print(sqlite3.connect('file:/data/poster.db?mode=ro', uri=True).execute(\"SELECT count(*) FROM txs WHERE status = 'pending'\").fetchone()[0])")
[ "\$pending" = 0 ] || { echo "refusing: \$pending publisher transactions still pending"; exit 1; }
echo "$sums" | (cd /tmp/gwei-poster-deploy && sha256sum -c --quiet)
sudo docker exec gwei-poster python -c "import sqlite3; sqlite3.connect('/data/poster.db').backup(sqlite3.connect('/data/poster.db.bak-\$ts'))"
echo "backed up the database to \$data/poster.db.bak-\$ts"
for f in $files; do
  [ -f "\$f" ] && sudo cp -a "\$f" "\$f.bak-\$ts"
  sudo install -o root -g root -m 644 "/tmp/gwei-poster-deploy/\$f" "\$f"
done
rm -rf /tmp/gwei-poster-deploy
if [ -n "$contract" ]; then
  sudo cp -a .env ".env.bak-\$ts"
  sudo sed -i "s/^POSTER_CONTRACT=.*/POSTER_CONTRACT=$contract/; s/^POSTER_FROM_BLOCK=.*/POSTER_FROM_BLOCK=$from_block/" .env
fi
sudo grep -E '^POSTER_(CONTRACT|FROM_BLOCK)=' .env
sudo docker compose build -q
if [ -n "$contract" ]; then
  sudo docker stop gwei-poster >/dev/null
  sudo mv "\$data/poster.db" "\$data/poster.db.before-$contract-\$ts"
fi
sudo docker compose up -d
sleep 20
sudo docker logs --since 1m gwei-poster 2>&1 | tail -5
sudo docker exec gwei-poster python /opt/gwei-poster/gwei_poster.py status
EOF
)

if [ -n "$dry_run" ]; then
  echo "# would copy: $files -> $HOST:/tmp/gwei-poster-deploy/"
  echo "$remote"
  exit 0
fi
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true 2>/dev/null || {
  echo "can't reach $HOST over SSH: approve a window first (homelab-unlock 20 --hosts eth-node)" >&2; exit 1; }
ssh -o BatchMode=yes "$HOST" 'rm -rf /tmp/gwei-poster-deploy && mkdir -m 700 /tmp/gwei-poster-deploy'
scp -o BatchMode=yes -q $files "$HOST:/tmp/gwei-poster-deploy/"
ssh -o BatchMode=yes "$HOST" "$remote"
