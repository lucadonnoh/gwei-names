import { describe, expect, it } from "vitest";

import {
  BLOB_SIZE,
  BLOB_DATA_SIZE,
  BYTES_PER_FIELD_ELEMENT,
  CONTENT_TAG,
  DATA_BYTES_PER_FIELD_ELEMENT,
  ENVELOPES_PER_BLOB,
  FIELD_ELEMENTS_PER_BLOB,
  createPaddedBlobBatch,
  extractBlobData,
  packEnvelopeSlots,
  unpackEnvelopeSlots,
} from "./blob-batch";
import { ENVELOPE_SIZE } from "./envelope";

describe("gwei chat blob batches", () => {
  it("uses every data byte for exactly 62 fixed envelopes", () => {
    expect(FIELD_ELEMENTS_PER_BLOB * DATA_BYTES_PER_FIELD_ELEMENT).toBe(
      ENVELOPES_PER_BLOB * ENVELOPE_SIZE,
    );
    expect(CONTENT_TAG).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it("roundtrips all slots while producing valid field elements", () => {
    const slots = Array.from({ length: ENVELOPES_PER_BLOB }, (_, index) =>
      new Uint8Array(ENVELOPE_SIZE).fill(index),
    );
    const blob = packEnvelopeSlots(slots);

    expect(blob).toHaveLength(BLOB_SIZE);
    expect(extractBlobData(blob)).toHaveLength(BLOB_DATA_SIZE);
    for (let offset = 0; offset < blob.length; offset += BYTES_PER_FIELD_ELEMENT) {
      expect(blob[offset]).toBe(0);
    }
    expect(unpackEnvelopeSlots(blob)).toEqual(slots);
  });

  it("pads and shuffles a partial batch with structured HPKE dummies", async () => {
    const real = crypto.getRandomValues(new Uint8Array(ENVELOPE_SIZE));
    const slots = unpackEnvelopeSlots(await createPaddedBlobBatch([real]));

    expect(slots).toHaveLength(ENVELOPES_PER_BLOB);
    expect(slots.filter((slot) => slot.every((byte, index) => byte === real[index]))).toHaveLength(1);
  });

  it("rejects malformed slot counts, slot sizes, blobs, and field elements", () => {
    expect(() => packEnvelopeSlots([])).toThrow(/exactly 62/u);
    expect(() =>
      packEnvelopeSlots(
        Array.from({ length: ENVELOPES_PER_BLOB }, () => new Uint8Array(1)),
      ),
    ).toThrow(/2048/u);
    expect(() => unpackEnvelopeSlots(new Uint8Array(1))).toThrow(/131072/u);

    const malformed = new Uint8Array(BLOB_SIZE);
    malformed[0] = 1;
    expect(() => unpackEnvelopeSlots(malformed)).toThrow(/non-zero high byte/u);
  });
});
