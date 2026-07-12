import {
  JsonRpcProvider,
  getAddress,
  id,
  isHexString,
} from "ethers";
import type { Filter, Log } from "ethers";

import { decodeContactCode } from "./crypto";
import {
  GNS_CHAT_TEXT_KEY,
  GNS_CONTRACT_ADDRESS,
  resolveGweiContactTokenWithProvider,
} from "./gns-chat";
import type { GnsReadProvider, ResolvedGweiContact } from "./gns-chat";

export const GNS_TEXT_CHANGED_TOPIC = id("TextChanged(bytes32,string,string)");
export const GNS_CHAT_KEY_TOPIC = id(GNS_CHAT_TEXT_KEY);

const DEFAULT_LOG_RANGE = 10_000;
const MINIMUM_LOG_RANGE = 64;
const REORG_LOOKBACK_BLOCKS = 64;
const MAX_CANDIDATE_NAMES = 2_000;
const VERIFY_CONCURRENCY = 6;
const CACHE_VERSION = 0;

// NameNFT was deployed at the same address on both supported networks.
const KNOWN_DEPLOYMENT_BLOCKS: Readonly<Record<string, number>> = Object.freeze({
  "1": 25_403_689,
  "11155111": 11_142_856,
});

export interface GnsDirectoryProvider extends GnsReadProvider {
  getLogs(filter: Filter): Promise<Log[]>;
}

export interface GnsDirectoryCacheState {
  v: 0;
  fromBlock: number;
  scannedThrough: number;
  tokenIds: string[];
}

export interface GnsDirectoryCacheStore {
  load(key: string): GnsDirectoryCacheState | null;
  save(key: string, value: GnsDirectoryCacheState): void;
}

export interface GnsDirectoryIndex {
  latestBlock: number;
  scannedThrough: number;
  tokenIds: bigint[];
}

export type GnsDirectoryProgress =
  | {
    stage: "scanning";
    currentBlock: number;
    latestBlock: number;
    candidateCount: number;
  }
  | {
    stage: "verifying";
    checked: number;
    total: number;
    verified: number;
  };

export interface GnsDirectoryResult {
  chainId: bigint;
  latestBlock: number;
  candidateCount: number;
  contacts: ResolvedGweiContact[];
}

interface IndexOptions {
  provider: GnsDirectoryProvider;
  contractAddress?: string;
  fromBlock: number;
  cached?: GnsDirectoryCacheState | null;
  logRange?: number;
  onCheckpoint?: (state: GnsDirectoryCacheState) => void;
  onProgress?: (progress: Extract<GnsDirectoryProgress, { stage: "scanning" }>) => void;
}

interface DiscoverProviderOptions {
  provider: GnsDirectoryProvider;
  expectedChainId?: bigint;
  contractAddress?: string;
  fromBlock?: number;
  cache?: GnsDirectoryCacheStore | null;
  onProgress?: (progress: GnsDirectoryProgress) => void;
}

interface DiscoverRpcOptions extends Omit<DiscoverProviderOptions, "provider"> {
  rpcUrl: string;
}

function validBlock(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function cacheKey(chainId: bigint, address: string): string {
  return `gwei-chat-directory-v0:${chainId}:${address.toLowerCase()}`;
}

function validCache(value: unknown): GnsDirectoryCacheState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cache = value as Record<string, unknown>;
  if (
    cache.v !== CACHE_VERSION ||
    !Number.isSafeInteger(cache.fromBlock) ||
    Number(cache.fromBlock) < 0 ||
    !Number.isSafeInteger(cache.scannedThrough) ||
    Number(cache.scannedThrough) < -1 ||
    !Array.isArray(cache.tokenIds) ||
    cache.tokenIds.length > MAX_CANDIDATE_NAMES ||
    !cache.tokenIds.every((tokenId) => typeof tokenId === "string" && /^\d{1,78}$/u.test(tokenId))
  ) {
    return null;
  }
  try {
    if (Number(cache.scannedThrough) < Number(cache.fromBlock) - 1) return null;
    for (const tokenId of cache.tokenIds as string[]) {
      const parsed = BigInt(tokenId);
      if (parsed < 0n || parsed >= 1n << 256n) return null;
    }
  } catch {
    return null;
  }
  return {
    v: 0,
    fromBlock: Number(cache.fromBlock),
    scannedThrough: Number(cache.scannedThrough),
    tokenIds: [...new Set(cache.tokenIds as string[])],
  };
}

