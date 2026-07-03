# Serves the GNS dapp (a single static HTML file) for Railway / any container host.
# Railway injects $PORT at runtime; busybox httpd binds it. Local default: 8080.
FROM busybox:1.37
COPY dapp/gweiNS.html /www/index.html
COPY dapp/guide.html /www/guide/index.html
COPY dapp/vendor /www/vendor
EXPOSE 8080
CMD ["sh", "-c", "httpd -f -v -p ${PORT:-8080} -h /www"]
