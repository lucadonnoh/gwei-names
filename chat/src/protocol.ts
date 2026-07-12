import {
  acceptInbound,
  createIdentity,
  createOneTimeKey,
  decodeContactCode,
  decryptSession,
  encodeContactCode,
  encryptSession,
  fingerprint,
  forgetOneTimeKey,
  initializeCrypto,
  ownBundle,
  signPayload,
  startOutbound,
  upgradeIdentity,
  validateBundle,
  verifyPayload,
} from "./crypto";
import type { ContactBundle } from "./crypto";
import { fromBase64Url, toBase64Url, utf8 } from "./encoding";
import type { ByteSource } from "./encoding";
import { generateDeliveryKeyPair, openEnvelope, sealEnvelope } from "./envelope";
import {
  HANDSHAKE_CLOCK_SKEW_MS,
  HANDSHAKE_TTL_MS,
  MAX_INCOMING_REQUESTS,
  MAX_PENDING_OFFERS,
  MAX_PENDING_REQUESTS,
  canonicalSessionOffer,
  canonicalSessionRequest,
  parseSessionOffer,
  parseSessionRequest,
} from "./handshake";
import type { SessionOffer, SessionRequest } from "./handshake";
import {
  mutateState,
  readState,
  requestPersistentStorage,
  resetState,
} from "./storage";
import type {
  ContactRecord,
  IncomingSessionRequestRecord,
  OutboxRecord,
  PendingSessionRequest,
  PrivateState,
} from "./storage";

export const MAX_MESSAGE_BYTES = 600;

interface ApplicationMessage {
  v: 0;
  id: string;
  body: string;
  sentAt: number;
  from?: unknown;
  to?: unknown;
  request?: unknown;
}

interface PrekeyEnvelope {
  v: 2;
  type: "prekey";
  request: string;
  identity: string;
  message: string;
}

interface RatchetEnvelope {
  v: 1;
  type: "message";
  session: string;
  message: string;
}

type PrivateEnvelope = SessionRequest | SessionOffer | PrekeyEnvelope | RatchetEnvelope;

export type ContactConnectionState =
  | "connected"
  | "ready"
  | "waiting"
  | "accepted"
  | "not-started";

export interface ProtocolContact extends ContactRecord {
  connectionState: ContactConnectionState;
}

export interface ProtocolSnapshot {
  contactCode: string | null;
  publishedGweiName: string | null;
  contacts: ProtocolContact[];
  incomingRequests: IncomingRequestSnapshot[];
  unverifiedRequestCount: number;
  outboxCount: number;
}

export interface IncomingRequestSnapshot {
  id: string;
  senderName: string;
  contactId: string;
  receivedAt: number;
}

export interface IncomingRequestVerification {
  id: string;
  senderName: string;
  senderContactCode: string;
}

export interface PreparedMessage {
  messageId: string;
  contactId: string;
  text: string;
  sentAt: number;
}

export interface ReceivedMessage extends PreparedMessage {
  kind: "message";
  contact: ContactRecord;
}

export interface ReceivedHandshake {
  kind: "handshake";
  phase: "request" | "offer";
  contactId: string | null;
  requestId: string | null;
  responseQueued: boolean;
}

export type ReceivedEvent = ReceivedMessage | ReceivedHandshake;

export interface TransportEnvelope {
  transportId: string;
  envelope: ByteSource;
}

export interface ReceivedTransportEvent {
  transportId: string;
  event: ReceivedEvent;
}

export interface PendingEnvelope extends OutboxRecord {
  bytes: Uint8Array;
}

export interface SessionRequestResult {
  state: ContactConnectionState;
  queued: boolean;
}

export interface AcceptedSessionRequest {
  contact: ContactRecord;
  queued: boolean;
}

function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function normalizedLabel(label: unknown, fallback: string): string {
  const value = String(label || "").trim().replace(/\s+/gu, " ").slice(0, 40);
  return value || fallback;
}

