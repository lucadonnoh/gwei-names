import {
  BrowserProvider,
  Interface,
  JsonRpcProvider,
  dataLength,
  ensNormalize,
  getAddress,
  hashMessage,
  isHexString,
  keccak256,
  namehash,
  toUtf8Bytes,
  verifyMessage,
} from "ethers";
import type {
  BlockTag,
  Eip1193Provider,
  Network,
  TransactionRequest,
} from "ethers";

export const GNS_CONTRACT_ADDRESS = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
export const GNS_CHAT_TEXT_KEY = "domains.gwei.chat";
export const GNS_CHAT_RECORD_VERSION = 0;

const MAX_RECORD_BYTES = 2_048;
const MAX_CONTACT_CODE_LENGTH = 2_048;
const MAX_SIGNATURE_BYTES = 1_024;
const ERC1271_MAGIC_VALUE = "0x1626ba7e";

const gnsInterface = new Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function text(uint256 tokenId, string key) view returns (string)",
  "function getFullName(uint256 tokenId) view returns (string)",
  "function setText(uint256 tokenId, string key, string value)",
]);

const erc1271Interface = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

export interface GnsChatRecord {
  v: 0;
  c: string;
  s: string;
}

export interface GnsContactBinding {
  chainId: bigint;
  contractAddress: string;
  tokenId: bigint;
  contactCode: string;
}

export interface ResolvedGweiContact {
  name: string;
  tokenId: bigint;
  owner: string;
  contactCode: string;
  blockNumber: number;
}

export interface PublishedGweiContact extends ResolvedGweiContact {
  transactionHash: string;
}

export interface GnsReadProvider {
  call(transaction: TransactionRequest): Promise<string>;
  getBlockNumber(): Promise<number>;
  getCode(address: string, blockTag?: BlockTag): Promise<string>;
  getNetwork(): Promise<Network>;
}

interface SignatureProvider {
  call(transaction: TransactionRequest): Promise<string>;
  getCode(address: string, blockTag?: BlockTag): Promise<string>;
}

interface ResolveOptions {
  provider: GnsReadProvider;
  name: string;
  expectedChainId?: bigint;
  contractAddress?: string;
}

interface ResolveTokenOptions {
  provider: GnsReadProvider;
  tokenId: bigint;
  expectedChainId?: bigint;
  contractAddress?: string;
  blockNumber?: number;
}

interface RpcResolveOptions extends Omit<ResolveOptions, "provider"> {
  rpcUrl: string;
}

interface PublishOptions {
  ethereum: Eip1193Provider;
  name: string;
  contactCode: string;
  expectedChainId: bigint;
  contractAddress?: string;
}

function singleResult(
  contractInterface: Interface,
  functionName: string,
  data: string,
): unknown {
  const decoded = contractInterface.decodeFunctionResult(functionName, data);
  return decoded[0];
}

