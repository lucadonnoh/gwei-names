import { describe, expect, it } from "vitest";

import { ENVELOPES_PER_BLOB, unpackEnvelopeSlots } from "./blob-batch";
import { LocalBlobBatcher } from "./batcher";
import { sha256Base64Url } from "./encoding";
import { ENVELOPE_SIZE } from "./envelope";

describe("local subsidized blob batcher", () => {
  it("deduplicates submissions and emits a verifiable padded batch", async () => {
    const batcher = new LocalBlobBatcher();
    const envelope = crypto.getRandomValues(new Uint8Array(ENVELOPE_SIZE));

    expect(batcher.enqueue("one", envelope)).toEqual({ queued: true, pending: 1 });
    expect(batcher.enqueue("one", envelope)).toEqual({ queued: false, pending: 1 });

    const batch = await batcher.flush();
    expect(batch).not.toBeNull();
    expect(unpackEnvelopeSlots(batch!.blob)).toHaveLength(ENVELOPES_PER_BLOB);
    expect(batch!.metadata.sha256).toBe(await sha256Base64Url(batch!.blob));
    expect(batcher.list(-1).batches).toEqual([batch!.metadata]);
  });

  it("fills at most 62 real slots and retains a bounded cursor window", async () => {
    const batcher = new LocalBlobBatcher(1);
    for (let index = 0; index < ENVELOPES_PER_BLOB + 1; index += 1) {
      batcher.enqueue(String(index), new Uint8Array(ENVELOPE_SIZE).fill(index));
    }

    const first = await batcher.flush();
    const second = await batcher.flush();
    expect(first?.metadata.sequence).toBe(0);
    expect(second?.metadata.sequence).toBe(1);
    expect(batcher.pendingCount).toBe(0);
    expect(batcher.get(0)).toBeNull();
    expect(batcher.list(-1)).toMatchObject({
      oldestSequence: 1,
      latestSequence: 1,
      batches: [{ sequence: 1 }],
    });
  });

  it("rejects invalid envelopes and cursors", () => {
    const batcher = new LocalBlobBatcher();
    expect(() => new LocalBlobBatcher(1, -1)).toThrow(/sequence/u);
    expect(() => batcher.enqueue("bad", new Uint8Array(1))).toThrow(/2048/u);
    expect(() => batcher.list(-2)).toThrow(/cursor/u);
    expect(() => batcher.list(-1, 65)).toThrow(/limit/u);
  });
});
