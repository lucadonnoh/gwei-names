import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  JsonRpcProvider,
  Wallet,
  getAddress,
  parseEther,
} from "ethers";
import type { Signer } from "ethers";

import {
  ENVELOPES_PER_BLOB,
  createPaddedBlobBatch,
  unpackEnvelopeSlots,
} from "../src/blob-batch";
import { sha256Base64Url } from "../src/encoding";
import {
  retrieveAvailableCanonicalBlob,
  retrieveCanonicalBlobFromAnvil,
} from "../src/onchain/availability";
import { publishCanonicalBlob } from "../src/onchain/erc8179";
import {
  MAX_BLOBS_PER_TRANSACTION,
  publishCanonicalBlobs,
} from "../src/onchain/erc8179";
import { prepareCanonicalBlob } from "../src/onchain/kzg";

const SEPOLIA_CHAIN_ID = 11_155_111n;
const LOCAL_CHAIN_ID = 31_337n;
const SEPOLIA_ERC8179 = "0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

async function signerFor(provider: JsonRpcProvider): Promise<Signer> {
  const keyFile = process.env.BATCHER_KEY_FILE?.trim();
  if (!keyFile) {
    const address = getAddress(requiredEnvironment("BATCHER_ADDRESS"));
    return provider.getSigner(address);
  }

  const path = resolve(keyFile);
  const file = await stat(path);
  if ((file.mode & 0o077) !== 0) throw new Error("Batcher key file permissions must be 0600");
  const privateKey = (await readFile(path, "utf8")).trim();
  if (!/^0x[0-9a-f]{64}$/iu.test(privateKey)) throw new Error("Batcher key file is malformed");
  return new Wallet(privateKey, provider);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

const executionRpcUrl = requiredEnvironment("EXECUTION_RPC_URL");
const provider = new JsonRpcProvider(executionRpcUrl);
const [network, signer] = await Promise.all([provider.getNetwork(), signerFor(provider)]);
const expectedChainId = process.env.EXPECTED_CHAIN_ID
  ? BigInt(process.env.EXPECTED_CHAIN_ID)
  : network.chainId;
if (network.chainId !== expectedChainId) {
  throw new Error(`Connected to chain ${network.chainId}, expected ${expectedChainId}`);
}
const contractAddress = getAddress(
  process.env.ERC8179_ADDRESS?.trim() ||
    (network.chainId === SEPOLIA_CHAIN_ID ? SEPOLIA_ERC8179 : requiredEnvironment("ERC8179_ADDRESS")),
);
const confirmations = positiveInteger(process.env.CONFIRMATIONS, 1, "CONFIRMATIONS");
const maxCostWei = process.env.MAX_PUBLISH_COST_WEI
  ? BigInt(process.env.MAX_PUBLISH_COST_WEI)
  : parseEther("0.02");
const blobCount = positiveInteger(process.env.BLOB_COUNT, 1, "BLOB_COUNT");
if (blobCount > MAX_BLOBS_PER_TRANSACTION) {
  throw new Error(`BLOB_COUNT cannot exceed ${MAX_BLOBS_PER_TRANSACTION}`);
}

console.error(
  `building ${blobCount} canonical blob${blobCount === 1 ? "" : "s"} ` +
    `(${blobCount * ENVELOPES_PER_BLOB} envelope slots) and KZG proofs`,
);
const blobs = await Promise.all(
  Array.from({ length: blobCount }, () => createPaddedBlobBatch([])),
);
const preparedBlobs = await Promise.all(blobs.map(prepareCanonicalBlob));
const originalSha256 = await Promise.all(blobs.map(sha256Base64Url));

console.error(`publishing ${blobCount} blob${blobCount === 1 ? "" : "s"} on chain ${network.chainId}`);
const singlePublication = blobCount === 1
  ? await publishCanonicalBlob({
      provider,
      signer,
      contractAddress,
      preparedBlob: preparedBlobs[0]!,
      confirmations,
      maxCostWei,
    })
  : null;
const multiPublication = blobCount > 1
  ? await publishCanonicalBlobs({
      provider,
      signer,
      contractAddress,
      preparedBlobs,
      confirmations,
      maxCostWei,
    })
  : null;
const transactionHash = singlePublication?.transactionHash ??
  multiPublication!.transactionHash;
const blockNumber = singlePublication?.blockNumber ??
  multiPublication!.receipt.blockNumber;
const blobGasUsed = singlePublication?.blobGasUsed ?? multiPublication!.blobGasUsed;
const segments = singlePublication ? [singlePublication] : multiPublication!.segments;
const block = await provider.getBlock(blockNumber);
if (!block) throw new Error("Publication block is unavailable from the execution RPC");

console.error("retrieving every declared blob from its availability source");
const retrieved = [];
for (const [index, preparedBlob] of preparedBlobs.entries()) {
  const available = network.chainId === LOCAL_CHAIN_ID
    ? {
        blob: await retrieveCanonicalBlobFromAnvil(
          provider,
          transactionHash,
          preparedBlob.versionedHash,
        ),
        beaconSlot: null,
        finalized: false,
      }
    : await retrieveAvailableCanonicalBlob({
        beaconApiUrl: requiredEnvironment("BEACON_API_URL"),
        executionTimestamp: BigInt(block.timestamp),
        versionedHash: preparedBlob.versionedHash,
      });

  if (!equalBytes(blobs[index]!, available.blob)) {
    throw new Error(`Retrieved blob ${index} differs from the submitted canonical blob`);
  }
  const slots = unpackEnvelopeSlots(available.blob);
  if (slots.length !== ENVELOPES_PER_BLOB) {
    throw new Error(`Retrieved blob ${index} has the wrong slot count`);
  }
  retrieved.push({
    index,
    logIndex: segments[index]!.logIndex,
    versionedHash: preparedBlob.versionedHash,
    envelopeSlots: slots.length,
    originalSha256: originalSha256[index]!,
    retrievedSha256: await sha256Base64Url(available.blob),
    beaconSlot: available.beaconSlot?.toString() ?? null,
    finalizedAtRetrieval: available.finalized,
  });
}

console.log(
  JSON.stringify({
    ok: true,
    chainId: network.chainId.toString(),
    contractAddress,
    batcher: await signer.getAddress(),
    transactionHash,
    blockNumber,
    blobCount,
    blobGasUsed: blobGasUsed.toString(),
    envelopeSlots: blobCount * ENVELOPES_PER_BLOB,
    blobs: retrieved,
  }),
);