function sameContactKeys(left: ContactBundle, right: ContactBundle): boolean {
  return left.s === right.s && left.i === right.i && left.d === right.d;
}

function pendingRequestForContact(
  state: PrivateState,
  contactId: string,
  now = Date.now(),
): PendingSessionRequest | undefined {
  return Object.values(state.sessionRequests).find(
    (request) => request.contactId === contactId && now - request.createdAt <= HANDSHAKE_TTL_MS,
  );
}

function connectionState(
  state: PrivateState,
  contact: ContactRecord,
  now = Date.now(),
): ContactConnectionState {
  if (contact.sessionId && state.sessions[contact.sessionId]) return "connected";
  const request = pendingRequestForContact(state, contact.id, now);
  if (request) return request.oneTimeKey ? "ready" : "waiting";
  const accepted = Object.values(state.sessionOffers).some(
    (offer) => offer.contactId === contact.id && now - offer.createdAt <= HANDSHAKE_TTL_MS,
  );
  return accepted ? "accepted" : "not-started";
}

function rememberHandledRequest(state: PrivateState, requestId: string): void {
  if (!state.handledSessionRequests.includes(requestId)) {
    state.handledSessionRequests.push(requestId);
  }
  if (state.handledSessionRequests.length > 512) {
    state.handledSessionRequests.splice(0, state.handledSessionRequests.length - 512);
  }
}

function removeOutboxIds(state: PrivateState, ids: Set<string>): void {
  if (ids.size === 0) return;
  state.outbox = state.outbox.filter((item) => !ids.has(item.messageId));
}

function pruneHandshakes(state: PrivateState, now = Date.now()): void {
  const staleOutbox = new Set<string>();
  for (const [id, request] of Object.entries(state.sessionRequests)) {
    if (now - request.createdAt <= HANDSHAKE_TTL_MS) continue;
    staleOutbox.add(request.outboxId);
    delete state.sessionRequests[id];
  }
  for (const [id, offer] of Object.entries(state.sessionOffers)) {
    if (now - offer.createdAt <= HANDSHAKE_TTL_MS) continue;
    staleOutbox.add(offer.outboxId);
    if (state.identity) {
      try {
        state.identity.accountPickle = forgetOneTimeKey(state.identity, offer.oneTimeKey);
      } catch {
        // A consumed or already-pruned key is safe to forget from protocol state.
      }
    }
    delete state.sessionOffers[id];
  }
  for (const [id, request] of Object.entries(state.incomingSessionRequests)) {
    if (request.expiresAt + HANDSHAKE_CLOCK_SKEW_MS >= now) continue;
    rememberHandledRequest(state, id);
    delete state.incomingSessionRequests[id];
  }
  removeOutboxIds(state, staleOutbox);
}

function cancelRequestsForContact(state: PrivateState, contactId: string): void {
  const outboxIds = new Set<string>();
  for (const [id, request] of Object.entries(state.sessionRequests)) {
    if (request.contactId !== contactId) continue;
    outboxIds.add(request.outboxId);
    delete state.sessionRequests[id];
  }
  removeOutboxIds(state, outboxIds);
}

function cancelIncomingRequestsForContact(state: PrivateState, contactId: string): void {
  for (const [id, request] of Object.entries(state.incomingSessionRequests)) {
    if (request.senderId !== contactId) continue;
    rememberHandledRequest(state, id);
    delete state.incomingSessionRequests[id];
  }
}

function parseApplicationMessage(plaintext: string): ApplicationMessage {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new Error("Invalid encrypted application message");
  }

  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 0) {
    throw new Error("Invalid encrypted application message");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > 64 ||
    typeof record.body !== "string" ||
    utf8(record.body).length > MAX_MESSAGE_BYTES
  ) {
    throw new Error("Invalid encrypted application message");
  }

  const now = Date.now();
  const earliest = Date.UTC(2020, 0, 1);
  const sentAt = typeof record.sentAt === "number" &&
    Number.isSafeInteger(record.sentAt) &&
    record.sentAt >= earliest &&
    record.sentAt <= now + 86_400_000
    ? record.sentAt
    : now;

  return {
    v: 0,
    id: record.id,
    body: record.body,
    sentAt,
    ...(Object.hasOwn(record, "from") ? { from: record.from } : {}),
    ...(Object.hasOwn(record, "to") ? { to: record.to } : {}),
    ...(Object.hasOwn(record, "request") ? { request: record.request } : {}),
  };
}

