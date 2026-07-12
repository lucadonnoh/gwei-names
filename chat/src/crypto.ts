import initWasm, {
  createInbound,
  createOutbound,
  discardOneTimeKey,
  generateOneTimeKey,
  newAccount,
  sessionDecrypt,
  sessionEncrypt,
  signManifest,
  verifyManifest,
} from "./wasm/gwei_chat_crypto.js";

import { fromBase64Url, toBase64Url, utf8 } from "./encoding";
import { generateDeliveryKeyPair } from "./envelope";

interface WasmAccount {
  pickle: string;
  ed25519: string;
  curve25519: string;
}

interface WasmOneTimeKeyResult {
  account_pickle: string;
  one_time_key: string;
}

interface WasmOutboundResult {
  session_id: string;
  session_pickle: string;
  message: string;
}

interface WasmInboundResult {
  account_pickle: string;
  session_id: string;
  session_pickle: string;
  plaintext: string;
}

interface WasmSessionResult {
  session_pickle: string;
  message: string | null;
  plaintext: string | null;
}

export interface LegacyContactManifest {
  v: 0;
  s: string;
  i: string;
  f: string;
  d: string;
}

export interface LegacyContactBundle extends LegacyContactManifest {
  x: string;
}

export interface CurrentContactManifest {
  v: 1;
  s: string;
  i: string;
  d: string;
}

export interface CurrentContactBundle extends CurrentContactManifest {
  x: string;
}

export type ContactManifest = LegacyContactManifest | CurrentContactManifest;
export type ContactBundle = LegacyContactBundle | CurrentContactBundle;

export interface PrivateIdentity {
  pickleKey: string;
  accountPickle: string;
  deliveryPrivateKey: string;
  manifest: ContactManifest;
  signature: string;
}

export interface SessionStart {
  sessionId: string;
  sessionPickle: string;
  message: string;
}

export interface InboundSession {
  accountPickle: string;
  sessionId: string;
  sessionPickle: string;
  plaintext: string;
}

export interface SessionEncryption {
  sessionPickle: string;
  message: string;
}

export interface SessionDecryption {
  sessionPickle: string;
  plaintext: string;
}

export interface GeneratedOneTimeKey {
  accountPickle: string;
  oneTimeKey: string;
}

let wasmReady: Promise<unknown> | undefined;

export function initializeCrypto(): Promise<unknown> {
  wasmReady ||= initWasm();
  return wasmReady;
}

function parseResult<T>(value: string): T {
  return JSON.parse(value) as T;
}

function pickleKey(identity: PrivateIdentity): Uint8Array {
  return fromBase64Url(identity.pickleKey);
}

export function canonicalManifest(bundle: ContactManifest): string {
  return bundle.v === 0
    ? JSON.stringify({ v: 0, s: bundle.s, i: bundle.i, f: bundle.f, d: bundle.d })
    : JSON.stringify({ v: 1, s: bundle.s, i: bundle.i, d: bundle.d });
}

export function ownBundle(identity: PrivateIdentity): ContactBundle {
  return { ...identity.manifest, x: identity.signature };
}

export async function createIdentity(): Promise<PrivateIdentity> {
  await initializeCrypto();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const [account, delivery] = await Promise.all([
    Promise.resolve(parseResult<WasmAccount>(newAccount(key))),
    generateDeliveryKeyPair(),
  ]);
  const manifest: ContactManifest = {
    v: 1,
    s: account.ed25519,
    i: account.curve25519,
    d: delivery.publicKey,
  };
  const signature = signManifest(account.pickle, key, canonicalManifest(manifest));

  return {
    pickleKey: toBase64Url(key),
    accountPickle: account.pickle,
    deliveryPrivateKey: delivery.privateKey,
    manifest,
    signature,
  };
}

export function upgradeIdentity(identity: PrivateIdentity): {
  identity: PrivateIdentity;
  upgraded: boolean;
} {
  if (identity.manifest.v === 1) return { identity, upgraded: false };
  const manifest: CurrentContactManifest = {
    v: 1,
    s: identity.manifest.s,
    i: identity.manifest.i,
    d: identity.manifest.d,
  };
  return {
    identity: {
      ...identity,
      manifest,
      signature: signManifest(
        identity.accountPickle,
        pickleKey(identity),
        canonicalManifest(manifest),
      ),
    },
    upgraded: true,
  };
}

export function encodeContactCode(identity: PrivateIdentity): string {
  return toBase64Url(utf8(JSON.stringify(ownBundle(identity))));
}

function assertEncodedBytes(
  value: unknown,
  expectedLength: number,
  label: string,
): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);

  let bytes;
  try {
    bytes = fromBase64Url(value);
  } catch {
    throw new Error(`${label} is not valid base64`);
  }

  if (bytes.length !== expectedLength) {
    throw new Error(`${label} must encode ${expectedLength} bytes`);
  }
}

