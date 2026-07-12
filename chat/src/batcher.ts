import {
  CONTENT_TAG,
  ENVELOPES_PER_BLOB,
  createPaddedBlobBatch,
} from "./blob-batch";
import { sha256Base64Url } from "./encoding";
import type { ByteSource } from "./encoding";
import { ENVELOPE_SIZE } from "./envelope";

export interface BatchMetadata {
  sequence: number;
  contentTag: typeof CONTENT_TAG;
  sha256: string;
  createdAt: number;
}

export interface BatchList {
  batches: BatchMetadata[];
  oldestSequence: number | null;
  latestSequence: number | null;
}

export interface StoredBatch {
  metadata: BatchMetadata;
  blob: Uint8Array;
}

interface PendingEnvelope {
  id: string;
  bytes: Uint8Array;
}

interface PrivateStoredBatch extends StoredBatch {
  envelopeIds: string[];
}

export interface EnqueueResult {
  queued: boolean;
  pending: number;
}

export class LocalBlobBatcher {
  readonly #retention: number;
  readonly #pending: PendingEnvelope[] = [];
  readonly #knownIds = new Set<string>();
  readonly #batches: PrivateStoredBatch[] = [];
  #nextSequence = 0;
  #flushPromise: Promise<StoredBatch | null> | null = null;

  constructor(retention = 64, initialSequence = 0) {
    if (!Number.isSafeInteger(retention) || retention < 1) {
      throw new RangeError("Batch retention must be a positive integer");
    }
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new RangeError("Initial batch sequence must be a non-negative integer");
    }
    this.#retention = retention;
    this.#nextSequence = initialSequence;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  enqueue(id: string, envelope: ByteSource): EnqueueResult {
    const bytes = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
    if (!id || id.length > 128) throw new RangeError("Envelope ID is invalid");
    if (bytes.length !== ENVELOPE_SIZE) {
      throw new RangeError(`Every envelope must be exactly ${ENVELOPE_SIZE} bytes`);
    }
    if (this.#knownIds.has(id)) {
      return { queued: false, pending: this.#pending.length };
    }

    this.#knownIds.add(id);
    this.#pending.push({ id, bytes: bytes.slice() });
    return { queued: true, pending: this.#pending.length };
  }

  flush(): Promise<StoredBatch | null> {
    this.#flushPromise ||= this.#flush().finally(() => {
      this.#flushPromise = null;
    });
    return this.#flushPromise;
  }

  async #flush(): Promise<StoredBatch | null> {
    const selected = this.#pending.splice(0, ENVELOPES_PER_BLOB);
    if (selected.length === 0) return null;

    try {
      const blob = await createPaddedBlobBatch(selected.map((item) => item.bytes));
      const metadata: BatchMetadata = {
        sequence: this.#nextSequence,
        contentTag: CONTENT_TAG,
        sha256: await sha256Base64Url(blob),
        createdAt: Date.now(),
      };
      this.#nextSequence += 1;

      const stored: PrivateStoredBatch = {
        metadata,
        blob,
        envelopeIds: selected.map((item) => item.id),
      };
      this.#batches.push(stored);
      while (this.#batches.length > this.#retention) {
        const evicted = this.#batches.shift();
        if (evicted) {
          for (const id of evicted.envelopeIds) this.#knownIds.delete(id);
        }
      }
      return { metadata, blob };
    } catch (error) {
      this.#pending.unshift(...selected);
      throw error;
    }
  }

  list(after: number, limit = 16): BatchList {
    if (!Number.isSafeInteger(after) || after < -1) throw new RangeError("Invalid batch cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new RangeError("Batch list limit must be between 1 and 64");
    }
    const oldestSequence = this.#batches[0]?.metadata.sequence ?? null;
    const latestSequence = this.#batches.at(-1)?.metadata.sequence ?? null;
    return {
      batches: this.#batches
        .filter((batch) => batch.metadata.sequence > after)
        .slice(0, limit)
        .map((batch) => ({ ...batch.metadata })),
      oldestSequence,
      latestSequence,
    };
  }

  get(sequence: number): StoredBatch | null {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
    const stored = this.#batches.find((batch) => batch.metadata.sequence === sequence);
    return stored ? { metadata: { ...stored.metadata }, blob: stored.blob.slice() } : null;
  }
}
