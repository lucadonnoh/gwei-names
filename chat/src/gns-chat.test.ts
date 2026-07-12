import { Interface, Network, Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  GNS_CHAT_TEXT_KEY,
  GNS_CONTRACT_ADDRESS,
  contactBindingMessage,
  decodeGnsChatRecord,
  encodeGnsChatRecord,
  gweiTokenId,
  normalizeGweiName,
  resolveGweiContactTokenWithProvider,
  resolveGweiContactWithProvider,
  verifyContactOwnerSignature,
} from "./gns-chat";

const chainId = 11_155_111n;

describe("GNS chat contact records", () => {
  it("normalizes .gwei names and accepts a bare label as a convenience", () => {
    expect(normalizeGweiName(" Alice ")).toBe("alice.gwei");
    expect(normalizeGweiName("ALICE.GWEI")).toBe("alice.gwei");
    expect(normalizeGweiName("chat.alice.gwei")).toBe("chat.alice.gwei");
    expect(() => normalizeGweiName("alice.eth")).toThrow(/ending in .gwei/u);
    expect(() => normalizeGweiName("bad name.gwei")).toThrow(/normalization/u);
  });

  it("encodes a bounded versioned text record", () => {
    const encoded = encodeGnsChatRecord("signed-contact-code", `0x${"11".repeat(65)}`);
    expect(decodeGnsChatRecord(encoded)).toEqual({
      v: 0,
      c: "signed-contact-code",
      s: `0x${"11".repeat(65)}`,
    });
    expect(() => decodeGnsChatRecord("{}")) .toThrow(/unsupported version/u);
    expect(() => encodeGnsChatRecord("code", "not-hex")).toThrow(/malformed/u);
  });

  it("binds the contact code to this chain, NameNFT, token, and text key", () => {
    const message = contactBindingMessage({
      chainId,
      contractAddress: GNS_CONTRACT_ADDRESS,
      tokenId: gweiTokenId("alice.gwei"),
      contactCode: "contact-code",
    });
    expect(message).toContain(`Chain ID: ${chainId}`);
    expect(message).toContain(`NameNFT: ${GNS_CONTRACT_ADDRESS}`);
    expect(message).toContain(`Text record: ${GNS_CHAT_TEXT_KEY}`);
    expect(message).not.toContain("contact-code");
  });

  it("accepts an EOA owner signature and rejects it after a transfer", async () => {
    const oldOwner = Wallet.createRandom();
    const newOwner = Wallet.createRandom();
    const binding = {
      chainId,
      contractAddress: GNS_CONTRACT_ADDRESS,
      tokenId: gweiTokenId("alice.gwei"),
      contactCode: "contact-code",
    };
    const signature = await oldOwner.signMessage(contactBindingMessage(binding));
    const provider = {
      call: vi.fn(async () => "0x"),
      getCode: vi.fn(async () => "0x"),
    };

    await expect(verifyContactOwnerSignature({
      provider,
      owner: oldOwner.address,
      binding,
      signature,
      blockTag: 100,
    })).resolves.toBe(true);
    await expect(verifyContactOwnerSignature({
      provider,
      owner: newOwner.address,
      binding,
      signature,
      blockTag: 101,
    })).resolves.toBe(false);
  });

  it("supports contract owners through ERC-1271", async () => {
    const erc1271 = new Interface([
      "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
    ]);
    const provider = {
      call: vi.fn(async () =>
        erc1271.encodeFunctionResult("isValidSignature", ["0x1626ba7e"])),
      getCode: vi.fn(async () => "0x60006000"),
    };
    const valid = await verifyContactOwnerSignature({
      provider,
      owner: Wallet.createRandom().address,
      binding: {
        chainId,
        contractAddress: GNS_CONTRACT_ADDRESS,
        tokenId: 7n,
        contactCode: "contact-code",
      },
      signature: "0x1234",
      blockTag: 100,
    });
    expect(valid).toBe(true);
    expect(provider.call).toHaveBeenCalledOnce();
  });

  it("resolves at one block and invalidates a stale record when ownership changes", async () => {
    const iface = new Interface([
      "function ownerOf(uint256 tokenId) view returns (address)",
      "function text(uint256 tokenId, string key) view returns (string)",
      "function getFullName(uint256 tokenId) view returns (string)",
    ]);
    const owner = Wallet.createRandom();
    const nextOwner = Wallet.createRandom();
    const name = "alice.gwei";
    const tokenId = gweiTokenId(name);
    const contactCode = "signed-contact-code";
    const signature = await owner.signMessage(contactBindingMessage({
      chainId,
      contractAddress: GNS_CONTRACT_ADDRESS,
      tokenId,
      contactCode,
    }));
    const record = encodeGnsChatRecord(contactCode, signature);
    let currentOwner = owner.address;
    const provider = {
      getNetwork: vi.fn(async () => Network.from(chainId)),
      getBlockNumber: vi.fn(async () => 123),
      getCode: vi.fn(async () => "0x"),
      call: vi.fn(async (transaction: { data?: string | null }) => {
        const parsed = iface.parseTransaction({ data: transaction.data ?? "0x" });
        if (parsed?.name === "ownerOf") {
          return iface.encodeFunctionResult("ownerOf", [currentOwner]);
        }
        if (parsed?.name === "text") {
          return iface.encodeFunctionResult("text", [record]);
        }
        if (parsed?.name === "getFullName") {
          return iface.encodeFunctionResult("getFullName", [name]);
        }
        throw new Error("unexpected call");
      }),
    };

    await expect(resolveGweiContactWithProvider({
      provider,
      name,
      expectedChainId: chainId,
    })).resolves.toMatchObject({ name, owner: owner.address, tokenId, contactCode });
    await expect(resolveGweiContactTokenWithProvider({
      provider,
      tokenId,
      expectedChainId: chainId,
      blockNumber: 123,
    })).resolves.toMatchObject({ name, owner: owner.address, tokenId, contactCode });

    currentOwner = nextOwner.address;
    await expect(resolveGweiContactWithProvider({
      provider,
      name,
      expectedChainId: chainId,
    })).rejects.toThrow(/current name owner/u);
  });
});
