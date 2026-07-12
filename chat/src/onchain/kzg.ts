import { loadKZG } from "@blobkit/kzg-wasm";
import { getBytes, hexlify, sha256 } from "ethers";

import { BLOB_SIZE, extractBlobData } from "../blob-batch";
import type { BytesLike } from "../blob-batch";

const KZG_VERSION = 0x01;

export type KzgLibrary = Awaited<ReturnType<typeof loadKZG>>;

export interface PreparedCanonicalBlob {
  data: Uint8Array;
  dataHex: string;
  commitment: string;
  proof: string;
  versionedHash: string;
}

export interface IdentifiedCanonicalBlob {
  data: Uint8Array;
  dataHex: string;
  commitment: string;
  versionedHash: string;
}

let kzgPromise: Promise<KzgLibrary> | undefined;

export function getKzg(): Promise<KzgLibrary> {
  kzgPromise ||= loadKZG();
  return kzgPromise;
}

export function commitmentToVersionedHash(commitment: string): string {
  const digest = getBytes(sha256(commitment));
  if (digest.length !== 32) throw new Error("KZG commitment hash has the wrong size");
  digest[0] = KZG_VERSION;
  return hexlify(digest).toLowerCase();
}

export async function identifyBlob(
  value: BytesLike,
): Promise<IdentifiedCanonicalBlob> {
  const data = value instanceof Uint8Array ? Uint8Array.from(value) : new Uint8Array(value);
  if (data.length !== BLOB_SIZE) throw new RangeError(`A blob must be exactly ${BLOB_SIZE} bytes`);

  const dataHex = hexlify(data);
  const kzg = await getKzg();
  const commitment = kzg.blobToKZGCommitment(dataHex).toLowerCase();
  return {
    data,
    dataHex,
    commitment,
    versionedHash: commitmentToVersionedHash(commitment),
  };
}

export async function identifyCanonicalBlob(
  value: BytesLike,
): Promise<IdentifiedCanonicalBlob> {
  const data = value instanceof Uint8Array ? Uint8Array.from(value) : new Uint8Array(value);
  extractBlobData(data); // Enforce the gwei 31-byte field-element convention.
  return identifyBlob(data);
}

export async function prepareCanonicalBlob(
  value: BytesLike,
): Promise<PreparedCanonicalBlob> {
  const identified = await identifyCanonicalBlob(value);
  const kzg = await getKzg();
  const { data, dataHex, commitment, versionedHash } = identified;
  const proof = kzg.computeBlobKZGProof(dataHex, commitment).toLowerCase();
  if (!kzg.verifyBlobKZGProof(dataHex, commitment, proof)) {
    throw new Error("BlobKit KZG-WASM rejected its generated blob proof");
  }

  return {
    data,
    dataHex,
    commitment,
    proof,
    versionedHash,
  };
}

export async function canonicalBlobVersionedHash(value: BytesLike): Promise<string> {
  return (await prepareCanonicalBlob(value)).versionedHash;
}
