import {
  decodeUtf8,
  fromBase64Url,
  toBase64Url,
  utf8,
} from "./encoding";

const VAULT_VERSION = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const WRAP_INFO = Uint8Array.from(utf8("gwei-chat/v1/passkey-vault-wrap"));
const TRANSPORTS = new Set<AuthenticatorTransport>([
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "usb",
]);

interface PrfInput {
  eval: { first: BufferSource };
}

interface PrfOutputs {
  prf?: {
    enabled?: boolean;
    results?: { first?: unknown };
  };
}

interface WebAuthnLevelThreeStatics {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
  signalUnknownCredential?: (options: {
    rpId: string;
    credentialId: string;
  }) => Promise<void>;
}

type CreationOptionsWithPrf = Omit<PublicKeyCredentialCreationOptions, "extensions"> & {
  extensions: { prf: PrfInput; credProps: true };
};

type RequestOptionsWithPrf = Omit<PublicKeyCredentialRequestOptions, "extensions"> & {
  extensions: { prf: PrfInput };
};

export interface PasskeyVaultConfig {
  v: 1;
  type: "webauthn-prf";
  rpId: string;
  credentialId: string;
  transports: AuthenticatorTransport[];
  prfSalt: string;
  kdfSalt: string;
  wrapNonce: string;
  wrappedVaultKey: string;
  createdAt: number;
}

export interface EncryptedVaultRecord {
  v: 1;
  revision: number;
  nonce: string;
  ciphertext: string;
}

export interface CreatedPasskeyVault {
  config: PasskeyVaultConfig;
  key: CryptoKey;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

function exactBytes(value: string, length: number, label: string): Uint8Array<ArrayBuffer> {
  let decoded: Uint8Array;
  try {
    decoded = fromBase64Url(value);
  } catch {
    throw new Error(`${label} is malformed`);
  }
  if (decoded.length !== length) throw new Error(`${label} is malformed`);
  return copyBytes(decoded);
}

function prfBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof ArrayBuffer) return copyBytes(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return copyBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return null;
}

function prfResult(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const outputs = credential.getClientExtensionResults() as PrfOutputs;
  const result = prfBytes(outputs.prf?.results?.first);
  return result?.length === KEY_BYTES ? result : null;
}

function normalizeTransports(value: readonly string[]): AuthenticatorTransport[] {
  return [...new Set(value.filter(
    (transport): transport is AuthenticatorTransport => TRANSPORTS.has(
      transport as AuthenticatorTransport,
    ),
  ))];
}

function requirePublicKeyCredential(value: Credential | null): PublicKeyCredential {
  if (!(value instanceof PublicKeyCredential)) {
    throw new Error("The browser did not return a passkey credential");
  }
  return value;
}

function wrappingAad(value: {
  rpId: string;
  credentialId: string;
  prfSalt: string;
  kdfSalt: string;
}): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(utf8(JSON.stringify({
    v: VAULT_VERSION,
    kind: "gwei-chat-vault-key",
    rpId: value.rpId,
    credentialId: value.credentialId,
    prfSalt: value.prfSalt,
    kdfSalt: value.kdfSalt,
  })));
}

function stateAad(profile: string, revision: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(utf8(JSON.stringify({
    v: VAULT_VERSION,
    kind: "gwei-chat-private-state",
    profile,
    revision,
  })));
}

