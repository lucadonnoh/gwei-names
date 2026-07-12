import type { ContactBundle, PrivateIdentity } from "./crypto";
import {
  createPasskeyVault,
  decryptVaultValue,
  encryptVaultValue,
  forgetPasskeyCredential,
  parseEncryptedVaultRecord,
  parsePasskeyVaultConfig,
  unlockPasskeyVault,
} from "./vault";
import type { EncryptedVaultRecord, PasskeyVaultConfig } from "./vault";

const params = new URLSearchParams(location.search);
const requestedProfile = params.get("profile") || "default";

export const profile = requestedProfile.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 32) || "default";

const DATABASE_NAME = `gwei-chat-prototype-v0:${profile}`;
const DATABASE_VERSION = 1;
const STORE_NAME = "private-state";
const STATE_KEY = "state";
const VAULT_CONFIG_KEY = "vault-config";
const VAULT_STATE_KEY = "vault-state";
const LOCK_NAME = `${DATABASE_NAME}:write`;
const loopback = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
const developmentBypassRequested = loopback && params.get("vault") === "off";

export interface ContactRecord {
  id: string;
  bundle: ContactBundle;
  label: string;
  sessionId: string | null;
  createdAt: number;
}

export interface SessionRecord {
  id: string;
  contactId: string;
  pickle: string;
}

export interface OutboxRecord {
  messageId: string;
  contactId: string;
  envelope: string;
  createdAt: number;
}

export interface PendingSessionRequest {
  id: string;
  contactId: string;
  replyPublicKey: string;
  replyPrivateKey: string;
  oneTimeKey: string | null;
  outboxId: string;
  createdAt: number;
}

export interface PendingSessionOffer {
  requestId: string;
  contactId: string;
  replyPublicKey: string;
  oneTimeKey: string;
  outboxId: string;
  createdAt: number;
}

export interface IncomingSessionRequestRecord {
  id: string;
  senderName: string;
  senderContactCode: string;
  senderId: string;
  replyPublicKey: string;
  expiresAt: number;
  receivedAt: number;
  verifiedAt: number | null;
}

export interface RelayPassState {
  name: string | null;
  utcDate: string;
  fingerprint: string;
  session: string | null;
  tokens: string[];
}

export interface PrivateState {
  v: 0;
  handshakeVersion: 2;
  identity: PrivateIdentity | null;
  publishedGweiName: string | null;
  contacts: Record<string, ContactRecord>;
  sessions: Record<string, SessionRecord>;
  sessionRequests: Record<string, PendingSessionRequest>;
  sessionOffers: Record<string, PendingSessionOffer>;
  incomingSessionRequests: Record<string, IncomingSessionRequestRecord>;
  handledSessionRequests: string[];
  outbox: OutboxRecord[];
  seen: string[];
  batchCursor: number;
  onchainBatchCursor: number;
  freshIdentityCreatedAt: number | null;
  relayPasses: Record<string, RelayPassState>;
}

let databasePromise: Promise<IDBDatabase> | undefined;
let fallbackQueue: Promise<void> = Promise.resolve();
let vaultKey: CryptoKey | null = null;
let vaultRevision = -1;
let developmentBypassActive = false;

export type VaultBootstrap =
  | { status: "setup"; hasExistingState: boolean }
  | { status: "locked"; hasExistingState: true }
  | { status: "unlocked"; hasExistingState: true }
  | { status: "development"; hasExistingState: boolean };

function emptyState(): PrivateState {
  return {
    v: 0,
    handshakeVersion: 2,
    identity: null,
    publishedGweiName: null,
    contacts: {},
    sessions: {},
    sessionRequests: {},
    sessionOffers: {},
    incomingSessionRequests: {},
    handledSessionRequests: [],
    outbox: [],
    seen: [],
    batchCursor: -1,
    onchainBatchCursor: -1,
    freshIdentityCreatedAt: null,
    relayPasses: {},
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener(
        "upgradeneeded",
        () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
  }

  return databasePromise;
}

async function readStoredValues(keys: string[]): Promise<unknown[]> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const requests = keys.map((key) => requestResult<unknown>(store.get(key)));
  const values = await Promise.all([...requests, transactionFinished(transaction)]);
  return values.slice(0, keys.length);
}