function parsePrivateEnvelope(value: unknown): PrivateEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid private envelope");
  }
  const record = value as Record<string, unknown>;
  if (record.type === "session-request") return parseSessionRequest(record);
  if (record.type === "session-offer") return parseSessionOffer(record);
  if (
    record.v === 2 && record.type === "prekey" &&
    typeof record.request === "string" && typeof record.identity === "string" &&
    typeof record.message === "string"
  ) {
    return {
      v: 2,
      type: "prekey",
      request: record.request,
      identity: record.identity,
      message: record.message,
    };
  }
  // Existing ratchets survive the contact-bundle migration, so accept their v0 wrapper too.
  if (
    (record.v === 0 || record.v === 1) && record.type === "message" &&
    typeof record.session === "string" && typeof record.message === "string"
  ) {
    return { v: 1, type: "message", session: record.session, message: record.message };
  }
  throw new Error("Unsupported private envelope");
}

function rememberTransportId(state: PrivateState, transportId: string): void {
  state.seen.push(transportId);
  if (state.seen.length > 512) state.seen.splice(0, state.seen.length - 512);
}

export async function initializeProtocol(): Promise<NonNullable<PrivateState["identity"]>> {
  await initializeCrypto();
  const identity = await mutateState(async (state) => {
    if (!state.identity) {
      state.identity = await createIdentity();
      state.freshIdentityCreatedAt = Date.now();
    }
    const upgraded = upgradeIdentity(state.identity);
    state.identity = upgraded.identity;
    if (upgraded.upgraded) {
      // The GNS record still contains the v0 contact code until the owner republishes it.
      state.publishedGweiName = null;
      state.outbox = [];
    }
    pruneHandshakes(state);
    return state.identity;
  });
  void requestPersistentStorage();
  return identity;
}