async function wrappingKey(
  prfOutput: Uint8Array,
  kdfSalt: Uint8Array,
): Promise<CryptoKey> {
  if (prfOutput.length !== KEY_BYTES) throw new Error("Passkey PRF output is malformed");
  if (kdfSalt.length !== SALT_BYTES) throw new Error("Vault KDF salt is malformed");
  const material = await crypto.subtle.importKey(
    "raw",
    copyBytes(prfOutput),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: copyBytes(kdfSalt),
      info: WRAP_INFO,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importVaultKey(value: Uint8Array): Promise<CryptoKey> {
  if (value.length !== KEY_BYTES) throw new Error("Vault key is malformed");
  return crypto.subtle.importKey(
    "raw",
    copyBytes(value),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function parsePasskeyVaultConfig(value: unknown): PasskeyVaultConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Passkey vault configuration is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== VAULT_VERSION ||
    record.type !== "webauthn-prf" ||
    typeof record.rpId !== "string" ||
    !record.rpId ||
    record.rpId.length > 253 ||
    typeof record.credentialId !== "string" ||
    typeof record.prfSalt !== "string" ||
    typeof record.kdfSalt !== "string" ||
    typeof record.wrapNonce !== "string" ||
    typeof record.wrappedVaultKey !== "string" ||
    !Array.isArray(record.transports) ||
    !record.transports.every((item) => typeof item === "string") ||
    !Number.isSafeInteger(record.createdAt) ||
    Number(record.createdAt) <= 0
  ) {
    throw new Error("Passkey vault configuration is malformed");
  }
  // Credential IDs have variable length.
  let credentialId: Uint8Array;
  try {
    credentialId = fromBase64Url(record.credentialId);
  } catch {
    throw new Error("Passkey credential ID is malformed");
  }
  if (credentialId.length < 1 || credentialId.length > 1_024) {
    throw new Error("Passkey credential ID is malformed");
  }
  exactBytes(record.prfSalt, SALT_BYTES, "Passkey PRF salt");
  exactBytes(record.kdfSalt, SALT_BYTES, "Vault KDF salt");
  exactBytes(record.wrapNonce, NONCE_BYTES, "Vault wrap nonce");
  const wrapped = fromBase64Url(record.wrappedVaultKey);
  if (wrapped.length !== KEY_BYTES + 16) throw new Error("Wrapped vault key is malformed");
  return {
    v: 1,
    type: "webauthn-prf",
    rpId: record.rpId,
    credentialId: record.credentialId,
    transports: normalizeTransports(record.transports as string[]),
    prfSalt: record.prfSalt,
    kdfSalt: record.kdfSalt,
    wrapNonce: record.wrapNonce,
    wrappedVaultKey: record.wrappedVaultKey,
    createdAt: Number(record.createdAt),
  };
}

export function parseEncryptedVaultRecord(value: unknown): EncryptedVaultRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Encrypted vault state is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== VAULT_VERSION ||
    !Number.isSafeInteger(record.revision) ||
    Number(record.revision) < 0 ||
    typeof record.nonce !== "string" ||
    typeof record.ciphertext !== "string"
  ) {
    throw new Error("Encrypted vault state is malformed");
  }
  exactBytes(record.nonce, NONCE_BYTES, "Vault state nonce");
  const ciphertext = fromBase64Url(record.ciphertext);
  if (ciphertext.length < 17 || ciphertext.length > 16_777_216) {
    throw new Error("Encrypted vault ciphertext is malformed");
  }
  return {
    v: 1,
    revision: Number(record.revision),
    nonce: record.nonce,
    ciphertext: record.ciphertext,
  };
}

export async function wrapNewVaultKey(options: {
  prfOutput: Uint8Array;
  rpId: string;
  credentialId: string;
  transports?: AuthenticatorTransport[];
  prfSalt: Uint8Array;
  createdAt?: number;
}): Promise<CreatedPasskeyVault> {
  if (options.prfSalt.length !== SALT_BYTES) throw new Error("Passkey PRF salt is malformed");
  const kdfSalt = randomBytes(SALT_BYTES);
  const rawVaultKey = randomBytes(KEY_BYTES);
  const wrapNonce = randomBytes(NONCE_BYTES);
  const partial = {
    rpId: options.rpId,
    credentialId: options.credentialId,
    prfSalt: toBase64Url(options.prfSalt),
    kdfSalt: toBase64Url(kdfSalt),
  };
  const keyEncryptionKey = await wrappingKey(options.prfOutput, kdfSalt);
  try {
    const wrapped = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: wrapNonce, additionalData: wrappingAad(partial), tagLength: 128 },
      keyEncryptionKey,
      rawVaultKey,
    );
    const key = await importVaultKey(rawVaultKey);
    return {
      key,
      config: {
        v: 1,
        type: "webauthn-prf",
        ...partial,
        transports: normalizeTransports(options.transports ?? []),
        wrapNonce: toBase64Url(wrapNonce),
        wrappedVaultKey: toBase64Url(wrapped),
        createdAt: options.createdAt ?? Date.now(),
      },
    };
  } finally {
    rawVaultKey.fill(0);
  }
}

export async function unwrapVaultKey(
  configValue: PasskeyVaultConfig,
  prfOutput: Uint8Array,
): Promise<CryptoKey> {
  const config = parsePasskeyVaultConfig(configValue);
  const kdfSalt = exactBytes(config.kdfSalt, SALT_BYTES, "Vault KDF salt");
  const keyEncryptionKey = await wrappingKey(prfOutput, kdfSalt);
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: exactBytes(config.wrapNonce, NONCE_BYTES, "Vault wrap nonce"),
        additionalData: wrappingAad(config),
        tagLength: 128,
      },
      keyEncryptionKey,
      copyBytes(fromBase64Url(config.wrappedVaultKey)),
    );
  } catch {
    throw new Error("This passkey cannot unlock the private chat vault");
  }
  const rawBytes = new Uint8Array(raw);
  try {
    return await importVaultKey(rawBytes);
  } finally {
    rawBytes.fill(0);
  }
}

export async function encryptVaultValue(
  key: CryptoKey,
  value: unknown,
  profile: string,
  revision: number,
): Promise<EncryptedVaultRecord> {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Vault revision is invalid");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const plaintext = Uint8Array.from(utf8(JSON.stringify(value)));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: stateAad(profile, revision),
        tagLength: 128,
      },
      key,
      plaintext,
    );
    return {
      v: 1,
      revision,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(ciphertext),
    };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptVaultValue(
  key: CryptoKey,
  recordValue: EncryptedVaultRecord,
  profile: string,
): Promise<unknown> {
  const record = parseEncryptedVaultRecord(recordValue);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: exactBytes(record.nonce, NONCE_BYTES, "Vault state nonce"),
        additionalData: stateAad(profile, record.revision),
        tagLength: 128,
      },
      key,
      copyBytes(fromBase64Url(record.ciphertext)),
    );
  } catch {
    throw new Error("The private chat vault is corrupted or was modified");
  }
  const bytes = new Uint8Array(plaintext);
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    throw new Error("The decrypted private chat state is malformed");
  } finally {
    bytes.fill(0);
  }
}

