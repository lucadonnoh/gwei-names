import {
  Interface,
  getAddress,
  getBigInt,
} from "ethers";
import type {
  BlockTag,
  Filter,
  JsonRpcProvider,
  Log,
  Signer,
  TransactionReceipt,
  TransactionRequest,
} from "ethers";

import {
  CONTENT_TAG,
  FIELD_ELEMENTS_PER_BLOB,
} from "../blob-batch";
import type { PreparedCanonicalBlob } from "./kzg";

const BLOB_GAS_PER_BLOB = 131_072n;
// Osaka limits each blob transaction to six blobs even though the current
// per-block maximum can be higher through Blob Parameter Only forks.
export const MAX_BLOBS_PER_TRANSACTION = 6;
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const ERC8179_ABI = [
  "function declareBlobSegment(uint256 blobIndex, uint16 startFE, uint16 endFE, bytes32 contentTag) returns (bytes32 versionedHash)",
  "event BlobSegmentDeclared(bytes32 indexed versionedHash, address indexed declarer, uint16 startFE, uint16 endFE, bytes32 indexed contentTag)",
] as const;

export const erc8179Interface = new Interface(ERC8179_ABI);
const multicall3Interface = new Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)",
]);

export function erc8179DiscoveryTopics(contentTag = CONTENT_TAG): [string, null, null, string] {
  const event = erc8179Interface.getEvent("BlobSegmentDeclared");
  if (!event) throw new Error("BlobSegmentDeclared ABI is missing");
  return [event.topicHash, null, null, contentTag.toLowerCase()];
}

export interface DiscoveredBlobSegment {
  contractAddress: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  versionedHash: string;
  declarer: string;
  startFE: number;
  endFE: number;
  contentTag: string;
}

export interface PublishCanonicalBlobOptions {
  provider: JsonRpcProvider;
  signer: Signer;
  contractAddress: string;
  preparedBlob: PreparedCanonicalBlob;
  confirmations?: number;
  maxCostWei?: bigint;
  reserveCost?: (worstCaseCostWei: bigint) => Promise<void>;
}

export interface PublishedCanonicalBlob extends DiscoveredBlobSegment {
  chainId: bigint;
  sender: string;
  gasUsed: bigint;
  blobGasUsed: bigint;
  worstCaseCostWei: bigint;
  receipt: TransactionReceipt;
}

export interface PublishCanonicalBlobsOptions {
  provider: JsonRpcProvider;
  signer: Signer;
  contractAddress: string;
  preparedBlobs: readonly PreparedCanonicalBlob[];
  multicallAddress?: string;
  confirmations?: number;
  maxCostWei?: bigint;
  reserveCost?: (worstCaseCostWei: bigint) => Promise<void>;
}

export interface PublishedCanonicalBlobs {
  chainId: bigint;
  sender: string;
  transactionHash: string;
  segments: DiscoveredBlobSegment[];
  gasUsed: bigint;
  blobGasUsed: bigint;
  worstCaseCostWei: bigint;
  receipt: TransactionReceipt;
}

function parseHexQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) {
    throw new Error(`${label} RPC response is malformed`);
  }
  return getBigInt(value);
}

async function blobBaseFee(provider: JsonRpcProvider): Promise<bigint> {
  const value = await provider.send("eth_blobBaseFee", []);
  const fee = parseHexQuantity(value, "eth_blobBaseFee");
  if (fee < 1n) throw new Error("Blob base fee must be positive");
  return fee;
}

function parseSegmentLog(log: Log): DiscoveredBlobSegment | null {
  let parsed;
  try {
    parsed = erc8179Interface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "BlobSegmentDeclared") return null;

  return {
    contractAddress: getAddress(log.address),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.index,
    versionedHash: String(parsed.args.versionedHash).toLowerCase(),
    declarer: getAddress(String(parsed.args.declarer)),
    startFE: Number(parsed.args.startFE),
    endFE: Number(parsed.args.endFE),
    contentTag: String(parsed.args.contentTag).toLowerCase(),
  };
}

export async function discoverBlobSegments(
  provider: JsonRpcProvider,
  options: {
    contractAddress: string;
    fromBlock: BlockTag;
    toBlock: BlockTag;
    contentTag?: string;
  },
): Promise<DiscoveredBlobSegment[]> {
  const contractAddress = getAddress(options.contractAddress);
  const contentTag = (options.contentTag ?? CONTENT_TAG).toLowerCase();
  const filter: Filter = {
    address: contractAddress,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    // Batching is permissionless. The declarer topic is intentionally not
    // filtered; private envelope authentication happens after blob retrieval.
    topics: erc8179DiscoveryTopics(contentTag),
  };
  const logs = await provider.getLogs(filter);

  return logs
    .map(parseSegmentLog)
    .filter((segment): segment is DiscoveredBlobSegment => segment !== null)
    .filter(
      (segment) =>
        segment.contractAddress === contractAddress &&
        segment.contentTag === contentTag,
    );
}

