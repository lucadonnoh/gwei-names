# Serves the GNS dapp (a single static HTML file) for Railway / any container host.
# Railway injects $PORT at runtime; busybox httpd binds it. Local default: 8080.
FROM busybox:1.37
COPY dapp/gweiNS.html /www/index.html
COPY dapp/guide.html /www/guide/index.html
COPY dapp/vendor /www/vendor
# busybox httpd has no built-in type for .mjs, and browsers refuse a module served without one.
COPY dapp/httpd.conf /etc/httpd.conf
COPY dapp/favicon.ico /www/favicon.ico
COPY dapp/apple-touch-icon.png /www/apple-touch-icon.png
COPY dapp/icon-192.png /www/icon-192.png
COPY dapp/icon-512.png /www/icon-512.png
COPY dapp/manifest.json /www/manifest.json
EXPOSE 8080
CMD ["sh", "-c", "httpd -f -v -p ${PORT:-8080} -h /www"]
