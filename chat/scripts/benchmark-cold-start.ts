import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { arch, cpus, platform } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import type { Browser, CDPSession, Page } from "@playwright/test";
import { hexlify } from "ethers";
import { createServer as createViteServer } from "vite";

import {
  BLOB_SIZE,
  CONTENT_TAG,
  ENVELOPES_PER_BLOB,
  FIELD_ELEMENTS_PER_BLOB,
  packEnvelopeSlots,
} from "../src/blob-batch";
import { dummyEnvelope, ENVELOPE_SIZE } from "../src/envelope";
import { erc8179Interface } from "../src/onchain/erc8179";

const CHAIN_ID = 11_155_111n;
const CONTRACT_ADDRESS = "0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314";
const DECLARER = "0x000000000000000000000000000000000000bEEF";
const BASE_BLOCK = 1_000;
const BLOBS_PER_BLOCK = 6;
const SECONDS_PER_SLOT = 12;
const SLOTS_PER_EPOCH = 32;
const DEFAULT_BLOBS = 100;
const DEFAULT_PAGE_SIZE = 8;
const DEFAULT_FETCH_CONCURRENCY = 4;

type StorageMode = "development" | "vault";

interface Options {
  blobs: number;
  pendingRequests: number;
  storage: StorageMode;
  pageSize: number;
  beaconLatencyMs: number;
  beaconMbps: number;
  cpuThrottle: number;
}

interface FixtureLog {
  address: string;
  blockHash: string;
  blockNumber: string;
  data: string;
  logIndex: string;
  removed: false;
  topics: string[];
  transactionHash: string;
  transactionIndex: string;
}

interface Fixture {
  blob: Uint8Array;
  beaconBody: Buffer;
  versionedHash: string;
  logs: FixtureLog[];
  finalizedBlock: number;
}

