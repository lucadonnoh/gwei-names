import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AdmissionQuotaError,
  RelayAdmissionError,
  relayAdmissionFromEnvironment,
} from "./src/admission/server";
import { LocalBlobBatcher } from "./src/batcher";
import type { BatchMetadata } from "./src/batcher";
import { ENVELOPES_PER_BLOB } from "./src/blob-batch";
import { sha256Base64Url } from "./src/encoding";
import { ENVELOPE_SIZE } from "./src/envelope";
import { subsidizedPublisherFromEnvironment } from "./src/onchain/subsidized-batcher";

function integerEnvironment(name: string, fallback: number, minimum: number): number {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

const port = integerEnvironment("PORT", 8_790, 1);
const host = process.env.HOST || "127.0.0.1";
const batchMaxWaitMs = process.env.BATCH_MAX_WAIT_MS
  ? integerEnvironment("BATCH_MAX_WAIT_MS", 300_000, 50)
  : integerEnvironment("BATCH_INTERVAL_MS", 300_000, 50);
const batchRetention = integerEnvironment("BATCH_RETENTION", 64, 1);
const maxBufferedEnvelopeSlots = integerEnvironment(
  "MAX_BUFFERED_ENVELOPE_SLOTS",
  ENVELOPES_PER_BLOB * 66,
  ENVELOPES_PER_BLOB,
);
const maxIssuesPerMinute = integerEnvironment("MAX_ISSUES_PER_MINUTE", 10, 1);
const maxConcurrentIssues = integerEnvironment("MAX_CONCURRENT_ISSUES", 2, 1);
const maxConcurrentSubmissions = integerEnvironment("MAX_CONCURRENT_SUBMISSIONS", 128, 1);
const clients = new Set<ServerResponse>();
// Keep local cursor URLs monotonic across ordinary relay restarts. Production
// sequencing will come from finalized block/log positions instead.
const batcher = new LocalBlobBatcher(batchRetention, Date.now() * 1_000);
let activeFlush: Promise<void> | null = null;
let partialFlushRequested = false;

const publisher = await subsidizedPublisherFromEnvironment({
  onEvent: (event) => {
    if (event.state === "published") {
      console.log(
        `published batch ${event.sequence} in ${event.transactionHash} at block ${event.blockNumber}`,
      );
    }
    broadcast("publication", event);
  },
  onError: (error) => console.error("onchain batch publication failed", error),
});
const admission = await relayAdmissionFromEnvironment();
const maxBlobsPerTransaction = publisher?.maxBlobsPerTransaction ?? 1;
const envelopesPerTransaction = ENVELOPES_PER_BLOB * maxBlobsPerTransaction;
let submissionTail: Promise<void> = Promise.resolve();
let activeIssues = 0;
let activeSubmissions = 0;
const issueWindows = new Map<string, { startedAt: number; count: number }>();

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    ...extra,
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, corsHeaders({ "content-type": "application/json", ...headers }));
  response.end(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown relay error";
}

async function readEnvelope(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > ENVELOPE_SIZE) throw new RangeError("Envelope is too large");
    chunks.push(bytes);
  }
  if (length !== ENVELOPE_SIZE) throw new RangeError("Envelope has the wrong size");
  return new Uint8Array(Buffer.concat(chunks, length));
}

async function readJson(request: IncomingMessage, maximum = 32_768): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > maximum) throw new RangeError("JSON request is too large");
    chunks.push(bytes);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
  } catch {
    throw new RangeError("JSON request is malformed");
  }
}

function exclusiveSubmission<T>(operation: () => Promise<T>): Promise<T> {
  const result = submissionTail.then(operation, operation);
  submissionTail = result.then(() => undefined, () => undefined);
  return result;
}

function bufferedEnvelopeSlots(): number {
  return batcher.pendingCount + (publisher?.status().queued ?? 0) * ENVELOPES_PER_BLOB;
}

