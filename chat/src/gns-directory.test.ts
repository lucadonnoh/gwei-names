import {
  Network,
  toBeHex,
} from "ethers";
import type { Filter, Log, TransactionRequest } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  GNS_CHAT_KEY_TOPIC,
  GNS_TEXT_CHANGED_TOPIC,
  indexGweiChatCandidatesWithProvider,
  knownGnsDeploymentBlock,
} from "./gns-directory";
import type { GnsDirectoryProvider } from "./gns-directory";

function logFor(tokenId: bigint): Log {
  return {
    topics: [GNS_TEXT_CHANGED_TOPIC, toBeHex(tokenId, 32), GNS_CHAT_KEY_TOPIC],
  } as unknown as Log;
}

function indexProvider(options: {
  latestBlock: number;
  logs: (filter: Filter) => Log[];
}): GnsDirectoryProvider {
  return {
    call: async (_transaction: TransactionRequest) => "0x",
    getBlockNumber: async () => options.latestBlock,
    getCode: async () => "0x",
    getNetwork: async () => Network.from(11_155_111n),
    getLogs: vi.fn(async (filter: Filter) => options.logs(filter)),
  };
}

describe("GNS chat directory", () => {
  it("uses the exact indexed text key and checkpoints bounded log ranges", async () => {
    const tokenId = 123n;
    const requested: Filter[] = [];
    const checkpoints: number[] = [];
    const provider = indexProvider({
      latestBlock: 112,
      logs: (filter) => {
        requested.push(filter);
        return filter.fromBlock === 100 ? [logFor(tokenId)] : [];
      },
    });

    const result = await indexGweiChatCandidatesWithProvider({
      provider,
      fromBlock: 100,
      logRange: 5,
      onCheckpoint: (state) => checkpoints.push(state.scannedThrough),
    });

    expect(result).toEqual({ latestBlock: 112, scannedThrough: 112, tokenIds: [tokenId] });
    expect(requested.map(({ fromBlock, toBlock }) => [fromBlock, toBlock])).toEqual([
      [100, 104],
      [105, 109],
      [110, 112],
    ]);
    expect(requested[0]?.topics).toEqual([
      GNS_TEXT_CHANGED_TOPIC,
      null,
      GNS_CHAT_KEY_TOPIC,
    ]);
    expect(checkpoints).toEqual([104, 109, 112]);
  });

  it("resumes from a short reorg lookback and preserves earlier candidates", async () => {
    const requested: Filter[] = [];
    const provider = indexProvider({
      latestBlock: 1_100,
      logs: (filter) => {
        requested.push(filter);
        return Number(filter.fromBlock) <= 1_050 && Number(filter.toBlock) >= 1_050
          ? [logFor(2n)]
          : [];
      },
    });
    const result = await indexGweiChatCandidatesWithProvider({
      provider,
      fromBlock: 100,
      logRange: 100,
      cached: {
        v: 0,
        fromBlock: 100,
        scannedThrough: 1_000,
        tokenIds: ["1"],
      },
    });

    expect(requested[0]?.fromBlock).toBe(937);
    expect(result.tokenIds).toEqual([1n, 2n]);
    expect(result.scannedThrough).toBe(1_100);
  });

  it("retries an RPC range limit with smaller chunks", async () => {
    const successfulRanges: number[] = [];
    const provider = indexProvider({
      latestBlock: 300,
      logs: (filter) => {
        const width = Number(filter.toBlock) - Number(filter.fromBlock) + 1;
        if (width > 100) throw new Error("ranges over 100 blocks are not supported");
        successfulRanges.push(width);
        return [];
      },
    });

    await expect(indexGweiChatCandidatesWithProvider({
      provider,
      fromBlock: 0,
      logRange: 1_000,
    })).resolves.toMatchObject({ latestBlock: 300, scannedThrough: 300 });
    expect(successfulRanges.length).toBeGreaterThan(1);
    expect(Math.max(...successfulRanges)).toBeLessThanOrEqual(100);
  });

  it("knows the immutable deployment range only for the canonical NameNFT", () => {
    expect(knownGnsDeploymentBlock(1n)).toBe(25_403_689);
    expect(knownGnsDeploymentBlock(11_155_111n)).toBe(11_142_856);
    expect(
      knownGnsDeploymentBlock(11_155_111n, "0x0000000000000000000000000000000000000001"),
    ).toBeUndefined();
  });
});
