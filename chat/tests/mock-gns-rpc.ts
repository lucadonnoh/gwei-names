import { createServer } from "node:http";

import {
  Interface,
  Wallet,
  getBytes,
  namehash,
} from "ethers";

const port = 8_546;
const host = "127.0.0.1";
const chainId = 11_155_111n;
const gnsAddress = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
const latestBlock = 123;
const chatRecordBlock = 100;
const wallet = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const nameInterface = new Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function resolve(uint256 tokenId) view returns (address)",
  "function records(uint256 tokenId) view returns (string label, uint256 parent, uint64 expiresAt, uint64 epoch, uint64 parentEpoch)",
  "function text(uint256 tokenId, string key) view returns (string)",
  "function getFullName(uint256 tokenId) view returns (string)",
  "event TextChanged(bytes32 indexed node, string indexed key, string value)",
]);
interface MockChatRecord {
  name: string;
  value: string;
  discover: boolean;
}

const chatRecords = new Map<string, MockChatRecord>();

function recordKey(tokenId: bigint): string {
  return tokenId.toString(16);
}

function blockNumber(value: unknown): number {
  if (value === "latest") return latestBlock;
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) return 0;
  return Number(BigInt(value));
}

function chatLogs(filter: unknown): Record<string, unknown>[] {
  if (!filter || typeof filter !== "object") return [];
  const request = filter as { fromBlock?: unknown; toBlock?: unknown };
  if (
    blockNumber(request.fromBlock) > chatRecordBlock ||
    blockNumber(request.toBlock) < chatRecordBlock
  ) {
    return [];
  }
  return Array.from(chatRecords.values())
    .filter((record) => record.discover)
    .map((record, index) => {
      const encoded = nameInterface.encodeEventLog(
        nameInterface.getEvent("TextChanged")!,
        [namehash(record.name), "domains.gwei.chat", record.value],
      );
      return {
        address: gnsAddress,
        blockHash: `0x${"11".repeat(32)}`,
        blockNumber: `0x${chatRecordBlock.toString(16)}`,
        data: encoded.data,
        logIndex: `0x${index.toString(16)}`,
        removed: false,
        topics: encoded.topics,
        transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        transactionIndex: "0x0",
      };
    });
}

function headers(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json",
  };
}

async function body(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function rpcResult(request: unknown): Record<string, unknown> {
  const value = request as { id?: unknown; method?: unknown; params?: unknown[] };
  const response = { jsonrpc: "2.0", id: value.id ?? null };
  if (value.method === "eth_chainId") return { ...response, result: `0x${chainId.toString(16)}` };
  if (value.method === "eth_blockNumber") {
    return { ...response, result: `0x${latestBlock.toString(16)}` };
  }
  if (value.method === "eth_getCode") return { ...response, result: "0x" };
  if (value.method === "eth_getLogs") {
    return { ...response, result: chatLogs(value.params?.[0]) };
  }
  if (value.method === "eth_call") {
    const transaction = value.params?.[0] as { data?: unknown } | undefined;
    const data = typeof transaction?.data === "string" ? transaction.data : "0x";
    const parsed = nameInterface.parseTransaction({ data });
    const tokenId = parsed?.args[0] === undefined ? null : BigInt(parsed.args[0]);
    const record = tokenId === null ? undefined : chatRecords.get(recordKey(tokenId));
    if (parsed?.name === "ownerOf") {
      return { ...response, result: nameInterface.encodeFunctionResult("ownerOf", [wallet.address]) };
    }
    if (parsed?.name === "resolve") {
      return { ...response, result: nameInterface.encodeFunctionResult("resolve", [wallet.address]) };
    }
    if (parsed?.name === "records") {
      return {
        ...response,
        result: nameInterface.encodeFunctionResult("records", [
          record?.name.split(".")[0] || "unknown",
          0n,
          4_102_444_800n,
          1n,
          0n,
        ]),
      };
    }
    if (parsed?.name === "text") {
      return {
        ...response,
        result: nameInterface.encodeFunctionResult("text", [record?.value || ""]),
      };
    }
    if (parsed?.name === "getFullName") {
      return {
        ...response,
        result: nameInterface.encodeFunctionResult("getFullName", [record?.name || "unknown.gwei"]),
      };
    }
  }
  return {
    ...response,
    error: { code: -32_601, message: `unsupported method ${String(value.method)}` },
  };
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers());
    response.end();
    return;
  }
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, headers());
      response.end(JSON.stringify({ ok: true, address: wallet.address }));
      return;
    }
    const value = await body(request);
    if (request.method === "POST" && url.pathname === "/sign") {
      const data = (value as { data?: unknown }).data;
      if (typeof data !== "string" || !/^0x[0-9a-f]*$/iu.test(data)) {
        throw new Error("signing input is malformed");
      }
      response.writeHead(200, headers());
      response.end(JSON.stringify({ signature: await wallet.signMessage(getBytes(data)) }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/record") {
      const valueRecord = (value as { value?: unknown }).value;
      const name = (value as { name?: unknown }).name ?? "alice.gwei";
      const discover = (value as { discover?: unknown }).discover !== false;
      if (typeof valueRecord !== "string" || valueRecord.length > 2_048) {
        throw new Error("chat record is malformed");
      }
      if (typeof name !== "string" || !name.endsWith(".gwei")) {
        throw new Error("chat name is malformed");
      }
      chatRecords.set(recordKey(BigInt(namehash(name))), { name, value: valueRecord, discover });
      response.writeHead(200, headers());
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/records/reset") {
      chatRecords.clear();
      response.writeHead(200, headers());
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const result = Array.isArray(value) ? value.map(rpcResult) : rpcResult(value);
    response.writeHead(200, headers());
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, headers());
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "bad request" }));
  }
});

server.listen(port, host, () => {
  console.log(`mock GNS RPC listening on http://${host}:${port} for ${wallet.address}`);
});

function close(): void {
  server.close();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