function issueAllowed(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  if (issueWindows.size > 4_096) {
    for (const [key, window] of issueWindows) {
      if (now - window.startedAt >= 60_000) issueWindows.delete(key);
    }
    if (issueWindows.size > 4_096 && !issueWindows.has(address)) return false;
  }
  const current = issueWindows.get(address);
  if (!current || now - current.startedAt >= 60_000) {
    issueWindows.set(address, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= maxIssuesPerMinute;
}

function broadcast(eventName: "envelope" | "batch" | "publication", value: unknown): void {
  const event = `event: ${eventName}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of clients) client.write(event);
}

function publicBatchEvent(metadata: BatchMetadata): BatchMetadata {
  return { ...metadata };
}

function flushAndAnnounce(includePartial = false): Promise<void> {
  if (includePartial) partialFlushRequested = true;
  activeFlush ||= (async () => {
    while (
      batcher.pendingCount >= envelopesPerTransaction ||
      (partialFlushRequested && batcher.pendingCount > 0)
    ) {
      const isFullTransaction = batcher.pendingCount >= envelopesPerTransaction;
      if (!isFullTransaction) partialFlushRequested = false;
      const blobCount = isFullTransaction
        ? maxBlobsPerTransaction
        : Math.min(
            maxBlobsPerTransaction,
            Math.ceil(batcher.pendingCount / ENVELOPES_PER_BLOB),
          );
      const batches = [];
      for (let index = 0; index < blobCount; index += 1) {
        const batch = await batcher.flush();
        if (!batch) break;
        batches.push(batch);
      }
      for (const batch of batches) {
        broadcast("batch", publicBatchEvent(batch.metadata));
      }
      publisher?.enqueueMany(batches);
    }
    if (batcher.pendingCount === 0) partialFlushRequested = false;
  })().finally(() => {
    activeFlush = null;
  });
  return activeFlush;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      clients: clients.size,
      pending: batcher.pendingCount,
      latestBatch: batcher.list(-1, 1).latestSequence,
      publisher: publisher?.status() ?? {
        enabled: false,
        state: "disabled",
        queued: 0,
      },
      admission: admission?.status() ?? { required: false },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/admission/config") {
    sendJson(response, 200, admission?.config() ?? { required: false });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admission/nonce") {
    if (!admission) {
      sendJson(response, 404, { error: "relay admission is disabled" });
      return;
    }
    sendJson(response, 200, admission.nonce());
    return;
  }

  if (request.method === "POST" && url.pathname === "/admission/issue") {
    if (!admission) {
      sendJson(response, 404, { error: "relay admission is disabled" });
      return;
    }
    if (!issueAllowed(request)) {
      sendJson(response, 429, { error: "too many relay-pass issuance attempts" }, {
        "retry-after": "60",
      });
      return;
    }
    if (activeIssues >= maxConcurrentIssues) {
      sendJson(response, 503, { error: "relay-pass issuer is busy" }, { "retry-after": "2" });
      return;
    }
    activeIssues += 1;
    try {
      sendJson(response, 200, await admission.issue(await readJson(request)));
    } catch (error) {
      const status = error instanceof AdmissionQuotaError
        ? 429
        : error instanceof RelayAdmissionError
        ? error.status
        : error instanceof RangeError
        ? 400
        : 500;
      if (status === 500) console.error("relay-pass issuance failed", error);
      sendJson(response, status, {
        error: status === 500 ? "relay-pass issuance is temporarily unavailable" : errorMessage(error),
        ...(error instanceof AdmissionQuotaError ? { remaining: error.remaining } : {}),
      });
    } finally {
      activeIssues -= 1;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/batches") {
    try {
      const after = Number.parseInt(url.searchParams.get("after") || "-1", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") || "16", 10);
      sendJson(response, 200, batcher.list(after, limit));
    } catch (error) {
      sendJson(response, 400, { error: errorMessage(error) });
    }
    return;
  }

  const blobMatch = /^\/batches\/(\d+)\/blob$/u.exec(url.pathname);
  if (request.method === "GET" && blobMatch) {
    const sequence = Number.parseInt(blobMatch[1]!, 10);
    const batch = batcher.get(sequence);
    if (!batch) {
      sendJson(response, 404, { error: "batch not found" });
      return;
    }
    response.writeHead(
      200,
      corsHeaders({
        "content-type": "application/octet-stream",
        "content-length": String(batch.blob.length),
        "cache-control": "no-store",
        etag: `"${batch.metadata.sha256}"`,
      }),
    );
    response.end(batch.blob);
    return;
  }

  if (request.method === "GET" && url.pathname === "/stream") {
    response.writeHead(
      200,
      corsHeaders({
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      }),
    );
    response.write(": connected\n\n");
    clients.add(response);
    response.once("close", () => clients.delete(response));
    return;
  }

  if (request.method === "POST" && url.pathname === "/submit") {
    if (activeSubmissions >= maxConcurrentSubmissions) {
      sendJson(response, 503, {
        accepted: false,
        error: "Relay has too many in-flight submissions; retry without spending a pass",
      }, { "retry-after": "5" });
      return;
    }
    activeSubmissions += 1;
    try {
      const envelope = await readEnvelope(request);
      const result = await exclusiveSubmission(async () => {
        if (bufferedEnvelopeSlots() >= maxBufferedEnvelopeSlots) {
          throw new RelayCapacityError();
        }
        await admission?.redeem(request.headers.authorization);
        const id = await sha256Base64Url(envelope);
        const queued = batcher.enqueue(id, envelope);
        if (queued.queued) {
          broadcast("envelope", {
            id,
            body: Buffer.from(envelope).toString("base64url"),
          });
        }
        if (batcher.pendingCount >= envelopesPerTransaction) await flushAndAnnounce();
        return { id, queued: queued.queued };
      });
      sendJson(response, 202, { accepted: true, id: result.id, queued: result.queued });
    } catch (error) {
      const status = error instanceof RelayCapacityError
        ? 503
        : error instanceof RelayAdmissionError
        ? error.status
        : 400;
      sendJson(response, status, { accepted: false, error: errorMessage(error) },
        error instanceof RelayCapacityError ? { "retry-after": "30" } : {});
    } finally {
      activeSubmissions -= 1;
    }
    return;
  }

  sendJson(response, 404, { error: "not found" });
});

const heartbeat = setInterval(() => {
  for (const client of clients) client.write(": heartbeat\n\n");
}, 15_000);
heartbeat.unref();

const batchTimer = setInterval(() => {
  if (batcher.pendingCount > 0) {
    void flushAndAnnounce(true).catch((error: unknown) => {
      console.error("blob batch flush failed", error);
    });
  }
}, batchMaxWaitMs);
batchTimer.unref();

server.listen(port, host, () => {
  console.log(
    `opaque relay + subsidized blob batcher listening on http://${host}:${port} ` +
      `(max wait ${batchMaxWaitMs}ms, ${maxBlobsPerTransaction} blobs/tx, ` +
      `retain ${batchRetention}, buffer ${maxBufferedEnvelopeSlots} slots, ` +
      `${admission ? "holder passes required" : "open admission"}, ` +
      `${publisher ? `publish chain ${publisher.status().chainId}` : "onchain publishing disabled"})`,
  );
});

function close(): void {
  clearInterval(heartbeat);
  clearInterval(batchTimer);
  for (const client of clients) client.end();
  admission?.close();
  publisher?.stop();
  server.close();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);

class RelayCapacityError extends Error {
  constructor() {
    super("Relay publication queue is full; retry later without spending a pass");
    this.name = "RelayCapacityError";
  }
}