async function deleteStoredValue(key: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(key);
  await transactionFinished(transaction);
}

async function writeEncryptedRecord(record: EncryptedVaultRecord): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(record, VAULT_STATE_KEY);
  await transactionFinished(transaction);
}

async function writePasskeySetup(
  config: PasskeyVaultConfig,
  encrypted: EncryptedVaultRecord,
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.put(config, VAULT_CONFIG_KEY);
  store.put(encrypted, VAULT_STATE_KEY);
  store.delete(STATE_KEY);
  await transactionFinished(transaction);
}

function normalizeState(value: unknown): PrivateState {
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 0) {
    throw new Error("Unsupported private state version");
  }

  const state = value as PrivateState & {
    publishedGweiName?: unknown;
    batchCursor?: unknown;
    onchainBatchCursor?: unknown;
    freshIdentityCreatedAt?: unknown;
    relayPasses?: unknown;
    sessionRequests?: unknown;
    sessionOffers?: unknown;
    handshakeVersion?: unknown;
    incomingSessionRequests?: unknown;
    handledSessionRequests?: unknown;
  };
  if (
    !state.contacts ||
    typeof state.contacts !== "object" ||
    !state.sessions ||
    typeof state.sessions !== "object" ||
    !Array.isArray(state.outbox) ||
    !Array.isArray(state.seen)
  ) {
    throw new Error("Private state is malformed");
  }

  // Profiles created before guided onboarding did not remember their last successful publication.
  if (state.publishedGweiName === undefined) state.publishedGweiName = null;
  if (
    state.publishedGweiName !== null &&
    (typeof state.publishedGweiName !== "string" ||
      state.publishedGweiName.length === 0 ||
      state.publishedGweiName.length > 260)
  ) {
    throw new Error("Private state has an invalid published GNS name");
  }

  // Handshake v1 used anonymous auto-accepted requests and cannot be resumed safely as v2.
  if (state.handshakeVersion === undefined) {
    state.handshakeVersion = 2;
    state.sessionRequests = {};
    state.sessionOffers = {};
    state.incomingSessionRequests = {};
    state.handledSessionRequests = [];
    state.outbox = [];
  }
  if (state.handshakeVersion !== 2) throw new Error("Unsupported handshake state version");

  if (state.sessionRequests === undefined) state.sessionRequests = {};
  if (state.sessionOffers === undefined) state.sessionOffers = {};
  if (state.incomingSessionRequests === undefined) state.incomingSessionRequests = {};
  if (state.handledSessionRequests === undefined) state.handledSessionRequests = [];
  if (
    !state.sessionRequests || typeof state.sessionRequests !== "object" ||
    Array.isArray(state.sessionRequests) ||
    !state.sessionOffers || typeof state.sessionOffers !== "object" ||
    Array.isArray(state.sessionOffers) ||
    !state.incomingSessionRequests || typeof state.incomingSessionRequests !== "object" ||
    Array.isArray(state.incomingSessionRequests) ||
    !Array.isArray(state.handledSessionRequests) ||
    !state.handledSessionRequests.every((id) => typeof id === "string")
  ) {
    throw new Error("Private state has malformed session handshakes");
  }
  for (const [id, request] of Object.entries(
    state.sessionRequests as Record<string, PendingSessionRequest>,
  )) {
    if (
      !request || typeof request !== "object" || request.id !== id ||
      typeof request.contactId !== "string" ||
      typeof request.replyPublicKey !== "string" ||
      typeof request.replyPrivateKey !== "string" ||
      (request.oneTimeKey !== null && typeof request.oneTimeKey !== "string") ||
      typeof request.outboxId !== "string" ||
      !Number.isSafeInteger(request.createdAt) || request.createdAt < 0
    ) {
      throw new Error("Private state has a malformed session request");
    }
  }
  for (const [id, offer] of Object.entries(
    state.sessionOffers as Record<string, PendingSessionOffer>,
  )) {
    if (
      !offer || typeof offer !== "object" || offer.requestId !== id ||
      typeof offer.contactId !== "string" ||
      typeof offer.replyPublicKey !== "string" ||
      typeof offer.oneTimeKey !== "string" ||
      typeof offer.outboxId !== "string" ||
      !Number.isSafeInteger(offer.createdAt) || offer.createdAt < 0
    ) {
      throw new Error("Private state has a malformed session offer");
    }
  }
  for (const [id, request] of Object.entries(
    state.incomingSessionRequests as Record<string, IncomingSessionRequestRecord>,
  )) {
    if (
      !request || typeof request !== "object" || request.id !== id ||
      typeof request.senderName !== "string" ||
      typeof request.senderContactCode !== "string" ||
      typeof request.senderId !== "string" ||
      typeof request.replyPublicKey !== "string" ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= 0 ||
      !Number.isSafeInteger(request.receivedAt) || request.receivedAt < 0 ||
      (request.verifiedAt !== null &&
        (!Number.isSafeInteger(request.verifiedAt) || request.verifiedAt < 0))
    ) {
      throw new Error("Private state has a malformed incoming session request");
    }
  }

  // Profiles created by the live-only prototype predate blob cursors.
  if (state.batchCursor === undefined) state.batchCursor = -1;
  if (!Number.isSafeInteger(state.batchCursor) || Number(state.batchCursor) < -1) {
    throw new Error("Private state has an invalid batch cursor");
  }
  if (state.onchainBatchCursor === undefined) state.onchainBatchCursor = -1;
  if (!Number.isSafeInteger(state.onchainBatchCursor) || Number(state.onchainBatchCursor) < -1) {
    throw new Error("Private state has an invalid onchain batch cursor");
  }
  // Only identities created by versions that know how to establish a safe
  // finalized-head baseline carry this marker. Legacy identities scan their
  // unread availability interval conservatively.
  if (state.freshIdentityCreatedAt === undefined) state.freshIdentityCreatedAt = null;
  if (
    state.freshIdentityCreatedAt !== null &&
    (!Number.isSafeInteger(state.freshIdentityCreatedAt) || state.freshIdentityCreatedAt < 0)
  ) {
    throw new Error("Private state has an invalid fresh-identity timestamp");
  }
  if (state.relayPasses === undefined) state.relayPasses = {};
  if (!state.relayPasses || typeof state.relayPasses !== "object" || Array.isArray(state.relayPasses)) {
    throw new Error("Private state has malformed relay passes");
  }
  for (const [batcher, admission] of Object.entries(
    state.relayPasses as Record<string, RelayPassState>,
  )) {
    if (
      !batcher || batcher.length > 1_024 ||
      !admission || typeof admission !== "object" ||
      (admission.name !== null && typeof admission.name !== "string") ||
      typeof admission.utcDate !== "string" ||
      typeof admission.fingerprint !== "string" ||
      (admission.session !== null && typeof admission.session !== "string") ||
      !Array.isArray(admission.tokens) ||
      !admission.tokens.every((token) => typeof token === "string")
    ) {
      throw new Error("Private state has malformed relay passes");
    }
  }
  return state as PrivateState;
}

