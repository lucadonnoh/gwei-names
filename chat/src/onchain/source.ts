import { JsonRpcProvider, getAddress } from "ethers";

import { CONTENT_TAG, FIELD_ELEMENTS_PER_BLOB } from "../blob-batch";
import {
  BlobUnavailableError,
  InvalidGweiBlobError,
  getBeaconAvailabilityConfig,
  retrieveAvailableCanonicalBlob,
} from "./availability";
import type { BeaconAvailabilityConfig } from "./availability";
import { discoverBlobSegments } from "./erc8179";
import type { DiscoveredBlobSegment } from "./erc8179";

const LOG_SEQUENCE_SCALE = 1_000_000;
const BLOCK_COMPLETE_INDEX = LOG_SEQUENCE_SCALE - 1;

export interface OnchainBlobSourceOptions {
  executionRpcUrl: string;
  beaconApiUrl: string;
  contractAddress: string;
  expectedChainId?: bigint;
  logRange?: number;
  pageSize?: number;
}

export interface SequencedBlobSegment extends DiscoveredBlobSegment {
  sequence: number;
}

export interface OnchainBlobPage {
  segments: SequencedBlobSegment[];
  scannedThrough: number;
  hasMore: boolean;
}

export interface FinalizedOnchainCursor {
  sequence: number;
  finalizedAt: number;
}

interface SourceConfiguration {
  availability: BeaconAvailabilityConfig;
  initialBlock: number;
  chainId: bigint;
}

interface BufferedSegments {
  expectedCursor: number;
  segments: SequencedBlobSegment[];
  scannedThrough: number;
  hasMoreAfter: boolean;
}

export function blobEventSequence(blockNumber: number, logIndex: number): number {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new RangeError("Block number is invalid");
  }
  if (!Number.isSafeInteger(logIndex) || logIndex < 0 || logIndex >= LOG_SEQUENCE_SCALE) {
    throw new RangeError("Log index is invalid");
  }
  const sequence = blockNumber * LOG_SEQUENCE_SCALE + logIndex;
  if (!Number.isSafeInteger(sequence)) throw new RangeError("Blob event sequence exceeds safe integers");
  return sequence;
}

function completedBlockSequence(blockNumber: number): number {
  return blobEventSequence(blockNumber, BLOCK_COMPLETE_INDEX);
}

function firstBlockAfterCursor(cursor: number, initialBlock: number): number {
  if (cursor < 0) return initialBlock;
  const block = Math.floor(cursor / LOG_SEQUENCE_SCALE);
  return cursor % LOG_SEQUENCE_SCALE === BLOCK_COMPLETE_INDEX ? block + 1 : block;
}

export class OnchainBlobSource {
  readonly #provider: JsonRpcProvider;
  readonly #beaconApiUrl: string;
  readonly #contractAddress: string;
  readonly #expectedChainId: bigint | undefined;
  readonly #logRange: number;
  readonly #pageSize: number;
  #configurationPromise: Promise<SourceConfiguration> | undefined;
  #buffered: BufferedSegments | undefined;

  constructor(options: OnchainBlobSourceOptions) {
    this.#provider = new JsonRpcProvider(options.executionRpcUrl);
    this.#beaconApiUrl = options.beaconApiUrl.replace(/\/$/u, "");
    this.#contractAddress = getAddress(options.contractAddress);
    this.#expectedChainId = options.expectedChainId;
    this.#logRange = options.logRange ?? 10_000;
    this.#pageSize = options.pageSize ?? 8;
    if (!Number.isSafeInteger(this.#logRange) || this.#logRange < 1) {
      throw new RangeError("Onchain log range must be positive");
    }
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 32) {
      throw new RangeError("Onchain page size must be between 1 and 32");
    }
  }