export async function getSnapshot(): Promise<ProtocolSnapshot> {
  const state = await readState();
  const now = Date.now();
  return {
    contactCode: state.identity ? encodeContactCode(state.identity) : null,
    publishedGweiName: state.publishedGweiName,
    contacts: Object.values(state.contacts)
      .map((contact) => ({ ...contact, connectionState: connectionState(state, contact, now) }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    incomingRequests: Object.values(state.incomingSessionRequests)
      .filter((request) => request.verifiedAt !== null && request.expiresAt >= now)
      .map((request) => ({
        id: request.id,
        senderName: request.senderName,
        contactId: request.senderId,
        receivedAt: request.receivedAt,
      }))
      .sort((left, right) => right.receivedAt - left.receivedAt),
    unverifiedRequestCount: Object.values(state.incomingSessionRequests)
      .filter((request) => request.verifiedAt === null && request.expiresAt >= now).length,
    outboxCount: state.outbox.length,
  };
}

export async function getUnverifiedSessionRequests(): Promise<IncomingRequestVerification[]> {
  const state = await readState();
  const now = Date.now();
  return Object.values(state.incomingSessionRequests)
    .filter((request) => request.verifiedAt === null && request.expiresAt >= now)
    .map((request) => ({
      id: request.id,
      senderName: request.senderName,
      senderContactCode: request.senderContactCode,
    }));
}

export async function verifySessionRequest(
  requestId: string,
  senderName: string,
  senderContactCode: string,
): Promise<void> {
  const bundle = await decodeContactCode(senderContactCode);
  await mutateState((state) => {
    pruneHandshakes(state);
    const request = state.incomingSessionRequests[requestId];
    if (!request) throw new Error("Chat request is no longer available");
    if (
      request.senderName !== senderName.trim().toLowerCase() ||
      request.senderContactCode !== senderContactCode ||
      request.senderId !== bundle.s
    ) {
      throw new Error("The current GNS record does not match this chat request");
    }
    request.verifiedAt = Date.now();
  });
}

export async function rememberPublishedGweiName(name: string): Promise<string> {
  const normalized = name.trim().toLowerCase();
  if (!normalized.endsWith(".gwei") || normalized.length > 260) {
    throw new Error("Invalid published GNS name");
  }
  await mutateState((state) => {
    state.publishedGweiName = normalized;
  });
  return normalized;
}

export async function importContact(code: string, label: string): Promise<ContactRecord> {
  const bundle = await decodeContactCode(code);
  const shortFingerprint = await fingerprint(bundle.s);

  return mutateState((state) => {
    if (!state.identity) throw new Error("Identity is not initialized");
    if (bundle.s === state.identity.manifest.s) throw new Error("That is your own contact code");

    const existing = state.contacts[bundle.s];
    if (existing && !sameContactKeys(existing.bundle, bundle)) {
      throw new Error("This contact changed cryptographic keys; add it as a fresh profile");
    }

    const contact = existing || {
      id: bundle.s,
      bundle,
      label: shortFingerprint,
      sessionId: null,
      createdAt: Date.now(),
    };
    contact.bundle = bundle;
    contact.label = normalizedLabel(label, contact.label);
    state.contacts[contact.id] = contact;
    return contact;
  });
}

export async function requestSession(contactId: string): Promise<SessionRequestResult> {
  return mutateState(async (state) => {
    pruneHandshakes(state);
    const identity = state.identity;
    const contact = state.contacts[contactId];
    if (!identity || !contact) throw new Error("Unknown contact");
    if (!state.publishedGweiName) {
      throw new Error("Publish your .gwei identity before starting a chat");
    }

    const current = connectionState(state, contact);
    if (current !== "not-started") return { state: current, queued: false };
    if (Object.keys(state.sessionRequests).length >= MAX_PENDING_REQUESTS) {
      throw new Error("Too many new chats are waiting; try again after one completes");
    }

    const reply = await generateDeliveryKeyPair();
    const id = randomId();
    const outboxId = randomId();
    const unsignedRequest = {
      id,
      reply: reply.publicKey,
      senderName: state.publishedGweiName,
      contactCode: encodeContactCode(identity),
      expiresAt: Date.now() + HANDSHAKE_TTL_MS,
    };
    const request: SessionRequest = {
      v: 2,
      type: "session-request",
      ...unsignedRequest,
      signature: signPayload(
        identity,
        canonicalSessionRequest(unsignedRequest, contact.bundle),
      ),
    };
    const envelope = await sealEnvelope(contact.bundle.d, request);
    state.sessionRequests[id] = {
      id,
      contactId,
      replyPublicKey: reply.publicKey,
      replyPrivateKey: reply.privateKey,
      oneTimeKey: null,
      outboxId,
      createdAt: Date.now(),
    };
    state.outbox.push({
      messageId: outboxId,
      contactId,
      envelope: toBase64Url(envelope),
      createdAt: Date.now(),
    });
    return { state: "waiting", queued: true };
  });
}

export async function ignoreSessionRequest(requestId: string): Promise<void> {
  await mutateState((state) => {
    const request = state.incomingSessionRequests[requestId];
    if (!request) return;
    delete state.incomingSessionRequests[requestId];
    rememberHandledRequest(state, requestId);
  });
}

export async function acceptSessionRequest(
  requestId: string,
  currentContactCode: string,
): Promise<AcceptedSessionRequest> {
  const bundle = await decodeContactCode(currentContactCode);
  return mutateState(async (state) => {
    pruneHandshakes(state);
    const identity = state.identity;
    const request = state.incomingSessionRequests[requestId];
    if (!identity || !request || request.verifiedAt === null) {
      throw new Error("Chat request is not verified or is no longer available");
    }
    if (request.senderContactCode !== currentContactCode || request.senderId !== bundle.s) {
      throw new Error("The sender's GNS contact record changed; request a new chat");
    }
    if (Object.keys(state.sessionOffers).length >= MAX_PENDING_OFFERS) {
      throw new Error("Too many accepted chats are waiting for a first message");
    }

    const existing = state.contacts[bundle.s];
    if (existing && !sameContactKeys(existing.bundle, bundle)) {
      throw new Error("This sender changed cryptographic keys");
    }
    const contact = existing || {
      id: bundle.s,
      bundle,
      label: request.senderName,
      sessionId: null,
      createdAt: Date.now(),
    };
    contact.bundle = bundle;
    if (!existing) contact.label = request.senderName;
    state.contacts[contact.id] = contact;

    const generated = createOneTimeKey(identity);
    identity.accountPickle = generated.accountPickle;
    const signature = signPayload(
      identity,
      canonicalSessionOffer(
        request.id,
        request.replyPublicKey,
        identity.manifest,
        generated.oneTimeKey,
      ),
    );
    const offer: SessionOffer = {
      v: 2,
      type: "session-offer",
      id: request.id,
      key: generated.oneTimeKey,
      signature,
    };
    const response = await sealEnvelope(request.replyPublicKey, offer);
    const outboxId = randomId();
    state.sessionOffers[request.id] = {
      requestId: request.id,
      contactId: contact.id,
      replyPublicKey: request.replyPublicKey,
      oneTimeKey: generated.oneTimeKey,
      outboxId,
      createdAt: Date.now(),
    };
    state.outbox.push({
      messageId: outboxId,
      contactId: contact.id,
      envelope: toBase64Url(response),
      createdAt: Date.now(),
    });
    delete state.incomingSessionRequests[request.id];
    rememberHandledRequest(state, request.id);
    return { contact, queued: true };
  });
}

export async function renameContact(contactId: string, label: string): Promise<ContactRecord> {
  return mutateState((state) => {
    const contact = state.contacts[contactId];
    if (!contact) throw new Error("Unknown contact");
    contact.label = normalizedLabel(label, contact.label);
    return contact;
  });
}

export async function prepareMessage(
  contactId: string,
  rawText: string,
): Promise<PreparedMessage> {
  const text = String(rawText).trim();
  if (!text) throw new Error("Message is empty");
  if (utf8(text).length > MAX_MESSAGE_BYTES) {
    throw new Error(`Message exceeds the ${MAX_MESSAGE_BYTES}-byte prototype limit`);
  }

  return mutateState(async (state) => {
    pruneHandshakes(state);
    const identity = state.identity;
    const contact = state.contacts[contactId];
    if (!identity || !contact) throw new Error("Unknown contact");

    const messageId = randomId();
    const application: ApplicationMessage = {
      v: 0,
      id: messageId,
      sentAt: Date.now(),
      body: text,
    };

    let outer: PrekeyEnvelope | RatchetEnvelope;
    const currentSession = contact.sessionId && state.sessions[contact.sessionId];
    if (currentSession) {
      const encrypted = encryptSession(identity, currentSession.pickle, JSON.stringify(application));
      currentSession.pickle = encrypted.sessionPickle;
      outer = {
        v: 1,
        type: "message",
        session: currentSession.id,
        message: encrypted.message,
      };
    } else {
      const request = pendingRequestForContact(state, contactId);
      if (!request?.oneTimeKey) {
        throw new Error(`Waiting for ${contact.label} to accept your chat request`);
      }
      application.from = ownBundle(identity);
      application.to = contact.bundle.s;
      application.request = request.id;
      const outbound = startOutbound(
        identity,
        contact.bundle.i,
        request.oneTimeKey,
        JSON.stringify(application),
      );
      state.sessions[outbound.sessionId] = {
        id: outbound.sessionId,
        contactId: contact.id,
        pickle: outbound.sessionPickle,
      };
      contact.sessionId = outbound.sessionId;
      delete state.sessionRequests[request.id];
      removeOutboxIds(state, new Set([request.outboxId]));
      cancelIncomingRequestsForContact(state, contact.id);
      outer = {
        v: 2,
        type: "prekey",
        request: request.id,
        identity: identity.manifest.i,
        message: outbound.message,
      };
    }

    const envelope = await sealEnvelope(contact.bundle.d, outer);
    state.outbox.push({
      messageId,
      contactId,
      envelope: toBase64Url(envelope),
      createdAt: Date.now(),
    });

    return { messageId, contactId, text, sentAt: application.sentAt };
  });
}

interface OpenedPrivateEnvelope {
  value: unknown;
  replyRequestId: string | null;
}

async function openPrivateEnvelope(
  state: PrivateState,
  envelope: ByteSource,
): Promise<OpenedPrivateEnvelope | null> {
  if (!state.identity) return null;
  const direct = await openEnvelope(state.identity.deliveryPrivateKey, envelope);
  if (direct) return { value: direct, replyRequestId: null };

  for (const request of Object.values(state.sessionRequests)) {
    const reply = await openEnvelope(request.replyPrivateKey, envelope);
    if (reply) return { value: reply, replyRequestId: request.id };
  }
  return null;
}

interface CommittedEnvelope {
  event: ReceivedEvent | null;
  state: PrivateState | null;
}

async function commitOpenedEnvelope(
  transportId: string,
  snapshotIdentity: NonNullable<PrivateState["identity"]>,
  opened: OpenedPrivateEnvelope,
): Promise<CommittedEnvelope> {
  try {
    const outer = parsePrivateEnvelope(opened.value);
    let committedState: PrivateState | null = null;
    const event = await mutateState(async (state): Promise<ReceivedEvent | null> => {
      committedState = state;
      if (!state.identity || state.identity.manifest.s !== snapshotIdentity.manifest.s) return null;
      if (state.seen.includes(transportId)) return null;
      pruneHandshakes(state);

      if (outer.type === "session-request") {
        if (opened.replyRequestId !== null) throw new Error("A request used a reply-only key");
        const now = Date.now();
        if (
          outer.expiresAt < now - HANDSHAKE_CLOCK_SKEW_MS ||
          outer.expiresAt > now + HANDSHAKE_TTL_MS + HANDSHAKE_CLOCK_SKEW_MS
        ) {
          throw new Error("Session request is expired or has an invalid lifetime");
        }
        if (state.handledSessionRequests.includes(outer.id)) {
          rememberTransportId(state, transportId);
          return {
            kind: "handshake",
            phase: "request",
            contactId: null,
            requestId: outer.id,
            responseQueued: false,
          };
        }
        const sender = await decodeContactCode(outer.contactCode);
        if (sender.s === state.identity.manifest.s) throw new Error("Request is from this identity");
        const requestPayload = canonicalSessionRequest(outer, state.identity.manifest);
        if (!verifyPayload(sender.s, requestPayload, outer.signature)) {
          throw new Error("Session request signature is invalid");
        }

        const existing = state.incomingSessionRequests[outer.id];
        if (existing) {
          if (
            existing.senderName !== outer.senderName ||
            existing.senderContactCode !== outer.contactCode ||
            existing.replyPublicKey !== outer.reply ||
            existing.expiresAt !== outer.expiresAt
          ) {
            throw new Error("Request ID was reused with different contents");
          }
          rememberTransportId(state, transportId);
          return {
            kind: "handshake",
            phase: "request",
            contactId: existing.senderId,
            requestId: existing.id,
            responseQueued: false,
          };
        }
        if (Object.keys(state.incomingSessionRequests).length >= MAX_INCOMING_REQUESTS) {
          const oldestUnverified = Object.values(state.incomingSessionRequests)
            .filter((request) => request.verifiedAt === null)
            .sort((left, right) => left.receivedAt - right.receivedAt)[0];
          if (!oldestUnverified) {
            rememberTransportId(state, transportId);
            return {
              kind: "handshake",
              phase: "request",
              contactId: null,
              requestId: outer.id,
              responseQueued: false,
            };
          }
          delete state.incomingSessionRequests[oldestUnverified.id];
          rememberHandledRequest(state, oldestUnverified.id);
        }
        state.incomingSessionRequests[outer.id] = {
          id: outer.id,
          senderName: outer.senderName,
          senderContactCode: outer.contactCode,
          senderId: sender.s,
          replyPublicKey: outer.reply,
          expiresAt: outer.expiresAt,
          receivedAt: now,
          verifiedAt: null,
        };
        rememberTransportId(state, transportId);
        return {
          kind: "handshake",
          phase: "request",
          contactId: sender.s,
          requestId: outer.id,
          responseQueued: false,
        };
      }

      if (outer.type === "session-offer") {
        if (opened.replyRequestId !== outer.id) throw new Error("Offer used the wrong reply key");
        const request = state.sessionRequests[outer.id];
        if (!request) throw new Error("Offer has no pending request");
        const contact = state.contacts[request.contactId];
        if (!contact) throw new Error("Offer has no contact");
        const payload = canonicalSessionOffer(
          request.id,
          request.replyPublicKey,
          contact.bundle,
          outer.key,
        );
        if (!verifyPayload(contact.bundle.s, payload, outer.signature)) {
          throw new Error("Offer signature is invalid");
        }
        if (request.oneTimeKey && request.oneTimeKey !== outer.key) {
          throw new Error("Request received two different offers");
        }
        request.oneTimeKey = outer.key;
        rememberTransportId(state, transportId);
        return {
          kind: "handshake",
          phase: "offer",
          contactId: contact.id,
          requestId: outer.id,
          responseQueued: false,
        };
      }

      let application: ApplicationMessage;
      let contact: ContactRecord | undefined;
      if (outer.type === "prekey") {
        if (opened.replyRequestId !== null) throw new Error("Prekey used a reply-only key");
        const offer = state.sessionOffers[outer.request];
        if (!offer) throw new Error("Initial message has no matching offer");
        const inbound = acceptInbound(
          state.identity,
          outer.identity,
          offer.oneTimeKey,
          outer.message,
        );
        application = parseApplicationMessage(inbound.plaintext);
        if (application.to !== state.identity.manifest.s || application.request !== outer.request) {
          throw new Error("Initial message is bound to a different recipient or request");
        }
        const bundle = await validateBundle(application.from);
        if (bundle.i !== outer.identity) throw new Error("Sender identity mismatch");
        if (bundle.s !== offer.contactId) throw new Error("Sender does not match accepted request");

        contact = state.contacts[bundle.s];
        if (contact && !sameContactKeys(contact.bundle, bundle)) {
          throw new Error("A known contact presented different keys");
        }
        if (!contact) {
          contact = {
            id: bundle.s,
            bundle,
            label: await fingerprint(bundle.s),
            sessionId: null,
            createdAt: Date.now(),
          };
          state.contacts[contact.id] = contact;
        } else {
          contact.bundle = bundle;
        }

        state.identity.accountPickle = inbound.accountPickle;
        state.sessions[inbound.sessionId] = {
          id: inbound.sessionId,
          contactId: contact.id,
          pickle: inbound.sessionPickle,
        };
        contact.sessionId ||= inbound.sessionId;
        delete state.sessionOffers[outer.request];
        removeOutboxIds(state, new Set([offer.outboxId]));
        cancelRequestsForContact(state, contact.id);
        cancelIncomingRequestsForContact(state, contact.id);
      } else {
        if (opened.replyRequestId !== null) throw new Error("Message used a reply-only key");
        const session = state.sessions[outer.session];
        if (!session) throw new Error("Unknown encrypted session");
        contact = state.contacts[session.contactId];
        if (!contact) throw new Error("Session has no contact");

        const decrypted = decryptSession(state.identity, session.pickle, outer.message);
        application = parseApplicationMessage(decrypted.plaintext);
        session.pickle = decrypted.sessionPickle;
      }

      if (!contact) throw new Error("Encrypted message has no contact");
      rememberTransportId(state, transportId);
      return {
        kind: "message",
        messageId: application.id,
        contactId: contact.id,
        text: application.body,
        sentAt: application.sentAt,
        contact,
      };
    });
    return { event, state: committedState };
  } catch {
    // Public delivery keys allow anyone to submit an envelope. Invalid private
    // envelopes are intentionally indistinguishable from traffic for others.
    return { event: null, state: null };
  }
}

export async function receiveEnvelope(
  transportId: string,
  envelope: ByteSource,
): Promise<ReceivedEvent | null> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(transportId)) return null;

  const snapshot = await readState();
  if (!snapshot.identity || snapshot.seen.includes(transportId)) return null;
  const opened = await openPrivateEnvelope(snapshot, envelope);
  if (!opened) return null;
  return (await commitOpenedEnvelope(transportId, snapshot.identity, opened)).event;
}

