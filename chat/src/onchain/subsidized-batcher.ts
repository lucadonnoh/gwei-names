import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  JsonRpcProvider,
  Wallet,
  getAddress,
  parseEther,
} from "ethers";

import type { StoredBatch } from "../batcher";
import {
  MAX_BLOBS_PER_TRANSACTION,
  publishCanonicalBlob,
  publishCanonicalBlobs,
} from "./erc8179";
import { prepareCanonicalBlob } from "./kzg";
import { DailyBudgetExceededError, dailyUsdBudgetFromEnvironment } from "./daily-budget";
import type { DailyUsdBudget } from "./daily-budget";

const SEPOLIA_CHAIN_ID = 11_155_111n;
const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DEFAULT_SEPOLIA_ERC8179 = "0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314";

export interface BatchPublicationResult {
  transactionHash: string;
  blockNumber: number;
  versionedHashes: readonly string[];
}

export interface BatchPublishBackend {
  publish(
    blobs: readonly Uint8Array[],
    sequences: readonly number[],
  ): Promise<BatchPublicationResult>;
  close?(): void;
}

export interface PublishedBatchStatus {
  sequence: number;
  transactionHash: string;
  blockNumber: number;
  versionedHash: string;
  publishedAt: number;
}

export interface SubsidizedPublisherStatus {
  enabled: true;
  state: "idle" | "publishing" | "retrying" | "stopped";
  queued: number;
  batcherAddress: string;
  chainId: string;
  contractAddress: string;
  maxBlobsPerTransaction: number;
  latest: PublishedBatchStatus | null;
  error: string | null;
}

export type SubsidizedPublisherEvent =
  | { state: "publishing"; sequence: number }
  | ({ state: "published" } & PublishedBatchStatus)
  | { state: "retrying"; sequence: number; retryInMs: number };

export interface SubsidizedBatchPublisherOptions {
  backend: BatchPublishBackend;
  batcherAddress: string;
  chainId: bigint;
  contractAddress: string;
  maxBlobsPerTransaction?: number;
  retryDelayMs?: number;
  onEvent?: (event: SubsidizedPublisherEvent) => void;
  onError?: (error: unknown) => void;
}

interface QueuedBatch {
  sequence: number;
  blob: Uint8Array;
}

