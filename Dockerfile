# Serves the GNS dapp (static files) for Railway / any container host. nginx, for what busybox httpd
# couldn't send: cache headers, ETags and 304s (dapp/nginx.conf.template). Railway injects $PORT at
# runtime; local default 8080.
FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951
COPY dapp/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=8080
COPY dapp/gweiNS.html /usr/share/nginx/html/index.html
COPY dapp/guide.html /usr/share/nginx/html/guide/index.html
COPY dapp/vendor /usr/share/nginx/html/vendor
COPY dapp/favicon.ico /usr/share/nginx/html/favicon.ico
COPY dapp/apple-touch-icon.png /usr/share/nginx/html/apple-touch-icon.png
COPY dapp/icon-192.png /usr/share/nginx/html/icon-192.png
COPY dapp/icon-512.png /usr/share/nginx/html/icon-512.png
# Link-preview cards (1200x630), drawn by gateway/ops/render-dapp-cards.mjs.
COPY dapp/og-card.png /usr/share/nginx/html/og-card.png
COPY dapp/og-card-guide.png /usr/share/nginx/html/og-card-guide.png
COPY dapp/manifest.json /usr/share/nginx/html/manifest.json
# The image's own welcome page and 50x page aren't the dapp's.
RUN rm -f /usr/share/nginx/html/50x.html
# The commit being served, at /version.txt, so a deploy can be verified (Railway passes this build arg).
ARG RAILWAY_GIT_COMMIT_SHA=unknown
RUN printf '%s\n' "$RAILWAY_GIT_COMMIT_SHA" > /usr/share/nginx/html/version.txt
EXPOSE 8080