export const browserGnsDirectoryCache: GnsDirectoryCacheStore = {
  load(key) {
    try {
      const encoded = localStorage.getItem(key);
      if (!encoded || encoded.length > 1_000_000) return null;
      return validCache(JSON.parse(encoded) as unknown);
    } catch {
      return null;
    }
  },
  save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // A cache miss only makes the next public log scan slower.
    }
  },
};

export function knownGnsDeploymentBlock(
  chainId: bigint,
  address = GNS_CONTRACT_ADDRESS,
): number | undefined {
  if (getAddress(address) !== getAddress(GNS_CONTRACT_ADDRESS)) return undefined;
  return KNOWN_DEPLOYMENT_BLOCKS[chainId.toString()];
}

function rangeLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ranges? (?:over|above|larger|greater)|block range|too many (?:blocks|results)|query returned more|response size|timed? ?out|timeout|(?:block|log).*(?:limit|maximum)|(?:limit|maximum).*(?:block|log)/iu
    .test(message);
}

function checkpoint(
  fromBlock: number,
  scannedThrough: number,
  candidates: Set<string>,
): GnsDirectoryCacheState {
  return {
    v: 0,
    fromBlock,
    scannedThrough,
    tokenIds: [...candidates],
  };
}

/** Scan only the key-filtered TextChanged logs and retain public token-ID candidates. */
export async function indexGweiChatCandidatesWithProvider(
  options: IndexOptions,
): Promise<GnsDirectoryIndex> {
  const address = getAddress(options.contractAddress ?? GNS_CONTRACT_ADDRESS);
  const fromBlock = validBlock(options.fromBlock, "GNS deployment block");
  let logRange = validBlock(options.logRange ?? DEFAULT_LOG_RANGE, "GNS log range");
  if (logRange === 0) throw new Error("GNS log range is invalid");
  const latestBlock = validBlock(await options.provider.getBlockNumber(), "Latest block");
  const cached = options.cached?.fromBlock === fromBlock ? validCache(options.cached) : null;
  const candidates = new Set(cached?.tokenIds ?? []);
  let scannedThrough = cached?.scannedThrough ?? fromBlock - 1;

  if (latestBlock < fromBlock) {
    options.onProgress?.({
      stage: "scanning",
      currentBlock: latestBlock,
      latestBlock,
      candidateCount: candidates.size,
    });
    return { latestBlock, scannedThrough, tokenIds: [...candidates].map(BigInt) };
  }

  let nextBlock = cached
    ? Math.max(fromBlock, cached.scannedThrough - REORG_LOOKBACK_BLOCKS + 1)
    : fromBlock;
  while (nextBlock <= latestBlock) {
    const toBlock = Math.min(latestBlock, nextBlock + logRange - 1);
    let logs: Log[];
    try {
      logs = await options.provider.getLogs({
        address,
        fromBlock: nextBlock,
        toBlock,
        topics: [GNS_TEXT_CHANGED_TOPIC, null, GNS_CHAT_KEY_TOPIC],
      });
    } catch (error) {
      if (rangeLimitError(error) && logRange > MINIMUM_LOG_RANGE) {
        logRange = Math.max(MINIMUM_LOG_RANGE, Math.floor(logRange / 2));
        continue;
      }
      throw new Error(
        `The configured RPC cannot scan GNS text-record history: ${
          error instanceof Error ? error.message : "log query failed"
        }`,
        { cause: error },
      );
    }

    for (const log of logs) {
      const tokenTopic = log.topics[1];
      if (!tokenTopic || !isHexString(tokenTopic, 32)) continue;
      candidates.add(BigInt(tokenTopic).toString());
      if (candidates.size > MAX_CANDIDATE_NAMES) {
        throw new Error(
          `The browser directory exceeded ${MAX_CANDIDATE_NAMES} candidate names; ` +
            "use a verifiable index snapshot before expanding this prototype",
        );
      }
    }

    scannedThrough = Math.max(scannedThrough, toBlock);
    const state = checkpoint(fromBlock, scannedThrough, candidates);
    options.onCheckpoint?.(state);
    options.onProgress?.({
      stage: "scanning",
      currentBlock: toBlock,
      latestBlock,
      candidateCount: candidates.size,
    });
    nextBlock = toBlock + 1;
  }

  return {
    latestBlock,
    scannedThrough,
    tokenIds: [...candidates].map(BigInt),
  };
}

