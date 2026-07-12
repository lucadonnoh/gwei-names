import { describe, expect, it } from "vitest";

import { ENVELOPES_PER_BLOB } from "./blob-batch";
import {
  ENVELOPE_SIZE,
  MAX_PAYLOAD_SIZE,
  dummyEnvelope,
  generateDeliveryKeyPair,
  openEnvelope,
  sealEnvelope,
} from "./envelope";

describe("fixed HPKE envelopes", () => {
  it("always seals to 2,048 bytes and opens only for the recipient", async () => {
    const recipient = await generateDeliveryKeyPair();
    const stranger = await generateDeliveryKeyPair();
    const payload = { kind: "olm", body: "hello", sequence: 1 };
    const envelope = await sealEnvelope(recipient.publicKey, payload);

    expect(envelope).toHaveLength(ENVELOPE_SIZE);
    await expect(openEnvelope(recipient.privateKey, envelope)).resolves.toEqual(payload);
    await expect(openEnvelope(stranger.privateKey, envelope)).resolves.toBeNull();
  });

  it("rejects random dummy slots and authenticated tampering", async () => {
    const recipient = await generateDeliveryKeyPair();
    const envelope = await sealEnvelope(recipient.publicKey, { body: "untouched" });
    const tampered = envelope.slice();
    const last = tampered.length - 1;
    tampered[last] = tampered[last]! ^ 1;

    await expect(openEnvelope(recipient.privateKey, await dummyEnvelope())).resolves.toBeNull();
    await expect(openEnvelope(recipient.privateKey, tampered)).resolves.toBeNull();
  });

  it("finds one real envelope without a routing tag", async () => {
    const recipient = await generateDeliveryKeyPair();
    const slots = await Promise.all(
      Array.from({ length: ENVELOPES_PER_BLOB }, () => dummyEnvelope()),
    );
    slots[37] = await sealEnvelope(recipient.publicKey, { body: "found" });

    const opened = await Promise.all(
      slots.map((slot) => openEnvelope(recipient.privateKey, slot)),
    );
    expect(opened.filter(Boolean)).toEqual([{ body: "found" }]);
  });

  it("fails before encryption when a payload cannot fit", async () => {
    const recipient = await generateDeliveryKeyPair();
    const body = "x".repeat(MAX_PAYLOAD_SIZE);

    await expect(sealEnvelope(recipient.publicKey, { body })).rejects.toThrow(/maximum/u);
  });
});
