export const webcrypto = globalThis.crypto;

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("Random byte length is invalid");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export default { webcrypto, randomBytes };
