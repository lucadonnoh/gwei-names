# gwei-mirror with its own IPFS node (Kubo), in one container. Build from the repository root:
#   docker build -f mirror/Dockerfile -t gwei-mirror .
#   docker run -d --name gwei-mirror --restart unless-stopped -p 4001:4001 -p 4001:4001/udp -v gwei-mirror:/data gwei-mirror
# CI publishes it as ghcr.io/lucadonnoh/gwei-mirror (amd64 and arm64).
FROM ipfs/kubo:v0.43.1@sha256:b293923d66e490e70ced64df42ea7a6cf7eac2740e3fb29101df18070fa7be48 AS kubo

FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
COPY --from=kubo /usr/local/bin/ipfs /usr/local/bin/ipfs
# The mirror and the repository files it imports, at the same relative paths.
COPY gateway/posts-format.js gateway/web3-auto.js gateway/rpc-config.js /app/gateway/
COPY dapp/vendor/kzg.bundle.mjs /app/dapp/vendor/
COPY mirror/mirror.mjs mirror/gwei-mirror.mjs mirror/entrypoint.sh /app/mirror/
RUN mkdir /data && chown node:node /data
USER node
ENV IPFS_PATH=/data/ipfs GWEI_MIRROR_STATE=/data/state.json
VOLUME /data
# IPFS peers (TCP and QUIC): open it so other nodes can fetch the posts from this one.
EXPOSE 4001 4001/udp
ENTRYPOINT ["/app/mirror/entrypoint.sh"]
LABEL org.opencontainers.image.source=https://github.com/lucadonnoh/gwei-names \
      org.opencontainers.image.description="Keep a copy of every .gwei post on IPFS" \
      org.opencontainers.image.licenses=MIT