export async function receiveEnvelopes(
  envelopes: readonly TransportEnvelope[],
): Promise<ReceivedTransportEvent[]> {
  let snapshot = await readState();
  if (!snapshot.identity) return [];

  const received: ReceivedTransportEvent[] = [];
  for (const item of envelopes) {
    const identity = snapshot.identity;
    if (!identity) break;
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(item.transportId) ||
      snapshot.seen.includes(item.transportId)
    ) {
      continue;
    }
    const opened = await openPrivateEnvelope(snapshot, item.envelope);
    if (!opened) continue;
    const committed = await commitOpenedEnvelope(item.transportId, identity, opened);
    if (committed.state) snapshot = committed.state;
    if (committed.event) received.push({ transportId: item.transportId, event: committed.event });
  }
  return received;
}

export async function getOutbox(): Promise<PendingEnvelope[]> {
  const state = await readState();
  return state.outbox.map((item) => ({ ...item, bytes: fromBase64Url(item.envelope) }));
}

export async function acknowledgeOutbox(messageId: string): Promise<void> {
  return mutateState((state) => {
    state.outbox = state.outbox.filter((item) => item.messageId !== messageId);
  });
}

export async function getBatchCursor(): Promise<number> {
  return (await readState()).batchCursor;
}

export async function advanceBatchCursor(sequence: number): Promise<number> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Invalid batch cursor");
  }
  return mutateState((state) => {
    state.batchCursor = Math.max(state.batchCursor, sequence);
    return state.batchCursor;
  });
}

