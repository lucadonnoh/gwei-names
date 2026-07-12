import { hexlify } from "ethers";
import { describe, expect, it } from "vitest";

import { BLOB_SIZE } from "../blob-batch";
import {
  InvalidGweiBlobError,
  beaconSlotForExecutionTimestamp,
  retrieveAvailableCanonicalBlob,
} from "./availability";

const EXPECTED_HASH = `0x01${"11".repeat(31)}`;
const AVAILABILITY = {
  genesisTime: 0n,
  secondsPerSlot: 12n,
  slotsPerEpoch: 32n,
  retentionEpochs: 4_096n,
};

function beaconFetch(blobs: Uint8Array[]): typeof fetch {
  return (async () => new Response(JSON.stringify({
    execution_optimistic: false,
    finalized: true,
    data: blobs.map((blob) => hexlify(blob)),
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

describe("availability-window retrieval", () => {
  it("maps an execution timestamp to its exact beacon slot", () => {
    expect(beaconSlotForExecutionTimestamp(1_120n, 1_000n, 12n)).toBe(10n);
  });

  it("rejects timestamps that cannot identify one beacon slot", () => {
    expect(() => beaconSlotForExecutionTimestamp(999n, 1_000n, 12n)).toThrow(/predates/u);
    expect(() => beaconSlotForExecutionTimestamp(1_121n, 1_000n, 12n)).toThrow(/aligned/u);
  });

  it("accepts the trusted Beacon endpoint's single canonical response without local KZG", async () => {
    const blob = new Uint8Array(BLOB_SIZE);
    blob[1] = 42;
    const available = await retrieveAvailableCanonicalBlob({
      beaconApiUrl: "https://beacon.example",
      executionTimestamp: 12n,
      versionedHash: EXPECTED_HASH,
      fetchImplementation: beaconFetch([blob]),
      availabilityConfig: AVAILABILITY,
    });

    expect(available.versionedHash).toBe(EXPECTED_HASH);
    expect(available.blob).toEqual(blob);
  });

  it("rejects ambiguous or non-canonical trusted Beacon responses", async () => {
    const canonical = new Uint8Array(BLOB_SIZE);
    await expect(retrieveAvailableCanonicalBlob({
      beaconApiUrl: "https://beacon.example",
      executionTimestamp: 12n,
      versionedHash: EXPECTED_HASH,
      fetchImplementation: beaconFetch([canonical, canonical]),
      availabilityConfig: AVAILABILITY,
    })).rejects.toThrow(/exactly the requested blob/u);

    const malformed = new Uint8Array(BLOB_SIZE);
    malformed[0] = 1;
    await expect(retrieveAvailableCanonicalBlob({
      beaconApiUrl: "https://beacon.example",
      executionTimestamp: 12n,
      versionedHash: EXPECTED_HASH,
      fetchImplementation: beaconFetch([malformed]),
      availabilityConfig: AVAILABILITY,
    })).rejects.toBeInstanceOf(InvalidGweiBlobError);
  });
});