function requireAddress(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} returned malformed data`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} returned an invalid address`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} returned malformed data`);
  return value;
}

function contractAddress(value = GNS_CONTRACT_ADDRESS): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error("The configured GNS contract address is invalid");
  }
}

function blockRequest(to: string, data: string, blockTag: BlockTag): TransactionRequest {
  return { to, data, blockTag };
}

export function normalizeGweiName(value: string): string {
  if (typeof value !== "string") throw new Error("Enter a .gwei name");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) throw new Error("Enter a valid .gwei name");

  const candidate = trimmed.includes(".") ? trimmed : `${trimmed}.gwei`;
  let normalized: string;
  try {
    normalized = ensNormalize(candidate);
  } catch {
    throw new Error("That .gwei name is not valid under ENS normalization rules");
  }

  const labels = normalized.split(".");
  if (labels.length < 2 || labels.at(-1) !== "gwei" || labels.some((label) => !label)) {
    throw new Error("Enter a name ending in .gwei");
  }
  if (labels.length > 11) throw new Error("That .gwei name is too deeply nested");
  return normalized;
}

export function gweiTokenId(name: string): bigint {
  return BigInt(namehash(normalizeGweiName(name)));
}

export function contactBindingMessage(binding: GnsContactBinding): string {
  const address = contractAddress(binding.contractAddress);
  if (binding.chainId <= 0n) throw new Error("Chain ID must be positive");
  if (binding.tokenId < 0n) throw new Error("Token ID cannot be negative");
  if (!binding.contactCode || binding.contactCode.length > MAX_CONTACT_CODE_LENGTH) {
    throw new Error("Contact code is empty or too large");
  }
  const contactHash = keccak256(toUtf8Bytes(binding.contactCode));
  return [
    "gwei.domains chat contact",
    `Version: ${GNS_CHAT_RECORD_VERSION}`,
    `Chain ID: ${binding.chainId}`,
    `NameNFT: ${address}`,
    `Token ID: ${binding.tokenId}`,
    `Text record: ${GNS_CHAT_TEXT_KEY}`,
    `Contact hash: ${contactHash}`,
  ].join("\n");
}

export function encodeGnsChatRecord(contactCode: string, signature: string): string {
  if (!contactCode || contactCode.length > MAX_CONTACT_CODE_LENGTH) {
    throw new Error("Contact code is empty or too large");
  }
  if (!isHexString(signature) || dataLength(signature) === 0) {
    throw new Error("Wallet signature is malformed");
  }
  if (dataLength(signature) > MAX_SIGNATURE_BYTES) {
    throw new Error("Wallet signature is too large");
  }

  const encoded = JSON.stringify({
    v: GNS_CHAT_RECORD_VERSION,
    c: contactCode,
    s: signature,
  } satisfies GnsChatRecord);
  if (toUtf8Bytes(encoded).length > MAX_RECORD_BYTES) {
    throw new Error("The signed chat record is too large");
  }
  return encoded;
}

export function decodeGnsChatRecord(value: string): GnsChatRecord {
  if (!value) throw new Error("This name has no chat contact published");
  if (toUtf8Bytes(value).length > MAX_RECORD_BYTES) {
    throw new Error("The published chat record is too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The published chat record is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The published chat record is malformed");
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== GNS_CHAT_RECORD_VERSION) {
    throw new Error("The published chat record uses an unsupported version");
  }
  if (typeof record.c !== "string" || !record.c || record.c.length > MAX_CONTACT_CODE_LENGTH) {
    throw new Error("The published chat record has an invalid contact code");
  }
  if (
    typeof record.s !== "string" ||
    !isHexString(record.s) ||
    dataLength(record.s) === 0 ||
    dataLength(record.s) > MAX_SIGNATURE_BYTES
  ) {
    throw new Error("The published chat record has an invalid wallet signature");
  }
  return { v: GNS_CHAT_RECORD_VERSION, c: record.c, s: record.s };
}

export async function verifyContactOwnerSignature(options: {
  provider: SignatureProvider;
  owner: string;
  binding: GnsContactBinding;
  signature: string;
  blockTag: BlockTag;
}): Promise<boolean> {
  const owner = requireAddress(options.owner, "GNS owner");
  const message = contactBindingMessage(options.binding);

  try {
    if (getAddress(verifyMessage(message, options.signature)) === owner) return true;
  } catch {
    // Contract signatures are checked through ERC-1271 below.
  }

  const code = await options.provider.getCode(owner, options.blockTag);
  if (code === "0x") return false;
  const data = erc1271Interface.encodeFunctionData("isValidSignature", [
    hashMessage(message),
    options.signature,
  ]);
  try {
    const result = await options.provider.call(blockRequest(owner, data, options.blockTag));
    const magic = singleResult(erc1271Interface, "isValidSignature", result);
    return typeof magic === "string" && magic.toLowerCase() === ERC1271_MAGIC_VALUE;
  } catch {
    return false;
  }
}

async function readNameRecord(options: {
  provider: GnsReadProvider;
  normalizedName: string;
  tokenId?: bigint;
  chainId: bigint;
  contractAddress: string;
  blockNumber: number;
}): Promise<ResolvedGweiContact> {
  const tokenId = options.tokenId ?? gweiTokenId(options.normalizedName);
  if (tokenId !== gweiTokenId(options.normalizedName)) {
    throw new Error("The name returned by GNS does not match its token ID");
  }
  const ownerData = gnsInterface.encodeFunctionData("ownerOf", [tokenId]);
  const textData = gnsInterface.encodeFunctionData("text", [tokenId, GNS_CHAT_TEXT_KEY]);
  let ownerResult: string;
  let textResult: string;
  try {
    [ownerResult, textResult] = await Promise.all([
      options.provider.call(blockRequest(options.contractAddress, ownerData, options.blockNumber)),
      options.provider.call(blockRequest(options.contractAddress, textData, options.blockNumber)),
    ]);
  } catch {
    throw new Error(`${options.normalizedName} is not active on the configured network`);
  }

  const owner = requireAddress(
    singleResult(gnsInterface, "ownerOf", ownerResult),
    "GNS ownerOf",
  );
  const record = decodeGnsChatRecord(
    requireString(singleResult(gnsInterface, "text", textResult), "GNS text"),
  );
  const valid = await verifyContactOwnerSignature({
    provider: options.provider,
    owner,
    binding: {
      chainId: options.chainId,
      contractAddress: options.contractAddress,
      tokenId,
      contactCode: record.c,
    },
    signature: record.s,
    blockTag: options.blockNumber,
  });
  if (!valid) {
    throw new Error("This chat record is not signed by the current name owner");
  }

  return {
    name: options.normalizedName,
    tokenId,
    owner,
    contactCode: record.c,
    blockNumber: options.blockNumber,
  };
}

async function nameForToken(options: {
  provider: GnsReadProvider;
  tokenId: bigint;
  contractAddress: string;
  blockNumber: number;
}): Promise<string> {
  const data = gnsInterface.encodeFunctionData("getFullName", [options.tokenId]);
  let result: string;
  try {
    result = await options.provider.call(
      blockRequest(options.contractAddress, data, options.blockNumber),
    );
  } catch {
    throw new Error("The indexed GNS name is no longer available");
  }
  const fullName = requireString(
    singleResult(gnsInterface, "getFullName", result),
    "GNS getFullName",
  );
  if (!fullName) throw new Error("The indexed GNS name is no longer available");
  const normalizedName = normalizeGweiName(fullName);
  if (gweiTokenId(normalizedName) !== options.tokenId) {
    throw new Error("The name returned by GNS does not match its token ID");
  }
  return normalizedName;
}

export async function resolveGweiContactWithProvider(
  options: ResolveOptions,
): Promise<ResolvedGweiContact> {
  const normalizedName = normalizeGweiName(options.name);
  const address = contractAddress(options.contractAddress);
  const network = await options.provider.getNetwork();
  if (options.expectedChainId !== undefined && network.chainId !== options.expectedChainId) {
    throw new Error(
      `The configured RPC is on chain ${network.chainId}; expected ${options.expectedChainId}`,
    );
  }
  const blockNumber = await options.provider.getBlockNumber();
  return readNameRecord({
    provider: options.provider,
    normalizedName,
    chainId: network.chainId,
    contractAddress: address,
    blockNumber,
  });
}

/** Resolve a candidate discovered from a TextChanged event without trusting an offchain name. */
export async function resolveGweiContactTokenWithProvider(
  options: ResolveTokenOptions,
): Promise<ResolvedGweiContact> {
  if (options.tokenId < 0n) throw new Error("GNS token ID cannot be negative");
  const address = contractAddress(options.contractAddress);
  const network = await options.provider.getNetwork();
  if (options.expectedChainId !== undefined && network.chainId !== options.expectedChainId) {
    throw new Error(
      `The configured RPC is on chain ${network.chainId}; expected ${options.expectedChainId}`,
    );
  }
  const blockNumber = options.blockNumber ?? await options.provider.getBlockNumber();
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error("The configured RPC returned an invalid block number");
  }
  const normalizedName = await nameForToken({
    provider: options.provider,
    tokenId: options.tokenId,
    contractAddress: address,
    blockNumber,
  });
  return readNameRecord({
    provider: options.provider,
    normalizedName,
    tokenId: options.tokenId,
    chainId: network.chainId,
    contractAddress: address,
    blockNumber,
  });
}

export async function resolveGweiContact(
  options: RpcResolveOptions,
): Promise<ResolvedGweiContact> {
  const provider = new JsonRpcProvider(options.rpcUrl);
  try {
    return await resolveGweiContactWithProvider({
      provider,
      name: options.name,
      ...(options.expectedChainId === undefined
        ? {}
        : { expectedChainId: options.expectedChainId }),
      ...(options.contractAddress === undefined
        ? {}
        : { contractAddress: options.contractAddress }),
    });
  } finally {
    provider.destroy();
  }
}

export async function publishGweiContact(
  options: PublishOptions,
): Promise<PublishedGweiContact> {
  const normalizedName = normalizeGweiName(options.name);
  const address = contractAddress(options.contractAddress);
  const tokenId = gweiTokenId(normalizedName);
  const provider = new BrowserProvider(options.ethereum);
  const signer = await provider.getSigner();
  const [network, signerAddress] = await Promise.all([
    provider.getNetwork(),
    signer.getAddress().then(getAddress),
  ]);
  if (network.chainId !== options.expectedChainId) {
    throw new Error(
      `Switch your wallet to chain ${options.expectedChainId}; it is on ${network.chainId}`,
    );
  }

  const blockNumber = await provider.getBlockNumber();
  const ownerCall = gnsInterface.encodeFunctionData("ownerOf", [tokenId]);
  let owner: string;
  try {
    const ownerResult = await provider.call(blockRequest(address, ownerCall, blockNumber));
    owner = requireAddress(singleResult(gnsInterface, "ownerOf", ownerResult), "GNS ownerOf");
  } catch {
    throw new Error(`${normalizedName} is not active on this network`);
  }
  if (owner !== signerAddress) {
    throw new Error(`The connected wallet does not own ${normalizedName}`);
  }

  const binding: GnsContactBinding = {
    chainId: network.chainId,
    contractAddress: address,
    tokenId,
    contactCode: options.contactCode,
  };
  const signature = await signer.signMessage(contactBindingMessage(binding));
  const record = encodeGnsChatRecord(options.contactCode, signature);
  const valid = await verifyContactOwnerSignature({
    provider,
    owner,
    binding,
    signature,
    blockTag: blockNumber,
  });
  if (!valid) throw new Error("The wallet did not produce a valid owner signature");

  const data = gnsInterface.encodeFunctionData("setText", [tokenId, GNS_CHAT_TEXT_KEY, record]);
  const transaction = await signer.sendTransaction({ to: address, data });
  const receipt = await transaction.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error("Publishing the chat record failed");

  const resolved = await resolveGweiContactWithProvider({
    provider,
    name: normalizedName,
    expectedChainId: options.expectedChainId,
    contractAddress: address,
  });
  if (resolved.contactCode !== options.contactCode) {
    throw new Error("The published chat record did not verify after confirmation");
  }
  return { ...resolved, transactionHash: transaction.hash };
}
