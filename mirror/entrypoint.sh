#!/bin/bash
# The Docker image's entry point: start the container's IPFS node (set up on first run), wait for its
# API, then run gwei-mirror against it. Arguments go to gwei-mirror. If either process stops, so does
# the container, and Docker's restart policy brings both back.
set -euo pipefail
if [ ! -f "$IPFS_PATH/config" ]; then
  # `server`: no local-network discovery, no announcing private addresses. The API and the HTTP
  # gateway stay inside the container.
  ipfs init --profile server
  ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
  ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080
fi
ipfs daemon --migrate &
daemon=$!
for _ in $(seq 1 120); do
  ipfs --api /ip4/127.0.0.1/tcp/5001 id > /dev/null 2>&1 && break
  kill -0 "$daemon" 2> /dev/null || { echo "the IPFS node failed to start" >&2; exit 1; }
  sleep 1
done
node /app/mirror/gwei-mirror.mjs --ipfs http://127.0.0.1:5001 "$@" &
mirror=$!
trap 'kill -TERM "$daemon" "$mirror" 2> /dev/null' TERM INT
status=0
wait -n "$daemon" "$mirror" || status=$?
kill -TERM "$daemon" "$mirror" 2> /dev/null || true
wait || true
exit "$status"