export async function getOnchainBatchCursor(): Promise<number> {
  return (await readState()).onchainBatchCursor;
}

export async function establishFreshIdentityOnchainBaseline(options: {
  sequence: number;
  finalizedAt: number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 0) {
    throw new RangeError("Invalid onchain baseline cursor");
  }
  if (!Number.isSafeInteger(options.finalizedAt) || options.finalizedAt < 0) {
    throw new RangeError("Invalid finalized block timestamp");
  }
  return mutateState((state) => {
    const createdAt = state.freshIdentityCreatedAt;
    if (createdAt === null) return false;
    // A finalized block from before this delivery key existed cannot contain
    // an envelope for it. If an endpoint was unavailable for so long that its
    // finalized head is newer, retain the conservative history scan instead.
    if (options.finalizedAt <= createdAt) {
      state.onchainBatchCursor = Math.max(state.onchainBatchCursor, options.sequence);
    }
    state.freshIdentityCreatedAt = null;
    return options.finalizedAt <= createdAt;
  });
}

export async function advanceOnchainBatchCursor(sequence: number): Promise<number> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Invalid onchain batch cursor");
  }
  return mutateState((state) => {
    state.onchainBatchCursor = Math.max(state.onchainBatchCursor, sequence);
    return state.onchainBatchCursor;
  });
}

export async function resetProtocol(): Promise<void> {
  await resetState();
}