interface TimingSummary {
  count: number;
  totalMs: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

interface ColdStartResult {
  totalMs: number;
  list: TimingSummary;
  fetchAndDecode: TimingSummary;
  fetchWindows: TimingSummary;
  unpack: TimingSummary;
  hash: TimingSummary;
  receive: TimingSummary;
  cursor: TimingSummary;
  eventLoopDelay: TimingSummary;
  firstBlobMs: number | null;
  blobsFetched: number;
  slotsScanned: number;
  acceptedEvents: number;
  rawBlobBytes: number;
  beaconJsonBytes: number;
  finalCursor: number;
  jsHeapBefore: number | null;
  jsHeapAfter: number | null;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function integerArgument(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = argument(name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function numberArgument(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = argument(name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be a number from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function optionsFromArguments(): Options {
  if (process.argv.includes("--help")) {
    console.log(`Usage: npm run bench:cold-start -- [options]

  --blobs=N              Blob declarations in the availability window (default ${DEFAULT_BLOBS})
  --pending=N            Locally initiated handshakes waiting for offers, 0-32 (default 0)
  --storage=MODE         vault or development (default vault)
  --page-size=N          Onchain discovery page size, 1-32 (default ${DEFAULT_PAGE_SIZE})
  --beacon-latency-ms=N  Fixed latency before every Beacon response (default 0)
  --beacon-mbps=N        Beacon response throughput; 0 means unthrottled (default 0)
  --cpu-throttle=N       Chromium CPU throttle multiplier, 1-20 (default 1)

The simulator uses the real OnchainBlobSource, trusted Beacon JSON/hex decoding,
blob codec, SHA-256 transport IDs, protocol trial decryption, IndexedDB vault, and cursors.`);
    process.exit(0);
  }

  const storage = argument("storage") ?? "vault";
  if (storage !== "vault" && storage !== "development") {
    throw new Error("--storage must be vault or development");
  }
  return {
    blobs: integerArgument("blobs", DEFAULT_BLOBS, 1, 100_000),
    pendingRequests: integerArgument("pending", 0, 0, 32),
    storage,
    pageSize: integerArgument("page-size", DEFAULT_PAGE_SIZE, 1, 32),
    beaconLatencyMs: numberArgument("beacon-latency-ms", 0, 0, 60_000),
    beaconMbps: numberArgument("beacon-mbps", 0, 0, 100_000),
    cpuThrottle: numberArgument("cpu-throttle", 1, 1, 20),
  };
}

function hexQuantity(value: number | bigint): string {
  return `0x${BigInt(value).toString(16)}`;
}

function fixedHash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function blockNumber(value: unknown, finalizedBlock: number): number {
  if (value === "latest" || value === "finalized" || value === "safe") return finalizedBlock;
  if (value === "earliest") return 0;
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) return 0;
  return Number(BigInt(value));
}

function blockResponse(number: number): Record<string, unknown> {
  const hash = fixedHash(number + 10_000_000);
  return {
    baseFeePerGas: "0x1",
    blobGasUsed: "0x0",
    difficulty: "0x0",
    excessBlobGas: "0x0",
    extraData: "0x",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    hash,
    logsBloom: `0x${"00".repeat(256)}`,
    miner: "0x0000000000000000000000000000000000000000",
    mixHash: fixedHash(number + 20_000_000),
    nonce: "0x0000000000000000",
    number: hexQuantity(number),
    parentHash: fixedHash(Math.max(0, number - 1) + 10_000_000),
    receiptsRoot: fixedHash(31),
    sha3Uncles: fixedHash(32),
    size: "0x1",
    stateRoot: fixedHash(33),
    timestamp: hexQuantity(number * SECONDS_PER_SLOT),
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: fixedHash(34),
    uncles: [],
    withdrawals: [],
    withdrawalsRoot: fixedHash(35),
  };
}

async function createFixture(blobCount: number): Promise<Fixture> {
  console.error("cold-start fixture: generating one canonical dummy blob");
  const seed = await dummyEnvelope();
  const slots = Array.from({ length: ENVELOPES_PER_BLOB }, (_, index) => {
    const slot = seed.slice();
    new DataView(slot.buffer).setUint32(ENVELOPE_SIZE - 4, index, false);
    return slot;
  });
  const blob = packEnvelopeSlots(slots);
  const digest = createHash("sha256").update(blob).digest();
  digest[0] = 1;
  const versionedHash = hexlify(digest);
  const beaconBody = Buffer.from(JSON.stringify({
    execution_optimistic: false,
    finalized: true,
    data: [hexlify(blob)],
  }));
  const event = erc8179Interface.getEvent("BlobSegmentDeclared");
  if (!event) throw new Error("ERC-8179 declaration event is unavailable");
  const logs = Array.from({ length: blobCount }, (_, index): FixtureLog => {
    const block = BASE_BLOCK + Math.floor(index / BLOBS_PER_BLOCK);
    const logIndex = index % BLOBS_PER_BLOCK;
    const encoded = erc8179Interface.encodeEventLog(event, [
      versionedHash,
      DECLARER,
      0,
      FIELD_ELEMENTS_PER_BLOB,
      CONTENT_TAG,
    ]);
    return {
      address: CONTRACT_ADDRESS,
      blockHash: fixedHash(block + 10_000_000),
      blockNumber: hexQuantity(block),
      data: encoded.data,
      logIndex: hexQuantity(logIndex),
      removed: false,
      topics: encoded.topics,
      transactionHash: fixedHash(index + 1),
      transactionIndex: "0x0",
    };
  });
  return {
    blob,
    beaconBody,
    versionedHash,
    logs,
    finalizedBlock: BASE_BLOCK + Math.ceil(blobCount / BLOBS_PER_BLOCK),
  };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function headers(contentType = "application/json"): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "content-type": contentType,
  };
}

function sendThrottled(
  response: ServerResponse,
  body: Buffer,
  contentType: string,
  options: Pick<Options, "beaconLatencyMs" | "beaconMbps">,
): void {
  response.writeHead(200, {
    ...headers(contentType),
    "content-length": String(body.length),
  });
  const begin = () => {
    if (options.beaconMbps === 0) {
      response.end(body);
      return;
    }
    const tickMs = 20;
    const bytesPerTick = Math.max(
      1,
      Math.floor(options.beaconMbps * 1_000_000 / 8 * tickMs / 1_000),
    );
    let offset = 0;
    const write = () => {
      const end = Math.min(body.length, offset + bytesPerTick);
      response.write(body.subarray(offset, end));
      offset = end;
      if (offset >= body.length) {
        response.end();
      } else {
        setTimeout(write, tickMs);
      }
    };
    write();
  };
  if (options.beaconLatencyMs === 0) begin();
  else setTimeout(begin, options.beaconLatencyMs);
}

function rpcResult(request: unknown, fixture: Fixture): Record<string, unknown> {
  const value = request as { id?: unknown; method?: unknown; params?: unknown[] };
  const response = { jsonrpc: "2.0", id: value.id ?? null };
  if (value.method === "eth_chainId") {
    return { ...response, result: hexQuantity(CHAIN_ID) };
  }
  if (value.method === "eth_blockNumber") {
    return { ...response, result: hexQuantity(fixture.finalizedBlock) };
  }
  if (value.method === "eth_getBlockByNumber") {
    return {
      ...response,
      result: blockResponse(blockNumber(value.params?.[0], fixture.finalizedBlock)),
    };
  }
  if (value.method === "eth_getLogs") {
    const filter = value.params?.[0] as { fromBlock?: unknown; toBlock?: unknown } | undefined;
    const from = blockNumber(filter?.fromBlock, fixture.finalizedBlock);
    const to = blockNumber(filter?.toBlock, fixture.finalizedBlock);
    return {
      ...response,
      result: fixture.logs.filter((log) => {
        const block = Number(BigInt(log.blockNumber));
        return block >= from && block <= to;
      }),
    };
  }
  return {
    ...response,
    error: { code: -32_601, message: `unsupported benchmark RPC method ${String(value.method)}` },
  };
}

async function createFixtureServer(
  fixture: Fixture,
  options: Options,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createHttpServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, headers());
        response.end();
        return;
      }
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, headers());
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/eth/v1/beacon/genesis") {
        response.writeHead(200, headers());
        response.end(JSON.stringify({ data: { genesis_time: "0" } }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/eth/v1/config/spec") {
        const retentionEpochs = Math.ceil((fixture.finalizedBlock + 1) / SLOTS_PER_EPOCH);
        response.writeHead(200, headers());
        response.end(JSON.stringify({
          data: {
            SECONDS_PER_SLOT: String(SECONDS_PER_SLOT),
            SLOTS_PER_EPOCH: String(SLOTS_PER_EPOCH),
            MIN_EPOCHS_FOR_DATA_COLUMN_SIDECARS_REQUESTS: String(retentionEpochs),
          },
        }));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/eth/v1/beacon/blobs/")) {
        sendThrottled(response, fixture.beaconBody, "application/json", options);
        return;
      }
      if (request.method === "POST" && url.pathname === "/rpc") {
        const body = await requestBody(request);
        const result = Array.isArray(body)
          ? body.map((item) => rpcResult(item, fixture))
          : rpcResult(body, fixture);
        response.writeHead(200, headers());
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(404, headers());
      response.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      response.writeHead(400, headers());
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "bad benchmark request",
      }));
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

async function addVirtualPasskey(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      hasHmacSecret: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
    },
  });
  return session;
}

