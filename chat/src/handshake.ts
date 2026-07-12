import type { ContactManifest } from "./crypto";
import { fromBase64Url } from "./encoding";

export const HANDSHAKE_TTL_MS = 24 * 60 * 60 * 1_000;
export const HANDSHAKE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const MAX_PENDING_OFFERS = 16;
export const MAX_PENDING_REQUESTS = 32;
export const MAX_INCOMING_REQUESTS = 32;

export interface SessionRequest {
  v: 2;
  type: "session-request";
  id: string;
  reply: string;
  senderName: string;
  contactCode: string;
  expiresAt: number;
  signature: string;
}

export interface SessionOffer {
  v: 2;
  type: "session-offer";
  id: string;
  key: string;
  signature: string;
}

function encodedBytes(value: unknown, length: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  if (bytes.length !== length) throw new Error(`${label} must encode ${length} bytes`);
  return value;
}

export function parseSessionRequest(value: unknown): SessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session request");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 2 || record.type !== "session-request") {
    throw new Error("Unsupported session request");
  }
  if (
    typeof record.senderName !== "string" ||
    record.senderName !== record.senderName.trim().toLowerCase() ||
    !record.senderName.endsWith(".gwei") ||
    record.senderName.length > 260
  ) {
    throw new Error("Session request has an invalid sender name");
  }
  if (
    typeof record.contactCode !== "string" ||
    record.contactCode.length === 0 ||
    record.contactCode.length > 2_048
  ) {
    throw new Error("Session request has an invalid contact code");
  }
  if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= 0) {
    throw new Error("Session request has an invalid expiry");
  }
  return {
    v: 2,
    type: "session-request",
    id: encodedBytes(record.id, 16, "request ID"),
    reply: encodedBytes(record.reply, 32, "reply key"),
    senderName: record.senderName,
    contactCode: record.contactCode,
    expiresAt: record.expiresAt as number,
    signature: encodedBytes(record.signature, 64, "request signature"),
  };
}

export function parseSessionOffer(value: unknown): SessionOffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session offer");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 2 || record.type !== "session-offer") {
    throw new Error("Unsupported session offer");
  }
  return {
    v: 2,
    type: "session-offer",
    id: encodedBytes(record.id, 16, "request ID"),
    key: encodedBytes(record.key, 32, "one-time key"),
    signature: encodedBytes(record.signature, 64, "offer signature"),
  };
}

export function canonicalSessionRequest(
  request: Pick<
    SessionRequest,
    "id" | "reply" | "senderName" | "contactCode" | "expiresAt"
  >,
  recipient: Pick<ContactManifest, "s" | "i" | "d">,
): string {
  return JSON.stringify({
    v: 2,
    type: "gwei.chat/session-request",
    request: request.id,
    reply: request.reply,
    senderName: request.senderName,
    senderContactCode: request.contactCode,
    expiresAt: request.expiresAt,
    recipientSigningKey: recipient.s,
    recipientIdentityKey: recipient.i,
    recipientDeliveryKey: recipient.d,
  });
}

export function canonicalSessionOffer(
  requestId: string,
  replyKey: string,
  recipient: Pick<ContactManifest, "s" | "i">,
  oneTimeKey: string,
): string {
  return JSON.stringify({
    v: 2,
    type: "gwei.chat/session-offer",
    request: requestId,
    reply: replyKey,
    recipientSigningKey: recipient.s,
    recipientIdentityKey: recipient.i,
    oneTimeKey,
  });
}
