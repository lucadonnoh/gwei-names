import { describe, expect, it } from "vitest";

import type { StoredBatch } from "../batcher";
import { CONTENT_TAG, BLOB_SIZE } from "../blob-batch";
import {
  SubsidizedBatchPublisher,
} from "./subsidized-batcher";
import type {
  BatchPublishBackend,
  SubsidizedPublisherEvent,
} from "./subsidized-batcher";

function storedBatch(sequence: number): StoredBatch {
  return {
    metadata: {
      sequence,
      contentTag: CONTENT_TAG,
      sha256: "a".repeat(43),
      createdAt: sequence,
    },
    blob: new Uint8Array(BLOB_SIZE).fill(sequence),
  };
}

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for publisher state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("subsidized batch publication queue", () => {
  it("serializes batches and publishes public transaction status", async () => {
    const groups: number[][] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const backend: BatchPublishBackend = {
      publish: async (_blobs, sequences) => {
        groups.push([...sequences]);
        if (sequences[0] === 1) await firstGate;
        return {
          transactionHash: `0x${String(sequences[0]).repeat(64)}`,
          blockNumber: sequences.at(-1)!,
          versionedHashes: sequences.map(
            (sequence) => `0x01${String(sequence).repeat(62)}`,
          ),
        };
      },
    };
    const events: SubsidizedPublisherEvent[] = [];
    const publisher = new SubsidizedBatchPublisher({
      backend,
      batcherAddress: "0x1111111111111111111111111111111111111111",
      chainId: 11_155_111n,
      contractAddress: "0x2222222222222222222222222222222222222222",
      maxBlobsPerTransaction: 2,
      onEvent: (event) => events.push(event),
    });

    expect(publisher.enqueueMany([
      storedBatch(1),
      storedBatch(2),
      storedBatch(3),
    ])).toBe(3);
    await until(() => groups.length === 1);
    expect(groups).toEqual([[1, 2]]);
    expect(publisher.status()).toMatchObject({
      state: "publishing",
      queued: 3,
      maxBlobsPerTransaction: 2,
    });
    releaseFirst?.();
    await until(() => publisher.status().queued === 0);

    expect(groups).toEqual([[1, 2], [3]]);
    expect(publisher.status()).toMatchObject({
      state: "idle",
      latest: { sequence: 3, blockNumber: 3 },
    });
    const published = events.filter((event) => event.state === "published");
    expect(published).toHaveLength(3);
    expect(published[0]).toMatchObject({
      sequence: 1,
      transactionHash: `0x${"1".repeat(64)}`,
    });
    expect(published[1]).toMatchObject({
      sequence: 2,
      transactionHash: `0x${"1".repeat(64)}`,
    });
    publisher.stop();
  });

  it("retains a failed batch and retries it", async () => {
    let attempts = 0;
    const backend: BatchPublishBackend = {
      publish: async (_blobs, sequences) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary RPC failure");
        return {
          transactionHash: `0x${"33".repeat(32)}`,
          blockNumber: 3,
          versionedHashes: sequences.map(() => `0x01${"44".repeat(31)}`),
        };
      },
    };
    const publisher = new SubsidizedBatchPublisher({
      backend,
      batcherAddress: "0x1111111111111111111111111111111111111111",
      chainId: 11_155_111n,
      contractAddress: "0x2222222222222222222222222222222222222222",
      retryDelayMs: 5,
    });

    publisher.enqueue(storedBatch(3));
    await until(() => publisher.status().state === "retrying");
    expect(publisher.status()).toMatchObject({ queued: 1, error: expect.any(String) });
    await until(() => publisher.status().queued === 0);
    expect(attempts).toBe(2);
    publisher.stop();
  });
});
