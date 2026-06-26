# Serves the gwei-names contract diff page (static HTML) for Railway / any container host.
# Built with diff/ as the root context (railway up diff --path-as-root). Railway injects $PORT.
FROM busybox:1.37
COPY index.html /www/index.html
EXPOSE 8080
CMD ["sh", "-c", "httpd -f -v -p ${PORT:-8080} -h /www"]