export async function validateBundle(value: unknown): Promise<ContactBundle> {
  await initializeCrypto();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unsupported contact code");
  }
  const bundle = value as Record<string, unknown>;
  if (bundle.v !== 0 && bundle.v !== 1) throw new Error("Unsupported contact code");

  assertEncodedBytes(bundle.s, 32, "signing key");
  assertEncodedBytes(bundle.i, 32, "identity key");
  assertEncodedBytes(bundle.d, 32, "delivery key");
  assertEncodedBytes(bundle.x, 64, "signature");

  let manifest: ContactManifest;
  if (bundle.v === 0) {
    assertEncodedBytes(bundle.f, 32, "fallback key");
    manifest = { v: 0, s: bundle.s, i: bundle.i, f: bundle.f, d: bundle.d };
  } else {
    manifest = { v: 1, s: bundle.s, i: bundle.i, d: bundle.d };
  }
  if (!verifyManifest(bundle.s, canonicalManifest(manifest), bundle.x)) {
    throw new Error("Contact code signature is invalid");
  }

  return { ...manifest, x: bundle.x } as ContactBundle;
}

export async function decodeContactCode(code: string): Promise<ContactBundle> {
  if (typeof code !== "string" || code.length === 0 || code.length > 2_048) {
    throw new Error("Contact code is empty or too large");
  }

  let bundle: unknown;
  try {
    bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(code.trim())));
  } catch {
    throw new Error("Contact code is not valid");
  }

  return validateBundle(bundle);
}

export function startOutbound(
  identity: PrivateIdentity,
  recipientIdentityKey: string,
  recipientOneTimeKey: string,
  plaintext: string,
): SessionStart {
  const result = parseResult<WasmOutboundResult>(
    createOutbound(
      identity.accountPickle,
      pickleKey(identity),
      recipientIdentityKey,
      recipientOneTimeKey,
      plaintext,
    ),
  );
  return {
    sessionId: result.session_id,
    sessionPickle: result.session_pickle,
    message: result.message,
  };
}

export function acceptInbound(
  identity: PrivateIdentity,
  senderIdentityKey: string,
  expectedOneTimeKey: string,
  message: string,
): InboundSession {
  const result = parseResult<WasmInboundResult>(
    createInbound(
      identity.accountPickle,
      pickleKey(identity),
      senderIdentityKey,
      expectedOneTimeKey,
      message,
    ),
  );
  return {
    accountPickle: result.account_pickle,
    sessionId: result.session_id,
    sessionPickle: result.session_pickle,
    plaintext: result.plaintext,
  };
}

export function createOneTimeKey(identity: PrivateIdentity): GeneratedOneTimeKey {
  const result = parseResult<WasmOneTimeKeyResult>(
    generateOneTimeKey(identity.accountPickle, pickleKey(identity)),
  );
  return {
    accountPickle: result.account_pickle,
    oneTimeKey: result.one_time_key,
  };
}

export function forgetOneTimeKey(
  identity: PrivateIdentity,
  oneTimeKey: string,
): string {
  return discardOneTimeKey(identity.accountPickle, pickleKey(identity), oneTimeKey);
}

export function signPayload(identity: PrivateIdentity, payload: string): string {
  return signManifest(identity.accountPickle, pickleKey(identity), payload);
}

export function verifyPayload(signingKey: string, payload: string, signature: string): boolean {
  return verifyManifest(signingKey, payload, signature);
}

export function encryptSession(
  identity: PrivateIdentity,
  sessionPickle: string,
  plaintext: string,
): SessionEncryption {
  const result = parseResult<WasmSessionResult>(
    sessionEncrypt(sessionPickle, pickleKey(identity), plaintext),
  );
  if (result.message === null) throw new Error("WASM session encryption returned no message");
  return {
    sessionPickle: result.session_pickle,
    message: result.message,
  };
}

export function decryptSession(
  identity: PrivateIdentity,
  sessionPickle: string,
  message: string,
): SessionDecryption {
  const result = parseResult<WasmSessionResult>(
    sessionDecrypt(sessionPickle, pickleKey(identity), message),
  );
  if (result.plaintext === null) throw new Error("WASM session decryption returned no plaintext");
  return {
    sessionPickle: result.session_pickle,
    plaintext: result.plaintext,
  };
}

export async function fingerprint(signingKey: string): Promise<string> {
  const signingKeyBytes = Uint8Array.from(fromBase64Url(signingKey));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", signingKeyBytes),
  );
  return Array.from(digest.subarray(0, 6), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{1,4}/gu)!
    .join(" ");
}