async function readRawState(): Promise<PrivateState> {
  if (developmentBypassActive) {
    const [state] = await readStoredValues([STATE_KEY]);
    return state === undefined ? emptyState() : normalizeState(state);
  }
  if (!vaultKey) throw new Error("The private chat vault is locked");
  const [recordValue] = await readStoredValues([VAULT_STATE_KEY]);
  if (recordValue === undefined) throw new Error("Encrypted vault state is missing");
  const record = parseEncryptedVaultRecord(recordValue);
  const state = normalizeState(await decryptVaultValue(vaultKey, record, profile));
  vaultRevision = Math.max(vaultRevision, record.revision);
  return state;
}

async function writeRawState(state: PrivateState): Promise<void> {
  if (developmentBypassActive) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
    await transactionFinished(transaction);
    return;
  }
  if (!vaultKey) throw new Error("The private chat vault is locked");
  const revision = vaultRevision + 1;
  const encrypted = await encryptVaultValue(vaultKey, state, profile, revision);
  await writeEncryptedRecord(encrypted);
  vaultRevision = revision;
}

async function withWriteLock<T>(callback: () => Promise<T> | T): Promise<T> {
  if (navigator.locks) {
    return navigator.locks.request(LOCK_NAME, callback);
  }

  const operation = fallbackQueue.then(callback, callback);
  fallbackQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function getVaultBootstrap(): Promise<VaultBootstrap> {
  const [configValue, encryptedValue, legacyState] = await readStoredValues([
    VAULT_CONFIG_KEY,
    VAULT_STATE_KEY,
    STATE_KEY,
  ]);
  if (
    developmentBypassRequested &&
    configValue === undefined &&
    encryptedValue === undefined
  ) {
    developmentBypassActive = true;
    return { status: "development", hasExistingState: legacyState !== undefined };
  }
  developmentBypassActive = false;

  if (configValue === undefined && encryptedValue === undefined) {
    vaultKey = null;
    vaultRevision = -1;
    return { status: "setup", hasExistingState: legacyState !== undefined };
  }
  if (configValue === undefined || encryptedValue === undefined) {
    throw new Error("The private chat vault setup is incomplete");
  }
  parsePasskeyVaultConfig(configValue);
  const encrypted = parseEncryptedVaultRecord(encryptedValue);
  vaultRevision = Math.max(vaultRevision, encrypted.revision);
  return vaultKey
    ? { status: "unlocked", hasExistingState: true }
    : { status: "locked", hasExistingState: true };
}

export async function setupPasskeyProtection(): Promise<void> {
  await withWriteLock(async () => {
    const [configValue, encryptedValue, legacyValue] = await readStoredValues([
      VAULT_CONFIG_KEY,
      VAULT_STATE_KEY,
      STATE_KEY,
    ]);
    if (configValue !== undefined || encryptedValue !== undefined) {
      throw new Error("A private chat vault already exists");
    }
    const state = legacyValue === undefined ? emptyState() : normalizeState(legacyValue);
    const created = await createPasskeyVault(location.hostname);
    try {
      const encrypted = await encryptVaultValue(created.key, state, profile, 0);
      await writePasskeySetup(created.config, encrypted);
    } catch (error) {
      await forgetPasskeyCredential(created.config);
      throw error;
    }
    developmentBypassActive = false;
    vaultKey = created.key;
    vaultRevision = 0;
  });
}

export async function unlockPrivateVault(): Promise<void> {
  await withWriteLock(async () => {
    const [configValue, encryptedValue, legacyValue] = await readStoredValues([
      VAULT_CONFIG_KEY,
      VAULT_STATE_KEY,
      STATE_KEY,
    ]);
    if (configValue === undefined || encryptedValue === undefined) {
      throw new Error("No passkey-protected chat vault exists");
    }
    const config = parsePasskeyVaultConfig(configValue);
    const encrypted = parseEncryptedVaultRecord(encryptedValue);
    const key = await unlockPasskeyVault(config);
    // Authenticate and validate the complete state before retaining the key or deleting legacy data.
    normalizeState(await decryptVaultValue(key, encrypted, profile));
    vaultKey = key;
    vaultRevision = encrypted.revision;
    developmentBypassActive = false;
    if (legacyValue !== undefined) await deleteStoredValue(STATE_KEY);
  });
}

export function lockPrivateVault(): void {
  vaultKey = null;
  vaultRevision = -1;
}

export function privateVaultProtected(): boolean {
  return !developmentBypassActive && vaultKey !== null;
}

export async function destroyPrivateVault(): Promise<void> {
  await withWriteLock(async () => {
    const [configValue] = await readStoredValues([VAULT_CONFIG_KEY]);
    let config: PasskeyVaultConfig | null = null;
    if (configValue !== undefined) {
      try {
        config = parsePasskeyVaultConfig(configValue);
      } catch {
        // Destruction must remain available for a corrupt vault configuration.
      }
    }
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete(VAULT_CONFIG_KEY);
    store.delete(VAULT_STATE_KEY);
    store.delete(STATE_KEY);
    await transactionFinished(transaction);
    vaultKey = null;
    vaultRevision = -1;
    developmentBypassActive = false;
    if (config) await forgetPasskeyCredential(config);
  });
}

export async function readState(): Promise<PrivateState> {
  return readRawState();
}

export async function mutateState<T>(
  mutator: (state: PrivateState) => Promise<T> | T,
): Promise<T> {
  return withWriteLock(async () => {
    const state = await readRawState();
    const result = await mutator(state);
    await writeRawState(state);
    return result;
  });
}

export async function resetState(): Promise<void> {
  await withWriteLock(() => writeRawState(emptyState()));
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage?.persist) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  return false;
}