async function preparePage(
  browser: Browser,
  appUrl: string,
  fixtureBaseUrl: string,
  options: Options,
): Promise<{ page: Page; session: CDPSession; profile: string; unlockMs: number | null }> {
  const context = await browser.newContext();
  // tsx preserves function names with this esbuild helper. Playwright serializes
  // evaluate callbacks without the module prelude that normally defines it.
  await context.addInitScript({ content: "globalThis.__name = (target) => target;" });
  const page = await context.newPage();
  const session = await addVirtualPasskey(page);
  const profile = `cold-${options.storage}-${Date.now()}`.slice(0, 32);
  const query = new URLSearchParams({
    profile,
    onchain: "0",
    live: "0",
    batcher: `${fixtureBaseUrl}/unused-batcher`,
    ...(options.storage === "development" ? { vault: "off" } : {}),
  });
  await page.goto(`${appUrl}?${query}`);
  let unlockMs: number | null = null;
  if (options.storage === "vault") {
    const vault = page.locator("#vault-dialog");
    await vault.getByRole("button", { name: "Protect with passkey" }).click();
    await page.locator("#app").waitFor({ state: "visible" });
    await page.reload();
    await vault.getByRole("button", { name: "Unlock with passkey" }).waitFor();
    const start = performance.now();
    await vault.getByRole("button", { name: "Unlock with passkey" }).click();
    await page.locator("#app").waitFor({ state: "visible" });
    unlockMs = performance.now() - start;
  } else {
    await page.locator("#app").waitFor({ state: "visible" });
  }
  if (options.cpuThrottle > 1) {
    await session.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle });
  }
  return { page, session, profile, unlockMs };
}

