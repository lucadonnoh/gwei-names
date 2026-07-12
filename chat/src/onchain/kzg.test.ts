import { describe, expect, it } from "vitest";

import { BLOB_SIZE, createPaddedBlobBatch } from "../blob-batch";
import { commitmentToVersionedHash, prepareCanonicalBlob } from "./kzg";

describe("canonical blob KZG", () => {
  it("commits to the exact 62-envelope blob and verifies its proof", async () => {
    const blob = await createPaddedBlobBatch([]);
    const prepared = await prepareCanonicalBlob(blob);

    expect(prepared.data).toEqual(blob);
    expect(prepared.data).toHaveLength(BLOB_SIZE);
    expect(prepared.commitment).toMatch(/^0x[0-9a-f]{96}$/u);
    expect(prepared.proof).toMatch(/^0x[0-9a-f]{96}$/u);
    expect(prepared.versionedHash).toMatch(/^0x01[0-9a-f]{62}$/u);
    expect(commitmentToVersionedHash(prepared.commitment)).toBe(prepared.versionedHash);
  }, 15_000);

  it("rejects malformed field elements before KZG", async () => {
    const blob = new Uint8Array(BLOB_SIZE);
    blob[0] = 1;
    await expect(prepareCanonicalBlob(blob)).rejects.toThrow(/non-zero high byte/u);
  });
});
