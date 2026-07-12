import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "./encoding";
import {
  decryptVaultValue,
  encryptVaultValue,
  unwrapVaultKey,
  wrapNewVaultKey,
} from "./vault";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe("passkey encrypted vault", () => {
  it("wraps a non-extractable random key and decrypts authenticated state", async () => {
    const created = await wrapNewVaultKey({
      prfOutput: bytes(7),
      rpId: "chat.gwei.domains",
      credentialId: toBase64Url(bytes(9)),
      prfSalt: bytes(11),
      createdAt: 123,
    });
    await expect(crypto.subtle.exportKey("raw", created.key)).rejects.toThrow();

    const state = { v: 0, identity: { secret: "not-in-clear-storage" }, contacts: {} };
    const encrypted = await encryptVaultValue(created.key, state, "default", 1);
    expect(JSON.stringify(encrypted)).not.toContain("not-in-clear-storage");

    const restoredKey = await unwrapVaultKey(created.config, bytes(7));
    await expect(decryptVaultValue(restoredKey, encrypted, "default")).resolves.toEqual(state);
  });

  it("rejects the wrong PRF output and authenticated-state tampering", async () => {
    const created = await wrapNewVaultKey({
      prfOutput: bytes(1),
      rpId: "chat.gwei.domains",
      credentialId: toBase64Url(bytes(2)),
      prfSalt: bytes(3),
    });
    await expect(unwrapVaultKey(created.config, bytes(4))).rejects.toThrow(/cannot unlock/u);

    const encrypted = await encryptVaultValue(created.key, { secret: "value" }, "alice", 8);
    const tampered = fromBase64Url(encrypted.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(decryptVaultValue(created.key, {
      ...encrypted,
      ciphertext: toBase64Url(tampered),
    }, "alice")).rejects.toThrow(/corrupted or was modified/u);
    await expect(decryptVaultValue(created.key, encrypted, "bob")).rejects.toThrow(
      /corrupted or was modified/u,
    );
    await expect(decryptVaultValue(created.key, { ...encrypted, revision: 9 }, "alice"))
      .rejects.toThrow(/corrupted or was modified/u);
  });

  it("uses a fresh nonce for every vault write", async () => {
    const created = await wrapNewVaultKey({
      prfOutput: bytes(5),
      rpId: "localhost",
      credentialId: toBase64Url(bytes(6)),
      prfSalt: bytes(7),
    });
    const first = await encryptVaultValue(created.key, { same: true }, "default", 1);
    const second = await encryptVaultValue(created.key, { same: true }, "default", 2);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });
});