async function seedPendingRequests(page: Page, count: number): Promise<number> {
  if (count === 0) return 0;
  const start = performance.now();
  await page.evaluate(async (pendingCount) => {
    const [cryptoModule, protocol] = await Promise.all([
      import("../src/crypto"),
      import("../src/protocol"),
    ]);
    await protocol.rememberPublishedGweiName("cold-start-benchmark.gwei");
    for (let index = 0; index < pendingCount; index += 1) {
      const recipient = await cryptoModule.createIdentity();
      const contact = await protocol.importContact(
        cryptoModule.encodeContactCode(recipient),
        `Benchmark recipient ${index}`,
      );
      await protocol.requestSession(contact.id);
    }
  }, count);
  return performance.now() - start;
}

async function storedStateBytes(page: Page, profile: string): Promise<number> {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolveOpen, reject) => {
      const request = indexedDB.open(databaseName);
      request.addEventListener("success", () => resolveOpen(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("private-state", "readonly");
    const store = transaction.objectStore("private-state");
    const read = (key: string): Promise<unknown> => new Promise((resolveRead, reject) => {
      const request = store.get(key);
      request.addEventListener("success", () => resolveRead(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const [plain, encrypted] = await Promise.all([read("state"), read("vault-state")]);
    database.close();
    return new TextEncoder().encode(JSON.stringify(encrypted ?? plain ?? null)).length;
  }, `gwei-chat-prototype-v0:${profile}`);
}

async function runColdStart(
  page: Page,
  fixtureBaseUrl: string,
  options: Options,
): Promise<ColdStartResult> {
  await page.exposeFunction(
    "reportColdStartProgress",
    (completed: number, total: number) => {
      console.error(`cold-start scan: ${completed}/${total} blobs`);
    },
  );
  return page.evaluate(async ({
    executionRpcUrl,
    beaconApiUrl,
    contractAddress,
    expectedChainId,
    expectedBlobs,
    pageSize,
    fetchConcurrency,
  }) => {
    const [{ unpackEnvelopeSlots }, { sha256Base64Url }, protocol, { OnchainBlobSource }] =
      await Promise.all([
        import("../src/blob-batch"),
        import("../src/encoding"),
        import("../src/protocol"),
        import("../src/onchain/source"),
      ]);

    const listTimes: number[] = [];
    const fetchTimes: number[] = [];
    const fetchWindowTimes: number[] = [];
    const unpackTimes: number[] = [];
    const hashTimes: number[] = [];
    const receiveTimes: number[] = [];
    const cursorTimes: number[] = [];
    const eventLoopDelays: number[] = [];
    const memory = performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    };
    const jsHeapBefore = memory.memory?.usedJSHeapSize ?? null;
    const source = new OnchainBlobSource({
      executionRpcUrl,
      beaconApiUrl,
      contractAddress,
      expectedChainId: BigInt(expectedChainId),
      logRange: 10_000,
      pageSize,
    });
    let cursor = await protocol.getOnchainBatchCursor();
    let blobsFetched = 0;
    let slotsScanned = 0;
    let acceptedEvents = 0;
    let firstBlobMs: number | null = null;
    const started = performance.now();
    let lastEventLoopTick = started;
    const eventLoopTimer = setInterval(() => {
      const now = performance.now();
      eventLoopDelays.push(Math.max(0, now - lastEventLoopTick - 50));
      lastEventLoopTick = now;
    }, 50);

    while (true) {
      const listStarted = performance.now();
      const result = await source.list(cursor);
      listTimes.push(performance.now() - listStarted);
      for (let offset = 0; offset < result.segments.length; offset += fetchConcurrency) {
        const window = result.segments.slice(offset, offset + fetchConcurrency);
        const fetchWindowStarted = performance.now();
        const fetched = await Promise.all(window.map(async (segment) => {
          const fetchStarted = performance.now();
          const blob = segment.sequence <= cursor ? null : await source.fetch(segment);
          return { segment, blob, fetchMs: performance.now() - fetchStarted };
        }));
        fetchWindowTimes.push(performance.now() - fetchWindowStarted);
        for (const { segment, blob, fetchMs } of fetched) {
          if (segment.sequence <= cursor) continue;
          fetchTimes.push(fetchMs);
          if (blob) {
            const unpackStarted = performance.now();
            const slots = unpackEnvelopeSlots(blob);
            unpackTimes.push(performance.now() - unpackStarted);
            const envelopes = [];
            for (const slot of slots) {
              const hashStarted = performance.now();
              const transportId = await sha256Base64Url(slot);
              hashTimes.push(performance.now() - hashStarted);
              envelopes.push({ transportId, envelope: slot });
            }
            const receiveStarted = performance.now();
            const received = await protocol.receiveEnvelopes(envelopes);
            receiveTimes.push(performance.now() - receiveStarted);
            acceptedEvents += received.length;
            slotsScanned += slots.length;
            blobsFetched += 1;
          }
          const cursorStarted = performance.now();
          cursor = await protocol.advanceOnchainBatchCursor(segment.sequence);
          cursorTimes.push(performance.now() - cursorStarted);
          if (firstBlobMs === null) firstBlobMs = performance.now() - started;
          const progressEvery = Math.max(1, Math.floor(expectedBlobs / 10));
          if (blobsFetched === 1 || blobsFetched % progressEvery === 0) {
            await (globalThis as unknown as {
              reportColdStartProgress: (completed: number, total: number) => Promise<void>;
            }).reportColdStartProgress(blobsFetched, expectedBlobs);
          }
        }
      }
      if (result.scannedThrough > cursor) {
        const cursorStarted = performance.now();
        cursor = await protocol.advanceOnchainBatchCursor(result.scannedThrough);
        cursorTimes.push(performance.now() - cursorStarted);
      }
      if (!result.hasMore) break;
    }

    const summarize = (values: number[]): TimingSummary => {
      const sorted = [...values].sort((left, right) => left - right);
      const totalMs = values.reduce((total, value) => total + value, 0);
      return {
        count: values.length,
        totalMs,
        meanMs: values.length === 0 ? 0 : totalMs / values.length,
        medianMs: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!,
        p95Ms: sorted.length === 0
          ? 0
          : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
        maxMs: sorted.at(-1) ?? 0,
      };
    };
    clearInterval(eventLoopTimer);
    return {
      totalMs: performance.now() - started,
      list: summarize(listTimes),
      fetchAndDecode: summarize(fetchTimes),
      fetchWindows: summarize(fetchWindowTimes),
      unpack: summarize(unpackTimes),
      hash: summarize(hashTimes),
      receive: summarize(receiveTimes),
      cursor: summarize(cursorTimes),
      eventLoopDelay: summarize(eventLoopDelays),
      firstBlobMs,
      blobsFetched,
      slotsScanned,
      acceptedEvents,
      rawBlobBytes: blobsFetched * 131_072,
      beaconJsonBytes: 0,
      finalCursor: cursor,
      jsHeapBefore,
      jsHeapAfter: memory.memory?.usedJSHeapSize ?? null,
    };
  }, {
    executionRpcUrl: `${fixtureBaseUrl}/rpc`,
    beaconApiUrl: fixtureBaseUrl,
    contractAddress: CONTRACT_ADDRESS,
    expectedChainId: CHAIN_ID.toString(),
    expectedBlobs: options.blobs,
    pageSize: options.pageSize,
    fetchConcurrency: DEFAULT_FETCH_CONCURRENCY,
  });
}

async function verifyFreshIdentityBaseline(
  page: Page,
  fixtureBaseUrl: string,
): Promise<{ applied: boolean; cursor: number; expectedCursor: number; listedBlobs: number }> {
  const result = await page.evaluate(async ({ executionRpcUrl, beaconApiUrl, contractAddress }) => {
    const [protocol, { OnchainBlobSource }] = await Promise.all([
      import("../src/protocol"),
      import("../src/onchain/source"),
    ]);
    await protocol.resetProtocol();
    await protocol.initializeProtocol();
    const source = new OnchainBlobSource({
      executionRpcUrl,
      beaconApiUrl,
      contractAddress,
      expectedChainId: BigInt(11_155_111),
    });
    const baseline = await source.finalizedCursor();
    const applied = await protocol.establishFreshIdentityOnchainBaseline(baseline);
    const cursor = await protocol.getOnchainBatchCursor();
    const listed = await source.list(cursor);
    return {
      applied,
      cursor,
      expectedCursor: baseline.sequence,
      listedBlobs: listed.segments.length,
    };
  }, {
    executionRpcUrl: `${fixtureBaseUrl}/rpc`,
    beaconApiUrl: fixtureBaseUrl,
    contractAddress: CONTRACT_ADDRESS,
  });
  if (!result.applied || result.cursor !== result.expectedCursor || result.listedBlobs !== 0) {
    throw new Error("Fresh-identity finalized-head baseline did not suppress historical blobs");
  }
  return result;
}

const options = optionsFromArguments();
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = await createFixture(options.blobs);
const fixtureServer = await createFixtureServer(fixture, options);
const vite = await createViteServer({
  root,
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser: Browser | null = null;

try {
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite has no TCP address");
  const appUrl = `http://localhost:${address.port}/`;
  browser = await chromium.launch({ headless: true });
  const prepared = await preparePage(browser, appUrl, fixtureServer.baseUrl, options);
  const seedMs = await seedPendingRequests(prepared.page, options.pendingRequests);
  const stateBytesBefore = await storedStateBytes(prepared.page, prepared.profile);
  const result = await runColdStart(prepared.page, fixtureServer.baseUrl, options);
  result.beaconJsonBytes = result.blobsFetched * fixture.beaconBody.length;
  const stateBytesAfter = await storedStateBytes(prepared.page, prepared.profile);
  const freshIdentityBaseline = await verifyFreshIdentityBaseline(
    prepared.page,
    fixtureServer.baseUrl,
  );

  console.log(JSON.stringify({
    benchmark: "gwei-chat-cold-start-v3",
    measuredAt: new Date().toISOString(),
    options,
    environment: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
      browser: await browser.version(),
    },
    fixture: {
      blobs: options.blobs,
      slots: options.blobs * ENVELOPES_PER_BLOB,
      rawBytesPerBlob: BLOB_SIZE,
      beaconJsonBytesPerBlob: fixture.beaconBody.length,
      versionedHash: fixture.versionedHash,
    },
    setup: {
      passkeyUnlockMs: prepared.unlockMs,
      pendingSeedMs: seedMs,
      stateBytesBefore,
      stateBytesAfter,
      freshIdentityBaseline,
    },
    result,
  }, null, 2));
  await prepared.page.context().close();
} finally {
  await browser?.close();
  await vite.close();
  await fixtureServer.close();
}
