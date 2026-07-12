import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const relayProxyTarget = process.env.RELAY_PROXY_TARGET || "http://127.0.0.1:8790";

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
    "style-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:* ws: wss:; " +
    "img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; " +
    "frame-ancestors 'none'; trusted-types 'none'; require-trusted-types-for 'script'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "publickey-credentials-create=(self), publickey-credentials-get=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default defineConfig({
  resolve: {
    alias: {
      buffer: "buffer/",
      crypto: fileURLToPath(new URL("./src/browser-crypto.ts", import.meta.url)),
    },
  },
  server: {
    headers: securityHeaders,
    proxy: {
      "/relay": {
        target: relayProxyTarget,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/relay/u, ""),
      },
    },
  },
  preview: {
    headers: securityHeaders,
  },
});
