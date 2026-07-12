import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
  },
  webServer: [
    {
      command: "tsx tests/mock-gns-rpc.ts",
      url: "http://127.0.0.1:8546",
      reuseExistingServer: false,
    },
    {
      command: "PORT=8791 BATCH_INTERVAL_MS=250 ONCHAIN_PUBLISH=0 tsx server.ts",
      url: "http://127.0.0.1:8791/health",
      reuseExistingServer: false,
    },
    {
      command: "PORT=8792 BATCH_INTERVAL_MS=250 ONCHAIN_PUBLISH=0 ADMISSION_REQUIRED=1 ADMISSION_RPC_URL=http://127.0.0.1:8546 ADMISSION_DATABASE=:memory: ADMISSION_SIWE_DOMAIN=127.0.0.1:5174 ADMISSION_SIWE_URI=http://127.0.0.1:5174/ tsx server.ts",
      url: "http://127.0.0.1:8792/health",
      reuseExistingServer: false,
    },
    {
      command: "RELAY_PROXY_TARGET=http://127.0.0.1:8791 vite --host 127.0.0.1 --port 5174",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
    },
  ],
});
