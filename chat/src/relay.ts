import { BLOB_SIZE, CONTENT_TAG } from "./blob-batch";
import type { BatchList, BatchMetadata } from "./batcher";
import { fromBase64Url, sha256Base64Url } from "./encoding";
import type { ByteSource } from "./encoding";
import type { Eip1193Provider } from "ethers";
import { currentTransportSettings } from "./settings";

export const relayBase = currentTransportSettings().batcherUrl.replace(/\/$/u, "");

export type RelayStatus = "live" | "reconnecting";

export interface PublishedBatchNotice {
  state: "published";
  sequence: number;
  transactionHash: string;
  blockNumber: number;
  versionedHash: string;
  publishedAt: number;
}

export interface BatcherPublisherHealth {
  enabled: boolean;
  state: "disabled" | "idle" | "publishing" | "retrying" | "stopped";
  queued: number;
  batcherAddress?: string;
  chainId?: string;
  contractAddress?: string;
  latest?: PublishedBatchNotice | null;
  error?: string | null;
}

export interface BatcherHealth {
  ok: true;
  pending: number;
  latestBatch: number | null;
  publisher: BatcherPublisherHealth;
  admission: {
    required: boolean;
    quotaPerName?: number;
    issueBatchSize?: number;
  };
}

export interface RelayHandlers {
  onEnvelope: (transportId: string, envelope: Uint8Array) => void;
  onBatch: (metadata: BatchMetadata) => void;
  onStatus: (status: RelayStatus) => void;
  onPublication?: (notice: PublishedBatchNotice) => void;
}

function eventData(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    throw new Error("Malformed relay event");
  }
  return JSON.parse(event.data) as unknown;
}

function batchMetadata(value: unknown): BatchMetadata {
  if (!value || typeof value !== "object") throw new Error("Malformed batch metadata");
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    record.contentTag !== CONTENT_TAG ||
    typeof record.sha256 !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record.sha256) ||
    typeof record.createdAt !== "number" ||
    !Number.isSafeInteger(record.createdAt)
  ) {
    throw new Error("Malformed batch metadata");
  }
  return {
    sequence: record.sequence as number,
    contentTag: CONTENT_TAG,
    sha256: record.sha256,
    createdAt: record.createdAt,
  };
}

function nullableSequence(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Malformed batch range");
  }
  return value as number;
}

function publishedBatchNotice(value: unknown): PublishedBatchNotice {
  if (!value || typeof value !== "object") throw new Error("Malformed publication notice");
  const record = value as Record<string, unknown>;
  if (
    record.state !== "published" ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    typeof record.transactionHash !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(record.transactionHash) ||
    !Number.isSafeInteger(record.blockNumber) ||
    (record.blockNumber as number) < 0 ||
    typeof record.versionedHash !== "string" ||
    !/^0x01[0-9a-f]{62}$/iu.test(record.versionedHash) ||
    !Number.isSafeInteger(record.publishedAt) ||
    (record.publishedAt as number) < 0
  ) {
    throw new Error("Malformed publication notice");
  }
  return {
    state: "published",
    sequence: record.sequence as number,
    transactionHash: record.transactionHash.toLowerCase(),
    blockNumber: record.blockNumber as number,
    versionedHash: record.versionedHash.toLowerCase(),
    publishedAt: record.publishedAt as number,
  };
}

function publisherHealth(value: unknown): BatcherPublisherHealth {
  if (!value || typeof value !== "object") {
    return { enabled: false, state: "disabled", queued: 0 };
  }
  const record = value as Record<string, unknown>;
  if (record.enabled !== true) return { enabled: false, state: "disabled", queued: 0 };
  if (
    !["idle", "publishing", "retrying", "stopped"].includes(String(record.state)) ||
    !Number.isSafeInteger(record.queued) ||
    (record.queued as number) < 0 ||
    typeof record.batcherAddress !== "string" ||
    !/^0x[0-9a-f]{40}$/iu.test(record.batcherAddress) ||
    typeof record.chainId !== "string" ||
    !/^\d+$/u.test(record.chainId) ||
    typeof record.contractAddress !== "string" ||
    !/^0x[0-9a-f]{40}$/iu.test(record.contractAddress)
  ) {
    throw new Error("Malformed batcher publisher status");
  }
  let latest: PublishedBatchNotice | null = null;
  if (record.latest !== null && record.latest !== undefined) {
    latest = publishedBatchNotice({ ...(record.latest as object), state: "published" });
  }
  return {
    enabled: true,
    state: record.state as BatcherPublisherHealth["state"],
    queued: record.queued as number,
    batcherAddress: record.batcherAddress,
    chainId: record.chainId,
    contractAddress: record.contractAddress,
    latest,
    error: typeof record.error === "string" ? record.error : null,
  };
}

