import { describe, expect, it } from "vitest";
import type { Filter, JsonRpcProvider, Log } from "ethers";

import { CONTENT_TAG, FIELD_ELEMENTS_PER_BLOB } from "../blob-batch";
import {
  discoverBlobSegments,
  erc8179DiscoveryTopics,
  erc8179Interface,
} from "./erc8179";
import { blobEventSequence } from "./source";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const BATCHER_A = "0x2222222222222222222222222222222222222222";
const BATCHER_B = "0x3333333333333333333333333333333333333333";

function declarationLog(options: {
  batcher: string;
  blockNumber: number;
  index: number;
  marker: string;
}): Log {
  const event = erc8179Interface.getEvent("BlobSegmentDeclared");
  if (!event) throw new Error("BlobSegmentDeclared ABI is missing");
  const versionedHash = `0x01${options.marker.repeat(31)}`;
  const encoded = erc8179Interface.encodeEventLog(event, [
    versionedHash,
    options.batcher,
    0,
    FIELD_ELEMENTS_PER_BLOB,
    CONTENT_TAG,
  ]);
  return {
    address: CONTRACT,
    blockHash: `0x${"44".repeat(32)}`,
    blockNumber: options.blockNumber,
    data: encoded.data,
    index: options.index,
    removed: false,
    topics: encoded.topics,
    transactionHash: `0x${options.marker.repeat(32)}`,
    transactionIndex: 0,
  } as unknown as Log;
}

describe("permissionless onchain discovery", () => {
  it("does not filter the ERC-8179 declarer topic", () => {
    const topics = erc8179DiscoveryTopics();
    expect(topics).toHaveLength(4);
    expect(topics[1]).toBeNull();
    expect(topics[2]).toBeNull();
    expect(topics[3]).toBe(CONTENT_TAG);
  });

  it("returns declarations from independent batchers", async () => {
    let requestedFilter: Filter | undefined;
    const logs = [
      declarationLog({ batcher: BATCHER_A, blockNumber: 10, index: 0, marker: "55" }),
      declarationLog({ batcher: BATCHER_B, blockNumber: 11, index: 1, marker: "66" }),
    ];
    const provider = {
      getLogs: async (filter: Filter) => {
        requestedFilter = filter;
        return logs;
      },
    } as unknown as JsonRpcProvider;

    const discovered = await discoverBlobSegments(provider, {
      contractAddress: CONTRACT,
      fromBlock: 10,
      toBlock: 11,
    });

    expect(requestedFilter?.topics?.[2]).toBeNull();
    expect(discovered.map((segment) => segment.declarer)).toEqual([BATCHER_A, BATCHER_B]);
  });

  it("orders every batcher event by block and log index", () => {
    expect(blobEventSequence(10, 2)).toBeLessThan(blobEventSequence(10, 3));
    expect(blobEventSequence(10, 999_999)).toBeLessThan(blobEventSequence(11, 0));
  });
});
