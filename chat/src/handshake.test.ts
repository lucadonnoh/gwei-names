import { describe, expect, it } from "vitest";

import { toBase64Url } from "./encoding";
import {
  canonicalSessionOffer,
  canonicalSessionRequest,
  parseSessionOffer,
  parseSessionRequest,
} from "./handshake";

function key(length: number, fill: number): string {
  return toBase64Url(new Uint8Array(length).fill(fill));
}

describe("on-demand session handshake", () => {
  it("accepts only fixed-size opaque requests and signed offers", () => {
    const id = key(16, 1);
    const reply = key(32, 2);
    const oneTimeKey = key(32, 3);
    const signature = key(64, 4);
    const request = {
      v: 2 as const,
      type: "session-request" as const,
      id,
      reply,
      senderName: "alice.gwei",
      contactCode: "signed-contact-code",
      expiresAt: 1_900_000_000_000,
      signature,
    };

    expect(parseSessionRequest(request)).toEqual(request);
    expect(parseSessionOffer({
      v: 2,
      type: "session-offer",
      id,
      key: oneTimeKey,
      signature,
    })).toEqual({ v: 2, type: "session-offer", id, key: oneTimeKey, signature });

    expect(() => parseSessionRequest({
      ...request,
      id: key(15, 1),
    })).toThrow(/request ID/u);
    expect(() => parseSessionOffer({
      v: 2,
      type: "session-offer",
      id,
      key: oneTimeKey,
      signature: key(63, 4),
    })).toThrow(/signature/u);
  });

  it("binds every routing and identity input into the recipient signature", () => {
    const request = key(16, 1);
    const reply = key(32, 2);
    const recipient = { s: key(32, 3), i: key(32, 4), d: key(32, 6) };
    const oneTimeKey = key(32, 5);
    const canonical = canonicalSessionOffer(request, reply, recipient, oneTimeKey);

    expect(canonicalSessionOffer(key(16, 9), reply, recipient, oneTimeKey)).not.toBe(canonical);
    expect(canonicalSessionOffer(request, key(32, 9), recipient, oneTimeKey)).not.toBe(canonical);
    expect(canonicalSessionOffer(request, reply, { ...recipient, s: key(32, 9) }, oneTimeKey))
      .not.toBe(canonical);
    expect(canonicalSessionOffer(request, reply, recipient, key(32, 9))).not.toBe(canonical);

    const identified = {
      id: request,
      reply,
      senderName: "alice.gwei",
      contactCode: "alice-contact",
      expiresAt: 1_900_000_000_000,
    };
    const signedRequest = canonicalSessionRequest(identified, recipient);
    expect(canonicalSessionRequest({ ...identified, senderName: "mallory.gwei" }, recipient))
      .not.toBe(signedRequest);
    expect(canonicalSessionRequest({ ...identified, contactCode: "other" }, recipient))
      .not.toBe(signedRequest);
    expect(canonicalSessionRequest({ ...identified, expiresAt: identified.expiresAt + 1 }, recipient))
      .not.toBe(signedRequest);
    expect(canonicalSessionRequest(identified, { ...recipient, d: key(32, 9) }))
      .not.toBe(signedRequest);
  });
});