export function connectRelay({
  onEnvelope,
  onBatch,
  onStatus,
  onPublication,
}: RelayHandlers): () => void {
  const source = new EventSource(`${relayBase}/stream`);
  source.addEventListener("open", () => onStatus("live"));
  source.addEventListener("error", () => onStatus("reconnecting"));
  source.addEventListener("envelope", (event) => {
    try {
      const value = eventData(event);
      if (!value || typeof value !== "object") throw new Error("Malformed envelope event");
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.body !== "string") {
        throw new Error("Malformed envelope event");
      }
      onEnvelope(record.id, fromBase64Url(record.body));
    } catch {
      // Ignore malformed relay frames. The cryptographic layer validates all data.
    }
  });
  source.addEventListener("batch", (event) => {
    try {
      onBatch(batchMetadata(eventData(event)));
    } catch {
      // Polling is authoritative; a malformed or missed hint is harmless.
    }
  });
  source.addEventListener("publication", (event) => {
    try {
      const value = eventData(event);
      if (value && typeof value === "object" && (value as { state?: unknown }).state === "published") {
        onPublication?.(publishedBatchNotice(value));
      }
    } catch {
      // Health polling is authoritative; malformed status hints are harmless.
    }
  });
  return () => source.close();
}

export async function fetchBatcherHealth(): Promise<BatcherHealth> {
  const response = await fetch(`${relayBase}/health`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Batcher health request failed (${response.status})`);
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object") throw new Error("Malformed batcher health response");
  const record = value as Record<string, unknown>;
  if (
    record.ok !== true ||
    !Number.isSafeInteger(record.pending) ||
    (record.pending as number) < 0
  ) {
    throw new Error("Malformed batcher health response");
  }
  return {
    ok: true,
    pending: record.pending as number,
    latestBatch: nullableSequence(record.latestBatch),
    publisher: publisherHealth(record.publisher),
    admission: record.admission && typeof record.admission === "object" &&
        (record.admission as { required?: unknown }).required === true
      ? {
          required: true,
          ...(
            Number.isSafeInteger((record.admission as { quotaPerName?: unknown }).quotaPerName) &&
              ((record.admission as { quotaPerName: number }).quotaPerName > 0)
              ? { quotaPerName: (record.admission as { quotaPerName: number }).quotaPerName }
              : {}
          ),
          ...(
            Number.isSafeInteger((record.admission as { issueBatchSize?: unknown }).issueBatchSize) &&
              ((record.admission as { issueBatchSize: number }).issueBatchSize > 0)
              ? { issueBatchSize: (record.admission as { issueBatchSize: number }).issueBatchSize }
              : {}
          ),
        }
      : { required: false },
  };
}

export async function submitEnvelope(envelope: ByteSource): Promise<{ id: string }> {
  const body = envelope instanceof Uint8Array
    ? Uint8Array.from(envelope)
    : new Uint8Array(envelope.slice(0));
  const { submitWithRelayAdmission } = await import("./admission/client");
  const response = await submitWithRelayAdmission(relayBase, body);
  if (!response.ok) throw new Error(`Relay rejected the envelope (${response.status})`);
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new Error("Relay returned a malformed receipt");
  }
  return { id: (value as { id: string }).id };
}

export async function activateRelayAccess(
  name: string,
  ethereum?: Eip1193Provider,
): Promise<import("./admission/client").RelayPassActivation> {
  const { activateRelayPasses } = await import("./admission/client");
  return activateRelayPasses(relayBase, name, ethereum);
}

export async function relayAccessName(): Promise<string | null> {
  const { getRelayHolderName } = await import("./admission/client");
  return getRelayHolderName(relayBase);
}

export async function rememberRelayAccessName(name: string): Promise<string> {
  const { setRelayHolderName } = await import("./admission/client");
  return setRelayHolderName(relayBase, name);
}

export async function listBatches(after: number): Promise<BatchList> {
  const response = await fetch(`${relayBase}/batches?after=${after}&limit=16`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not list blob batches (${response.status})`);
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object") throw new Error("Malformed batch list");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.batches)) throw new Error("Malformed batch list");
  return {
    batches: record.batches.map(batchMetadata),
    oldestSequence: nullableSequence(record.oldestSequence),
    latestSequence: nullableSequence(record.latestSequence),
  };
}

export async function fetchBatchBlob(metadata: BatchMetadata): Promise<Uint8Array> {
  const response = await fetch(`${relayBase}/batches/${metadata.sequence}/blob`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not fetch blob batch ${metadata.sequence}`);
  const blob = new Uint8Array(await response.arrayBuffer());
  if (blob.length !== BLOB_SIZE) throw new Error("Blob batch has the wrong size");
  if (await sha256Base64Url(blob) !== metadata.sha256) {
    throw new Error("Blob batch digest does not match its metadata");
  }
  return blob;
}