export class SubsidizedBatchPublisher {
  readonly #backend: BatchPublishBackend;
  readonly #batcherAddress: string;
  readonly #chainId: bigint;
  readonly #contractAddress: string;
  readonly #maxBlobsPerTransaction: number;
  readonly #retryDelayMs: number;
  readonly #onEvent: ((event: SubsidizedPublisherEvent) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #queue: QueuedBatch[] = [];
  readonly #sequences = new Set<number>();
  #state: SubsidizedPublisherStatus["state"] = "idle";
  #latest: PublishedBatchStatus | null = null;
  #error: string | null = null;
  #running = false;
  #stopped = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SubsidizedBatchPublisherOptions) {
    if (!Number.isSafeInteger(options.retryDelayMs ?? 15_000) || (options.retryDelayMs ?? 15_000) < 1) {
      throw new RangeError("Publication retry delay must be a positive integer");
    }
    const maxBlobsPerTransaction = options.maxBlobsPerTransaction ??
      MAX_BLOBS_PER_TRANSACTION;
    if (
      !Number.isSafeInteger(maxBlobsPerTransaction) ||
      maxBlobsPerTransaction < 1 ||
      maxBlobsPerTransaction > MAX_BLOBS_PER_TRANSACTION
    ) {
      throw new RangeError(
        `Maximum blobs per transaction must be between 1 and ${MAX_BLOBS_PER_TRANSACTION}`,
      );
    }
    this.#backend = options.backend;
    this.#batcherAddress = getAddress(options.batcherAddress);
    this.#chainId = options.chainId;
    this.#contractAddress = getAddress(options.contractAddress);
    this.#maxBlobsPerTransaction = maxBlobsPerTransaction;
    this.#retryDelayMs = options.retryDelayMs ?? 15_000;
    this.#onEvent = options.onEvent;
    this.#onError = options.onError;
  }

  get maxBlobsPerTransaction(): number {
    return this.#maxBlobsPerTransaction;
  }

  status(): SubsidizedPublisherStatus {
    return {
      enabled: true,
      state: this.#state,
      queued: this.#queue.length,
      batcherAddress: this.#batcherAddress,
      chainId: this.#chainId.toString(),
      contractAddress: this.#contractAddress,
      maxBlobsPerTransaction: this.#maxBlobsPerTransaction,
      latest: this.#latest ? { ...this.#latest } : null,
      error: this.#error,
    };
  }

  enqueue(batch: StoredBatch): boolean {
    return this.enqueueMany([batch]) === 1;
  }

  enqueueMany(batches: readonly StoredBatch[]): number {
    if (this.#stopped) throw new Error("Subsidized publisher is stopped");
    let added = 0;
    for (const batch of batches) {
      const sequence = batch.metadata.sequence;
      if (this.#sequences.has(sequence)) continue;
      this.#sequences.add(sequence);
      this.#queue.push({ sequence, blob: batch.blob.slice() });
      added += 1;
    }
    if (added > 0) this.#start();
    return added;
  }

  stop(): void {
    this.#stopped = true;
    this.#state = "stopped";
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#backend.close?.();
  }

  #emit(event: SubsidizedPublisherEvent): void {
    try {
      this.#onEvent?.(event);
    } catch (error) {
      this.#onError?.(error);
    }
  }

  #start(): void {
    if (this.#running || this.#stopped || this.#retryTimer) return;
    void this.#drain().catch((error: unknown) => {
      this.#onError?.(error);
    });
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      while (!this.#stopped && this.#queue.length > 0) {
        const current = this.#queue.slice(0, this.#maxBlobsPerTransaction);
        const first = current[0]!;
        const sequences = current.map((batch) => batch.sequence);
        this.#state = "publishing";
        this.#error = null;
        this.#emit({ state: "publishing", sequence: first.sequence });
        let result: BatchPublicationResult;
        try {
          result = await this.#backend.publish(
            current.map((batch) => batch.blob),
            sequences,
          );
          if (result.versionedHashes.length !== current.length) {
            throw new Error("Publication result did not identify every queued blob");
          }
        } catch (error) {
          this.#state = "retrying";
          this.#error = "Publication failed; the batch is retained for retry";
          this.#onError?.(error);
          const retryInMs = error instanceof DailyBudgetExceededError
            ? error.retryAfterMs
            : this.#retryDelayMs;
          this.#emit({
            state: "retrying",
            sequence: first.sequence,
            retryInMs,
          });
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.#start();
          }, retryInMs);
          this.#retryTimer.unref?.();
          return;
        }

        this.#queue.splice(0, current.length);
        const publishedAt = Date.now();
        current.forEach((batch, index) => {
          this.#sequences.delete(batch.sequence);
          this.#latest = {
            sequence: batch.sequence,
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            versionedHash: result.versionedHashes[index]!,
            publishedAt,
          };
          this.#emit({ state: "published", ...this.#latest });
        });
        this.#state = "idle";
      }
    } finally {
      this.#running = false;
      if (!this.#stopped && this.#queue.length === 0) this.#state = "idle";
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

async function privateKeyFromFile(pathValue: string): Promise<string> {
  const path = resolve(pathValue);
  const file = await stat(path);
  if ((file.mode & 0o077) !== 0) throw new Error("Batcher key file permissions must be 0600");
  const privateKey = (await readFile(path, "utf8")).trim();
  if (!/^0x[0-9a-f]{64}$/iu.test(privateKey)) throw new Error("Batcher key file is malformed");
  return privateKey;
}

export async function subsidizedPublisherFromEnvironment(options: {
  onEvent?: (event: SubsidizedPublisherEvent) => void;
  onError?: (error: unknown) => void;
} = {}): Promise<SubsidizedBatchPublisher | null> {
  const enabled = !["0", "false", "off"].includes(
    (process.env.ONCHAIN_PUBLISH || "1").trim().toLowerCase(),
  );
  const keyFile = process.env.BATCHER_KEY_FILE?.trim();
  if (!enabled || !keyFile) return null;

  const executionRpcUrl = process.env.PUBLISH_EXECUTION_RPC_URL?.trim() ||
    process.env.EXECUTION_RPC_URL?.trim() ||
    DEFAULT_SEPOLIA_RPC;
  const expectedChainId = BigInt(process.env.EXPECTED_CHAIN_ID?.trim() || SEPOLIA_CHAIN_ID);
  const contractAddress = getAddress(
    process.env.ERC8179_ADDRESS?.trim() || DEFAULT_SEPOLIA_ERC8179,
  );
  const confirmations = positiveInteger(process.env.CONFIRMATIONS, 1, "CONFIRMATIONS");
  const retryDelayMs = positiveInteger(
    process.env.PUBLICATION_RETRY_MS,
    15_000,
    "PUBLICATION_RETRY_MS",
  );
  const maxBlobsPerTransaction = positiveInteger(
    process.env.MAX_BLOBS_PER_TRANSACTION,
    MAX_BLOBS_PER_TRANSACTION,
    "MAX_BLOBS_PER_TRANSACTION",
  );
  if (maxBlobsPerTransaction > MAX_BLOBS_PER_TRANSACTION) {
    throw new Error(
      `MAX_BLOBS_PER_TRANSACTION cannot exceed ${MAX_BLOBS_PER_TRANSACTION}`,
    );
  }
  const maxCostWei = process.env.MAX_PUBLISH_COST_WEI
    ? BigInt(process.env.MAX_PUBLISH_COST_WEI)
    : parseEther(process.env.MAX_PUBLISH_COST_ETH?.trim() || "0.02");
  if (maxCostWei < 1n) throw new Error("Publication cost cap must be positive");

  const provider = new JsonRpcProvider(executionRpcUrl);
  const wallet = new Wallet(await privateKeyFromFile(keyFile), provider);
  const dailyBudget: DailyUsdBudget = dailyUsdBudgetFromEnvironment();
  const backend: BatchPublishBackend = {
    publish: async (blobs, sequences) => {
      if (blobs.length !== sequences.length || blobs.length < 1) {
        throw new Error("Publication batch is malformed");
      }
      const network = await provider.getNetwork();
      if (network.chainId !== expectedChainId) {
        throw new Error(`Publication RPC is chain ${network.chainId}, expected ${expectedChainId}`);
      }
      const preparedBlobs = await Promise.all(blobs.map(prepareCanonicalBlob));
      // Every send attempt receives its own persisted reservation. If an RPC
      // loses the receipt after broadcast, a retry cannot silently spend twice
      // against one budget entry.
      const reservationId = randomUUID();
      let transactionHash: string;
      let blockNumber: number;
      let versionedHashes: readonly string[];
      if (preparedBlobs.length === 1) {
        const publication = await publishCanonicalBlob({
          provider,
          signer: wallet,
          contractAddress,
          preparedBlob: preparedBlobs[0]!,
          confirmations,
          maxCostWei,
          reserveCost: async (worstCaseCostWei) => {
            await dailyBudget.reserve(reservationId, worstCaseCostWei);
          },
        });
        transactionHash = publication.transactionHash;
        blockNumber = publication.blockNumber;
        versionedHashes = [publication.versionedHash];
      } else {
        const publication = await publishCanonicalBlobs({
          provider,
          signer: wallet,
          contractAddress,
          preparedBlobs,
          confirmations,
          maxCostWei,
          reserveCost: async (worstCaseCostWei) => {
            await dailyBudget.reserve(reservationId, worstCaseCostWei);
          },
        });
        transactionHash = publication.transactionHash;
        blockNumber = publication.receipt.blockNumber;
        versionedHashes = publication.segments.map((segment) => segment.versionedHash);
      }
      try {
        await dailyBudget.commit(reservationId);
      } catch (error) {
        // The persisted reservation remains charged if reconciliation fails,
        // which is deliberately fail-safe for the daily cap.
        options.onError?.(error);
      }
      return {
        transactionHash,
        blockNumber,
        versionedHashes,
      };
    },
    close: () => provider.destroy(),
  };
  return new SubsidizedBatchPublisher({
    backend,
    batcherAddress: wallet.address,
    chainId: expectedChainId,
    contractAddress,
    maxBlobsPerTransaction,
    retryDelayMs,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
