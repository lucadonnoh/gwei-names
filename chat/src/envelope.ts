import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";

import { decodeUtf8, fromBase64Url, toBase64Url, utf8 } from "./encoding";
import type { ByteSource } from "./encoding";

export const ENVELOPE_SIZE = 2_048;
export const ENCAPSULATED_KEY_SIZE = 32;
export const HPKE_TAG_SIZE = 16;
export const FRAME_SIZE = ENVELOPE_SIZE - ENCAPSULATED_KEY_SIZE - HPKE_TAG_SIZE;
export const FRAME_HEADER_SIZE = 7;
export const MAX_PAYLOAD_SIZE = FRAME_SIZE - FRAME_HEADER_SIZE;

const FRAME_MAGIC = Uint8Array.of(0x67, 0x77, 0x65, 0x69); // "gwei"
const FRAME_VERSION = 0;
const HPKE_INFO = utf8("gwei.chat/envelope/v0");

const suite = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes128Gcm,
});

export interface DeliveryKeyPair {
  publicKey: string;
  privateKey: string;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeFrame(payload: unknown): Uint8Array {
  const encoded = utf8(JSON.stringify(payload));
  if (encoded.length > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `encrypted payload is ${encoded.length} bytes; maximum is ${MAX_PAYLOAD_SIZE}`,
    );
  }

  const frame = randomBytes(FRAME_SIZE);
  frame.set(FRAME_MAGIC, 0);
  frame[4] = FRAME_VERSION;
  new DataView(frame.buffer).setUint16(5, encoded.length, false);
  frame.set(encoded, FRAME_HEADER_SIZE);
  return frame;
}

function decodeFrame(frame: ByteSource): unknown | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length !== FRAME_SIZE || bytes[4] !== FRAME_VERSION) return null;

  for (let index = 0; index < FRAME_MAGIC.length; index += 1) {
    if (bytes[index] !== FRAME_MAGIC[index]) return null;
  }

  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(5, false);
  if (length > MAX_PAYLOAD_SIZE) return null;

  try {
    return JSON.parse(decodeUtf8(bytes.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + length)));
  } catch {
    return null;
  }
}

export async function generateDeliveryKeyPair(): Promise<DeliveryKeyPair> {
  const pair = await suite.kem.generateKeyPair();
  const [publicKey, privateKey] = await Promise.all([
    suite.kem.serializePublicKey(pair.publicKey),
    suite.kem.serializePrivateKey(pair.privateKey),
  ]);

  return {
    publicKey: toBase64Url(publicKey),
    privateKey: toBase64Url(privateKey),
  };
}

export async function sealEnvelope(publicKey: string, payload: unknown): Promise<Uint8Array> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64Url(publicKey));
  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: HPKE_INFO,
  });
  const ciphertext = new Uint8Array(await sender.seal(encodeFrame(payload)));
  const encapsulatedKey = new Uint8Array(sender.enc);

  if (
    encapsulatedKey.length !== ENCAPSULATED_KEY_SIZE ||
    ciphertext.length !== FRAME_SIZE + HPKE_TAG_SIZE
  ) {
    throw new Error("HPKE suite produced an unexpected envelope size");
  }

  const envelope = new Uint8Array(ENVELOPE_SIZE);
  envelope.set(encapsulatedKey, 0);
  envelope.set(ciphertext, ENCAPSULATED_KEY_SIZE);
  return envelope;
}

export async function openEnvelope(
  privateKey: string,
  envelope: ByteSource,
): Promise<unknown | null> {
  const bytes = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  if (bytes.length !== ENVELOPE_SIZE) return null;

  try {
    const recipientKey = await suite.kem.deserializePrivateKey(fromBase64Url(privateKey));
    const recipient = await suite.createRecipientContext({
      recipientKey,
      enc: bytes.subarray(0, ENCAPSULATED_KEY_SIZE),
      info: HPKE_INFO,
    });
    const plaintext = await recipient.open(bytes.subarray(ENCAPSULATED_KEY_SIZE));
    return decodeFrame(plaintext);
  } catch {
    return null;
  }
}

export async function dummyEnvelope(): Promise<Uint8Array> {
  // A uniformly random 32-byte prefix is distinguishable from a generated
  // X25519 public key (for example by encoding and curve-membership checks).
  // Sample the prefix through the same KEM as real sender contexts instead.
  const pair = await suite.kem.generateKeyPair();
  const encapsulatedKey = new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey));
  const envelope = randomBytes(ENVELOPE_SIZE);
  envelope.set(encapsulatedKey, 0);
  return envelope;
}
