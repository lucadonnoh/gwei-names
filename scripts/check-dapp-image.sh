#!/bin/sh
# Checks a running dapp image (the root Dockerfile) serves what browsers and the deploy check rely on:
# types, cache headers, ETags and 304s, the pages and the commit stamp. CI builds the image, starts it
# and runs this against it.
#
#   scripts/check-dapp-image.sh http://localhost:8080 <commit-sha>
set -u
base=$1 sha=$2 failed=0
header() { curl -sS -o /dev/null -D - "$@" | tr -d '\r'; }
expect() { # description, value, pattern
  if printf '%s' "$2" | grep -Eiq "$3"; then echo "ok    $1"; else echo "FAIL  $1: got $(printf '%s' "$2" | head -c 300)"; failed=1; fi
}

h=$(header "$base/")
expect "/ is UTF-8 HTML" "$h" 'content-type: text/html; charset=utf-8'
expect "/ is revalidated" "$h" 'cache-control: no-cache'
etag=$(printf '%s' "$h" | sed -n 's/^[Ee][Tt][Aa][Gg]: //p')
expect "/ has an ETag" "$etag" '.'
expect "/ answers 304 to its ETag" "$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$base/")" '^304$'
expect "/ is the dapp" "$(curl -sS "$base/")" 'Gwei Name Service'
expect "/guide/ answers" "$(curl -sS -o /dev/null -w '%{http_code}' "$base/guide/")" '^200$'
expect "/guide/ is the guide" "$(curl -sS "$base/guide/")" 'yourname\.gwei'
h=$(header "$base/vendor/kzg.bundle.mjs")
expect ".mjs is JavaScript" "$h" 'content-type: text/javascript'
expect ".mjs is revalidated" "$h" 'cache-control: no-cache'
chunk=$(ls dapp/vendor | grep -E -- '-[A-Z0-9]{8}\.js$' | head -1)
expect "hashed chunks are immutable ($chunk)" "$(header "$base/vendor/$chunk")" 'cache-control: public, max-age=31536000, immutable'
expect "entry.js is revalidated" "$(header "$base/vendor/entry.js")" 'cache-control: no-cache'
h=$(header "$base/og-card.png")
expect "images are PNG" "$h" 'content-type: image/png'
expect "images are kept a day" "$h" 'cache-control: public, max-age=86400'
expect "version.txt is the commit" "$(curl -sS "$base/version.txt")" "^$sha$"
expect "no stray files" "$(curl -sS -o /dev/null -w '%{http_code}' "$base/50x.html") $(curl -sS -o /dev/null -w '%{http_code}' "$base/nginx.conf.template")" '^404 404$'
exit $failed