async function requestPrfOutput(
  config: Pick<PasskeyVaultConfig, "rpId" | "credentialId" | "transports" | "prfSalt">,
): Promise<Uint8Array<ArrayBuffer>> {
  let credentialId: Uint8Array;
  try {
    credentialId = fromBase64Url(config.credentialId);
  } catch {
    throw new Error("Passkey credential ID is malformed");
  }
  if (credentialId.length < 1 || credentialId.length > 1_024) {
    throw new Error("Passkey credential ID is malformed");
  }
  const options: RequestOptionsWithPrf = {
    challenge: randomBytes(KEY_BYTES),
    rpId: config.rpId,
    allowCredentials: [{
      type: "public-key",
      id: copyBytes(credentialId),
      transports: config.transports,
    }],
    userVerification: "required",
    timeout: 120_000,
    extensions: {
      prf: { eval: { first: exactBytes(config.prfSalt, SALT_BYTES, "Passkey PRF salt") } },
    },
  };
  const credential = requirePublicKeyCredential(
    await navigator.credentials.get({ publicKey: options }),
  );
  const result = prfResult(credential);
  if (!result) {
    throw new Error("This browser and passkey do not provide the WebAuthn PRF extension");
  }
  return result;
}

export function passkeyVaultAvailable(): boolean {
  return window.isSecureContext &&
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials !== "undefined";
}

export async function forgetPasskeyCredential(options: {
  rpId: string;
  credentialId: string;
}): Promise<void> {
  const levelThree = PublicKeyCredential as unknown as WebAuthnLevelThreeStatics;
  try {
    await levelThree.signalUnknownCredential?.(options);
  } catch {
    // Advisory cleanup is not supported consistently; the user can remove an orphan manually.
  }
}

export async function createPasskeyVault(rpId = location.hostname): Promise<CreatedPasskeyVault> {
  if (!passkeyVaultAvailable()) {
    throw new Error("Passkey vaults require a secure context and WebAuthn support");
  }
  if (["127.0.0.1", "::1"].includes(rpId)) {
    throw new Error("Open this local prototype at http://localhost to create its passkey vault");
  }
  if (
    rpId === "gwei.domains" ||
    (rpId.endsWith(".gwei.domains") && rpId !== "chat.gwei.domains")
  ) {
    throw new Error(
      "Passkey vaults require the isolated chat.gwei.domains origin, not the shared parent domain",
    );
  }
  const levelThree = PublicKeyCredential as unknown as WebAuthnLevelThreeStatics;
  try {
    const capabilities = await levelThree.getClientCapabilities?.();
    if (capabilities?.["extension:prf"] === false) {
      throw new Error("This browser does not support WebAuthn PRF encrypted vaults");
    }
  } catch (error) {
    if (error instanceof Error && /does not support WebAuthn PRF/u.test(error.message)) throw error;
    // Older clients do not expose capability discovery; the requested extension remains decisive.
  }
  const prfSalt = randomBytes(SALT_BYTES);
  const options: CreationOptionsWithPrf = {
    challenge: randomBytes(KEY_BYTES),
    rp: { id: rpId, name: "gwei chat" },
    user: {
      id: randomBytes(KEY_BYTES),
      name: "private-chat-vault",
      displayName: "gwei chat private vault",
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    attestation: "none",
    timeout: 120_000,
    extensions: { prf: { eval: { first: prfSalt } }, credProps: true },
  };
  const credential = requirePublicKeyCredential(
    await navigator.credentials.create({ publicKey: options }),
  );
  const credentialId = toBase64Url(credential.rawId);
  try {
    const outputs = credential.getClientExtensionResults() as PrfOutputs;
    if (outputs.prf?.enabled === false) {
      throw new Error("The selected passkey does not support encrypted vaults");
    }
    const response = credential.response;
    const transports = response instanceof AuthenticatorAttestationResponse
      ? normalizeTransports(response.getTransports())
      : [];
    const partial = { rpId, credentialId, transports, prfSalt: toBase64Url(prfSalt) };
    const output = prfResult(credential) ?? await requestPrfOutput(partial);
    try {
      return await wrapNewVaultKey({
        prfOutput: output,
        rpId,
        credentialId,
        transports,
        prfSalt,
      });
    } finally {
      output.fill(0);
    }
  } catch (error) {
    await forgetPasskeyCredential({ rpId, credentialId });
    throw error;
  }
}

export async function unlockPasskeyVault(configValue: PasskeyVaultConfig): Promise<CryptoKey> {
  const config = parsePasskeyVaultConfig(configValue);
  if (config.rpId !== location.hostname) {
    throw new Error(`This vault belongs to ${config.rpId}, not ${location.hostname}`);
  }
  const output = await requestPrfOutput(config);
  try {
    return await unwrapVaultKey(config, output);
  } finally {
    output.fill(0);
  }
}
