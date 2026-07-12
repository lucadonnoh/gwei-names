const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type ByteSource = Uint8Array | ArrayBuffer;

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeUtf8(value: ByteSource): string {
  return textDecoder.decode(value);
}

export function toBase64Url(value: ByteSource): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export async function sha256(value: ByteSource): Promise<Uint8Array> {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(source));
  return new Uint8Array(digest);
}

export async function sha256Base64Url(value: ByteSource): Promise<string> {
  return toBase64Url(await sha256(value));
}