  async #configuration(): Promise<SourceConfiguration> {
    this.#configurationPromise ||= (async () => {
      const [network, availability, finalized] = await Promise.all([
        this.#provider.getNetwork(),
        getBeaconAvailabilityConfig(this.#beaconApiUrl),
        this.#provider.getBlock("finalized"),
      ]);
      if (this.#expectedChainId !== undefined && network.chainId !== this.#expectedChainId) {
        throw new Error(`Onchain source is chain ${network.chainId}, expected ${this.#expectedChainId}`);
      }
      if (!finalized) throw new Error("Execution RPC did not return a finalized block");
      const retainedSlots = availability.slotsPerEpoch * availability.retentionEpochs;
      if (retainedSlots > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Beacon availability window is too large");
      }
      // At most one execution block exists per beacon slot. Subtracting slots
      // may look slightly farther back after skipped slots, never too little.
      const initialBlock = Math.max(0, finalized.number - Number(retainedSlots));
      return { availability, initialBlock, chainId: network.chainId };
    })();
    return this.#configurationPromise;
  }

  async chainId(): Promise<bigint> {
    return (await this.#configuration()).chainId;
  }

  async finalizedCursor(): Promise<FinalizedOnchainCursor> {
    await this.#configuration();
    const finalized = await this.#provider.getBlock("finalized");
    if (!finalized) throw new Error("Execution RPC did not return a finalized block");
    return {
      sequence: completedBlockSequence(finalized.number),
      finalizedAt: finalized.timestamp * 1_000,
    };
  }

  async list(cursor: number): Promise<OnchainBlobPage> {
    if (!Number.isSafeInteger(cursor) || cursor < -1) throw new RangeError("Onchain cursor is invalid");
    if (this.#buffered) {
      if (this.#buffered.expectedCursor === cursor) {
        const page = this.#buffered.segments.splice(0, this.#pageSize);
        const last = page.at(-1);
        if (!last) throw new Error("Onchain segment buffer is empty");
        if (this.#buffered.segments.length > 0) {
          this.#buffered.expectedCursor = last.sequence;
          return {
            segments: page,
            scannedThrough: last.sequence,
            hasMore: true,
          };
        }
        const { scannedThrough, hasMoreAfter } = this.#buffered;
        this.#buffered = undefined;
        return { segments: page, scannedThrough, hasMore: hasMoreAfter };
      }
      // A caller may restore or advance a cursor independently. Never serve a
      // cached continuation unless it follows the exact page that created it.
      this.#buffered = undefined;
    }
    const configuration = await this.#configuration();
    const finalized = await this.#provider.getBlock("finalized");
    if (!finalized) throw new Error("Execution RPC did not return a finalized block");
    let fromBlock = firstBlockAfterCursor(cursor, configuration.initialBlock);
    if (fromBlock > finalized.number) {
      return { segments: [], scannedThrough: cursor, hasMore: false };
    }

    const collected: SequencedBlobSegment[] = [];
    while (fromBlock <= finalized.number) {
      const toBlock = Math.min(finalized.number, fromBlock + this.#logRange - 1);
      const segments = await discoverBlobSegments(this.#provider, {
        contractAddress: this.#contractAddress,
        contentTag: CONTENT_TAG,
        fromBlock,
        toBlock,
      });
      for (const segment of segments) {
        const sequence = blobEventSequence(segment.blockNumber, segment.logIndex);
        if (
          sequence > cursor &&
          segment.startFE === 0 &&
          segment.endFE === FIELD_ELEMENTS_PER_BLOB
        ) {
          collected.push({ ...segment, sequence });
        }
      }
      collected.sort((left, right) => left.sequence - right.sequence);
      if (collected.length >= this.#pageSize) {
        const page = collected.slice(0, this.#pageSize);
        const remaining = collected.slice(this.#pageSize);
        const scannedThrough = completedBlockSequence(toBlock);
        const hasMoreAfter = toBlock < finalized.number;
        if (remaining.length > 0) {
          this.#buffered = {
            expectedCursor: page.at(-1)!.sequence,
            segments: remaining,
            scannedThrough,
            hasMoreAfter,
          };
        }
        return {
          segments: page,
          scannedThrough: remaining.length > 0 ? page.at(-1)!.sequence : scannedThrough,
          hasMore: remaining.length > 0 || hasMoreAfter,
        };
      }
      fromBlock = toBlock + 1;
    }

    return {
      segments: collected,
      scannedThrough: completedBlockSequence(finalized.number),
      hasMore: false,
    };
  }

  async fetch(segment: SequencedBlobSegment): Promise<Uint8Array | null> {
    const [configuration, block] = await Promise.all([
      this.#configuration(),
      this.#provider.getBlock(segment.blockNumber),
    ]);
    if (!block) throw new Error(`Execution block ${segment.blockNumber} is unavailable`);
    try {
      const available = await retrieveAvailableCanonicalBlob({
        beaconApiUrl: this.#beaconApiUrl,
        executionTimestamp: BigInt(block.timestamp),
        versionedHash: segment.versionedHash,
        availabilityConfig: configuration.availability,
      });
      return available.blob;
    } catch (error) {
      if (error instanceof BlobUnavailableError || error instanceof InvalidGweiBlobError) {
        return null;
      }
      throw error;
    }
  }
}