export async function publishCanonicalBlob(
  options: PublishCanonicalBlobOptions,
): Promise<PublishedCanonicalBlob> {
  const { provider, signer, preparedBlob } = options;
  const contractAddress = getAddress(options.contractAddress);
  const sender = getAddress(await signer.getAddress());
  const [network, code, feeData, currentBlobBaseFee] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(contractAddress),
    provider.getFeeData(),
    blobBaseFee(provider),
  ]);
  if (code === "0x") throw new Error(`ERC-8179 contract has no code at ${contractAddress}`);

  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  if (maxFeePerGas === null || maxPriorityFeePerGas === null) {
    throw new Error("Execution RPC did not return EIP-1559 fee data");
  }
  const maxFeePerBlobGas = currentBlobBaseFee * 2n;
  const data = erc8179Interface.encodeFunctionData("declareBlobSegment", [
    0,
    0,
    FIELD_ELEMENTS_PER_BLOB,
    CONTENT_TAG,
  ]);

  const request: TransactionRequest = {
    type: 3,
    chainId: network.chainId,
    from: sender,
    to: contractAddress,
    data,
    value: 0n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxFeePerBlobGas,
    blobVersionedHashes: [preparedBlob.versionedHash],
    blobs: [
      {
        data: preparedBlob.dataHex,
        commitment: preparedBlob.commitment,
        proof: preparedBlob.proof,
      },
    ],
  };

  const estimatedGas = await provider.estimateGas(request);
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  request.gasLimit = gasLimit;
  const worstCaseCostWei = gasLimit * maxFeePerGas + BLOB_GAS_PER_BLOB * maxFeePerBlobGas;
  if (options.maxCostWei !== undefined && worstCaseCostWei > options.maxCostWei) {
    throw new Error(
      `Worst-case publication cost ${worstCaseCostWei} wei exceeds the configured cap ` +
        `${options.maxCostWei} wei`,
    );
  }
  const balance = await provider.getBalance(sender);
  if (balance < worstCaseCostWei) {
    throw new Error(
      `Batcher ${sender} has ${balance} wei but needs up to ${worstCaseCostWei} wei`,
    );
  }
  await options.reserveCost?.(worstCaseCostWei);

  const transaction = await signer.sendTransaction(request);
  const expectedHash = preparedBlob.versionedHash.toLowerCase();
  if (
    transaction.blobVersionedHashes?.length !== 1 ||
    transaction.blobVersionedHashes[0]?.toLowerCase() !== expectedHash
  ) {
    throw new Error("Signed transaction did not preserve the canonical blob versioned hash");
  }
  const receipt = await transaction.wait(options.confirmations ?? 1);
  if (!receipt || receipt.status !== 1) throw new Error("Blob publication transaction reverted");

  const discovered = await discoverBlobSegments(provider, {
    contractAddress,
    contentTag: CONTENT_TAG,
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  const segment = discovered.find(
    (candidate) =>
      candidate.transactionHash === transaction.hash &&
      candidate.versionedHash === expectedHash &&
      candidate.declarer === sender,
  );
  if (!segment) throw new Error("Canonical ERC-8179 declaration event was not discoverable");
  if (segment.startFE !== 0 || segment.endFE !== FIELD_ELEMENTS_PER_BLOB) {
    throw new Error("ERC-8179 declaration did not cover the canonical full blob");
  }

  const blobGasUsed = receipt.blobGasUsed;
  if (blobGasUsed !== BLOB_GAS_PER_BLOB) {
    throw new Error(
      `Expected one blob (${BLOB_GAS_PER_BLOB} blob gas), got ${String(blobGasUsed)}`,
    );
  }

  return {
    ...segment,
    chainId: network.chainId,
    sender,
    gasUsed: receipt.gasUsed,
    blobGasUsed,
    worstCaseCostWei,
    receipt,
  };
}

export async function publishCanonicalBlobs(
  options: PublishCanonicalBlobsOptions,
): Promise<PublishedCanonicalBlobs> {
  const { provider, signer, preparedBlobs } = options;
  if (
    preparedBlobs.length < 1 ||
    preparedBlobs.length > MAX_BLOBS_PER_TRANSACTION
  ) {
    throw new RangeError(
      `A publication must contain between 1 and ${MAX_BLOBS_PER_TRANSACTION} blobs`,
    );
  }
  const contractAddress = getAddress(options.contractAddress);
  const multicallAddress = getAddress(options.multicallAddress ?? MULTICALL3_ADDRESS);
  const sender = getAddress(await signer.getAddress());
  const [network, contractCode, multicallCode, feeData, currentBlobBaseFee] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(contractAddress),
    provider.getCode(multicallAddress),
    provider.getFeeData(),
    blobBaseFee(provider),
  ]);
  if (contractCode === "0x") throw new Error(`ERC-8179 contract has no code at ${contractAddress}`);
  if (multicallCode === "0x") throw new Error(`Multicall3 has no code at ${multicallAddress}`);

  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  if (maxFeePerGas === null || maxPriorityFeePerGas === null) {
    throw new Error("Execution RPC did not return EIP-1559 fee data");
  }
  const maxFeePerBlobGas = currentBlobBaseFee * 2n;
  const calls = preparedBlobs.map((_, blobIndex) => ({
    target: contractAddress,
    allowFailure: false,
    callData: erc8179Interface.encodeFunctionData("declareBlobSegment", [
      blobIndex,
      0,
      FIELD_ELEMENTS_PER_BLOB,
      CONTENT_TAG,
    ]),
  }));
  const expectedHashes = preparedBlobs.map((blob) => blob.versionedHash.toLowerCase());
  const request: TransactionRequest = {
    type: 3,
    chainId: network.chainId,
    from: sender,
    to: multicallAddress,
    data: multicall3Interface.encodeFunctionData("aggregate3", [calls]),
    value: 0n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxFeePerBlobGas,
    blobVersionedHashes: expectedHashes,
    blobs: preparedBlobs.map((blob) => ({
      data: blob.dataHex,
      commitment: blob.commitment,
      proof: blob.proof,
    })),
  };

  const estimatedGas = await provider.estimateGas(request);
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  request.gasLimit = gasLimit;
  const expectedBlobGas = BLOB_GAS_PER_BLOB * BigInt(preparedBlobs.length);
  const worstCaseCostWei = gasLimit * maxFeePerGas + expectedBlobGas * maxFeePerBlobGas;
  if (options.maxCostWei !== undefined && worstCaseCostWei > options.maxCostWei) {
    throw new Error(
      `Worst-case publication cost ${worstCaseCostWei} wei exceeds the configured cap ` +
        `${options.maxCostWei} wei`,
    );
  }
  const balance = await provider.getBalance(sender);
  if (balance < worstCaseCostWei) {
    throw new Error(
      `Batcher ${sender} has ${balance} wei but needs up to ${worstCaseCostWei} wei`,
    );
  }
  await options.reserveCost?.(worstCaseCostWei);

  const transaction = await signer.sendTransaction(request);
  const signedHashes = transaction.blobVersionedHashes?.map((hash) => hash.toLowerCase());
  if (
    signedHashes?.length !== expectedHashes.length ||
    signedHashes.some((hash, index) => hash !== expectedHashes[index])
  ) {
    throw new Error("Signed transaction did not preserve every canonical blob versioned hash");
  }
  const receipt = await transaction.wait(options.confirmations ?? 1);
  if (!receipt || receipt.status !== 1) throw new Error("Multi-blob publication transaction reverted");

  const discovered = await discoverBlobSegments(provider, {
    contractAddress,
    contentTag: CONTENT_TAG,
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  const transactionSegments = discovered
    .filter((segment) => segment.transactionHash === transaction.hash)
    .sort((left, right) => left.logIndex - right.logIndex);
  const remaining = [...transactionSegments];
  const segments = expectedHashes.map((expectedHash) => {
    const index = remaining.findIndex(
      (segment) =>
        segment.versionedHash === expectedHash &&
        segment.startFE === 0 &&
        segment.endFE === FIELD_ELEMENTS_PER_BLOB,
    );
    if (index < 0) throw new Error(`ERC-8179 event is missing for blob ${expectedHash}`);
    return remaining.splice(index, 1)[0]!;
  });
  if (segments.some((segment) => segment.declarer !== multicallAddress)) {
    throw new Error("Multi-blob declaration did not originate through Multicall3");
  }

  const blobGasUsed = receipt.blobGasUsed;
  if (blobGasUsed !== expectedBlobGas) {
    throw new Error(`Expected ${expectedBlobGas} blob gas, got ${String(blobGasUsed)}`);
  }
  return {
    chainId: network.chainId,
    sender,
    transactionHash: transaction.hash,
    segments,
    gasUsed: receipt.gasUsed,
    blobGasUsed,
    worstCaseCostWei,
    receipt,
  };
}
