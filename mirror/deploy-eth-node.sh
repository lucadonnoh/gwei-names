#!/bin/sh
# Deploys gwei-mirror to eth-node, next to its Kubo: installs the files the image is built from,
# rebuilds it, restarts the container and prints its log. Approve an eth-node SSH window first
# (homelab-unlock ... --hosts eth-node).
#
#   mirror/deploy-eth-node.sh            deploy
#   mirror/deploy-eth-node.sh --dry-run  print the remote script, change nothing
set -eu
cd "$(dirname "$0")/.."
HOST=${MIRROR_HOST:-eth-node}
dry_run=""
[ "${1:-}" = --dry-run ] && dry_run=1
files="gateway/posts-format.js gateway/web3-auto.js gateway/rpc-config.js dapp/vendor/kzg.bundle.mjs
mirror/mirror.mjs mirror/gwei-mirror.mjs mirror/entrypoint.sh mirror/Dockerfile mirror/Dockerfile.dockerignore mirror/eth-node.compose.yml"
sums=$(shasum -a 256 $files)

# Runs on eth-node. Stops at the first failure.
remote=$(cat <<EOS
set -eu
echo "$sums" | (cd /tmp/gwei-mirror-deploy && sha256sum -c --quiet)
sudo mkdir -p /opt/gwei-mirror /var/lib/gwei-mirror
sudo chown 1000:1000 /var/lib/gwei-mirror # the image runs as node (uid 1000)
for f in $(echo $files); do
  sudo install -D -o root -g root -m 644 "/tmp/gwei-mirror-deploy/\$f" "/opt/gwei-mirror/\$f"
done
sudo chmod 755 /opt/gwei-mirror/mirror/entrypoint.sh /opt/gwei-mirror/mirror/gwei-mirror.mjs
sudo mv /opt/gwei-mirror/mirror/eth-node.compose.yml /opt/gwei-mirror/docker-compose.yml
rm -rf /tmp/gwei-mirror-deploy
cd /opt/gwei-mirror
sudo docker compose build -q
sudo docker compose up -d
sleep 20
sudo docker logs --since 1m gwei-mirror 2>&1 | tail -12
EOS
)

if [ -n "$dry_run" ]; then
  echo "# would copy: $(echo $files) -> $HOST:/tmp/gwei-mirror-deploy/"
  echo "$remote"
  exit 0
fi
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true 2>/dev/null || {
  echo "can't reach $HOST over SSH: approve a window first (homelab-unlock 20 --hosts eth-node)" >&2; exit 1; }
ssh -o BatchMode=yes "$HOST" 'rm -rf /tmp/gwei-mirror-deploy && mkdir -m 700 /tmp/gwei-mirror-deploy'
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -cf - $files | ssh -o BatchMode=yes "$HOST" 'tar -xf - -C /tmp/gwei-mirror-deploy'
ssh -o BatchMode=yes "$HOST" "$remote"
