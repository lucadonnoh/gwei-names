import { getBytes } from "ethers";
import type { JsonRpcProvider } from "ethers";

import { BLOB_SIZE, extractBlobData } from "../blob-batch";

interface BeaconGenesisResponse {
  data: {
    genesis_time: string;
  };
}

interface BeaconSpecResponse {
  data: {
    SECONDS_PER_SLOT: string;
    SLOTS_PER_EPOCH: string;
    MIN_EPOCHS_FOR_DATA_COLUMN_SIDECARS_REQUESTS: string;
  };
}

interface BeaconBlobsResponse {
  execution_optimistic: boolean;
  finalized: boolean;
  data: string[];
}

export interface AvailableCanonicalBlob {
  blob: Uint8Array;
  versionedHash: string;
  beaconSlot: bigint;
  finalized: boolean;
  executionOptimistic: boolean;
}

export interface BeaconAvailabilityConfig {
  genesisTime: bigint;
  secondsPerSlot: bigint;
  slotsPerEpoch: bigint;
  retentionEpochs: bigint;
}

export class BlobUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobUnavailableError";
  }
}

export class InvalidGweiBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGweiBlobError";
  }
}

function apiUrl(baseUrl: string, path: string): URL {
  const base = `${baseUrl.replace(/\/$/u, "")}/`;
  return new URL(path.replace(/^\//u, ""), base);
}

async function fetchJson(
  url: URL,
  fetchImplementation: typeof fetch,
): Promise<{ response: Response; value: unknown }> {
  const response = await fetchImplementation(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  return { response, value };
}

function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return BigInt(value);
}

function parseGenesis(value: unknown): bigint {
  if (!value || typeof value !== "object") throw new Error("Beacon genesis response is malformed");
  const response = value as Partial<BeaconGenesisResponse>;
  return decimal(response.data?.genesis_time, "Beacon genesis_time");
}

function parseAvailabilityConfig(
  genesisValue: unknown,
  specValue: unknown,
): BeaconAvailabilityConfig {
  const genesisTime = parseGenesis(genesisValue);
  const value = specValue;
  if (!value || typeof value !== "object") throw new Error("Beacon spec response is malformed");
  const response = value as Partial<BeaconSpecResponse>;
  const seconds = decimal(response.data?.SECONDS_PER_SLOT, "Beacon SECONDS_PER_SLOT");
  if (seconds < 1n) throw new Error("Beacon SECONDS_PER_SLOT must be positive");
  const slotsPerEpoch = decimal(response.data?.SLOTS_PER_EPOCH, "Beacon SLOTS_PER_EPOCH");
  const retentionEpochs = decimal(
    response.data?.MIN_EPOCHS_FOR_DATA_COLUMN_SIDECARS_REQUESTS,
    "Beacon MIN_EPOCHS_FOR_DATA_COLUMN_SIDECARS_REQUESTS",
  );
  if (slotsPerEpoch < 1n || retentionEpochs < 1n) {
    throw new Error("Beacon availability configuration must be positive");
  }
  return { genesisTime, secondsPerSlot: seconds, slotsPerEpoch, retentionEpochs };
}

function parseBlobs(value: unknown): BeaconBlobsResponse {
  if (!value || typeof value !== "object") throw new Error("Beacon blobs response is malformed");
  const response = value as Partial<BeaconBlobsResponse>;
  if (
    typeof response.execution_optimistic !== "boolean" ||
    typeof response.finalized !== "boolean" ||
    !Array.isArray(response.data) ||
    !response.data.every((item) => typeof item === "string")
  ) {
    throw new Error("Beacon blobs response is malformed");
  }
  return response as BeaconBlobsResponse;
}

export function beaconSlotForExecutionTimestamp(
  executionTimestamp: bigint,
  genesisTime: bigint,
  secondsPerSlot: bigint,
): bigint {
  if (executionTimestamp < genesisTime) throw new RangeError("Execution block predates beacon genesis");
  if (secondsPerSlot < 1n) throw new RangeError("Seconds per slot must be positive");
  const elapsed = executionTimestamp - genesisTime;
  if (elapsed % secondsPerSlot !== 0n) {
    throw new Error("Execution block timestamp is not aligned to a beacon slot");
  }
  return elapsed / secondsPerSlot;
}

export async function getBeaconAvailabilityConfig(
  beaconApiUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<BeaconAvailabilityConfig> {
  const [genesisResult, specResult] = await Promise.all([
    fetchJson(apiUrl(beaconApiUrl, "eth/v1/beacon/genesis"), fetchImplementation),
    fetchJson(apiUrl(beaconApiUrl, "eth/v1/config/spec"), fetchImplementation),
  ]);
  if (!genesisResult.response.ok || !specResult.response.ok) {
    throw new Error("Beacon API did not return its genesis and slot configuration");
  }
  return parseAvailabilityConfig(genesisResult.value, specResult.value);
}

export async function retrieveAvailableCanonicalBlob(options: {
  beaconApiUrl: string;
  executionTimestamp: bigint;
  versionedHash: string;
  fetchImplementation?: typeof fetch;
  availabilityConfig?: BeaconAvailabilityConfig;
}): Promise<AvailableCanonicalBlob> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const config = options.availabilityConfig ??
    await getBeaconAvailabilityConfig(options.beaconApiUrl, fetchImplementation);
  const slot = beaconSlotForExecutionTimestamp(
    options.executionTimestamp,
    config.genesisTime,
    config.secondsPerSlot,
  );
  const expectedHash = options.versionedHash.toLowerCase();
  if (!/^0x01[0-9a-f]{62}$/u.test(expectedHash)) {
    throw new RangeError("Expected versioned hash is malformed");
  }

  const url = apiUrl(options.beaconApiUrl, `eth/v1/beacon/blobs/${slot}`);
  url.searchParams.append("versioned_hashes", expectedHash);
  const result = await fetchJson(url, fetchImplementation);
  if (result.response.status === 404) {
    throw new BlobUnavailableError(`Blob is no longer available at beacon slot ${slot}`);
  }
  if (!result.response.ok) {
    throw new Error(`Beacon blob request failed (${result.response.status})`);
  }
  const response = parseBlobs(result.value);
  if (response.data.length === 0) {
    throw new BlobUnavailableError(`Blob is unavailable at beacon slot ${slot}`);
  }
  // The selected Beacon API is a trusted read source, just like the selected
  // execution RPC used for finalized logs and GNS records. With one requested
  // versioned hash it must return exactly that blob; accepting an unfiltered
  // multi-blob response would make the hash-to-bytes mapping ambiguous.
  if (response.data.length !== 1) {
    throw new Error("Beacon API did not return exactly the requested blob");
  }
  let blob: Uint8Array;
  try {
    blob = getBytes(response.data[0]!);
  } catch {
    throw new Error("Beacon API returned a non-hex blob");
  }
  if (blob.length !== BLOB_SIZE) throw new Error("Beacon API returned a malformed blob size");
  try {
    extractBlobData(blob);
  } catch {
    throw new InvalidGweiBlobError("Beacon blob does not use the gwei canonical encoding");
  }
  return {
    blob,
    versionedHash: expectedHash,
    beaconSlot: slot,
    finalized: response.finalized,
    executionOptimistic: response.execution_optimistic,
  };
}

// Anvil exposes development sidecars on eth_getTransactionByHash. Public
// execution RPCs do not; production retrieval uses the Beacon API above.
export async function retrieveCanonicalBlobFromAnvil(
  provider: JsonRpcProvider,
  transactionHash: string,
  versionedHash: string,
): Promise<Uint8Array> {
  const value = await provider.send("eth_getTransactionByHash", [transactionHash]);
  if (!value || typeof value !== "object") throw new Error("Anvil transaction is missing");
  const blobs = (value as { blobs?: unknown }).blobs;
  if (!Array.isArray(blobs)) throw new Error("Anvil transaction did not expose blob sidecars");
  const expectedHash = versionedHash.toLowerCase();
  const { identifyBlob } = await import("./kzg");
  for (const encoded of blobs) {
    if (typeof encoded !== "string") throw new Error("Anvil returned a malformed blob");
    const blob = getBytes(encoded);
    const identified = await identifyBlob(blob);
    if (identified.versionedHash === expectedHash) return blob;
  }
  throw new Error("Anvil sidecar did not contain the declared blob");
}