export async function discoverGweiChatContactsWithProvider(
  options: DiscoverProviderOptions,
): Promise<GnsDirectoryResult> {
  const address = getAddress(options.contractAddress ?? GNS_CONTRACT_ADDRESS);
  const network = await options.provider.getNetwork();
  if (options.expectedChainId !== undefined && network.chainId !== options.expectedChainId) {
    throw new Error(
      `The configured RPC is on chain ${network.chainId}; expected ${options.expectedChainId}`,
    );
  }
  const fromBlock = options.fromBlock ?? knownGnsDeploymentBlock(network.chainId, address);
  if (fromBlock === undefined) {
    throw new Error("Set gnsFromBlock when using a custom GNS contract");
  }
  validBlock(fromBlock, "GNS deployment block");

  const key = cacheKey(network.chainId, address);
  const cached = options.cache?.load(key) ?? null;
  const index = await indexGweiChatCandidatesWithProvider({
    provider: options.provider,
    contractAddress: address,
    fromBlock,
    cached,
    onCheckpoint: (state) => options.cache?.save(key, state),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  let next = 0;
  let checked = 0;
  const contacts: ResolvedGweiContact[] = [];
  const verify = async (): Promise<void> => {
    while (next < index.tokenIds.length) {
      const candidate = index.tokenIds[next];
      next += 1;
      if (candidate === undefined) continue;
      try {
        const resolved = await resolveGweiContactTokenWithProvider({
          provider: options.provider,
          tokenId: candidate,
          expectedChainId: network.chainId,
          contractAddress: address,
          blockNumber: index.latestBlock,
        });
        // The GNS owner binding and the chat identity's own signature must both be current.
        await decodeContactCode(resolved.contactCode);
        contacts.push(resolved);
      } catch {
        // Cleared, expired, transferred, malformed, or stale records are intentionally hidden.
      }
      checked += 1;
      options.onProgress?.({
        stage: "verifying",
        checked,
        total: index.tokenIds.length,
        verified: contacts.length,
      });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(VERIFY_CONCURRENCY, Math.max(1, index.tokenIds.length)) },
      verify,
    ),
  );
  contacts.sort((left, right) => left.name.localeCompare(right.name));

  return {
    chainId: network.chainId,
    latestBlock: index.latestBlock,
    candidateCount: index.tokenIds.length,
    contacts,
  };
}

export async function discoverGweiChatContacts(
  options: DiscoverRpcOptions,
): Promise<GnsDirectoryResult> {
  const provider = new JsonRpcProvider(options.rpcUrl);
  try {
    return await discoverGweiChatContactsWithProvider({
      provider,
      ...(options.expectedChainId === undefined
        ? {}
        : { expectedChainId: options.expectedChainId }),
      ...(options.contractAddress === undefined
        ? {}
        : { contractAddress: options.contractAddress }),
      ...(options.fromBlock === undefined ? {} : { fromBlock: options.fromBlock }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
  } finally {
    provider.destroy();
  }
}
