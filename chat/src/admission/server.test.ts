import { Wallet } from "ethers";
import { SiweMessage, createEthersConfig } from "@signinwithethereum/siwe";
import {
  AuthorizationHeader,
  Client,
  TokenChallenge,
  TokenResponse,
  VOPRF,
  keyGen,
} from "./privacy-pass";
import type { Client as PrivacyPassClient, TokenChallenge as TokenChallengeType } from "./privacy-pass";
import { describe, expect, it } from "vitest";

import { GNS_CONTRACT_ADDRESS, gweiTokenId } from "../gns-chat";
import {
  RelayAdmission,
} from "./server";
import type {
  GweiHolderVerifier,
} from "./server";
import {
  AdmissionQuotaError,
  SqliteAdmissionStore,
} from "./store";

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function tokenRequests(challenge: TokenChallengeType, publicKey: Uint8Array, count: number): Promise<{
  clients: PrivacyPassClient[];
  requests: string[];
}> {
  const clients = Array.from({ length: count }, () => new Client());
  const requests: string[] = [];
  for (const client of clients) {
    requests.push(Buffer.from(
      (await client.createTokenRequest(challenge, publicKey)).serialize(),
    ).toString("base64url"));
  }
  return { clients, requests };
}

describe("holder-gated anonymous relay passes", () => {
  it("issues RFC 9578 VOPRF passes after SIWE and spends each exactly once", async () => {
    let now = Date.UTC(2026, 6, 11, 12);
    const wallet = Wallet.createRandom();
    const store = new SqliteAdmissionStore(":memory:");
    const keyPair = await store.loadOrCreateKeyPair(keyGen);
    const holderVerifier: GweiHolderVerifier = {
      verify: async (name, address) => {
        if (name !== "alice.gwei" || address !== wallet.address) {
          throw new Error("not holder");
        }
        return { name, tokenId: gweiTokenId(name) };
      },
    };
    const admission = new RelayAdmission({
      store,
      keyPair,
      holderVerifier,
      siweConfig: await createEthersConfig(),
      chainId: 11_155_111n,
      nameContract: GNS_CONTRACT_ADDRESS,
      issuerName: "gwei.test",
      originInfo: "gwei.test",
      domain: "gwei.test",
      uri: "https://gwei.test/",
      quotaPerName: 3,
      issueBatchSize: 2,
      now: () => now,
    });

    const config = admission.config();
    expect(config).toMatchObject({
      required: true,
      utcDate: "2026-07-11",
      quotaPerName: 3,
      issueBatchSize: 2,
    });
    const challenge = TokenChallenge.deserialize(decode(config.challenge));
    expect(challenge.tokenType).toBe(VOPRF.value);
    const first = await tokenRequests(challenge, keyPair.publicKey, 2);
    const nonce = admission.nonce();
    const siwe = new SiweMessage({
      domain: nonce.domain,
      address: wallet.address,
      statement: nonce.statement,
      uri: nonce.uri,
      version: "1",
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: nonce.issuedAt,
      expirationTime: nonce.expirationTime,
    });
    const message = siwe.prepareMessage();
    const issued = await admission.issue({
      utcDate: config.utcDate,
      requests: first.requests,
      auth: {
        name: "alice.gwei",
        message,
        signature: await wallet.signMessage(message),
        nonceToken: nonce.nonceToken,
      },
    });
    expect(issued.responses).toHaveLength(2);
    expect(issued.remaining).toBe(1);

    const tokens = await Promise.all(issued.responses.map((response, index) =>
      first.clients[index]!.finalize(TokenResponse.deserialize(decode(response)))));
    const authorization = new AuthorizationHeader(tokens[0]!).toString();
    await expect(admission.redeem(authorization)).resolves.toBeUndefined();
    await expect(admission.redeem(authorization)).rejects.toThrow(/already spent/u);
    await expect(admission.redeem(
      new AuthorizationHeader(tokens[1]!).toString(),
    )).resolves.toBeUndefined();
    expect(admission.status()).toMatchObject({ issued: 2, spent: 2 });

    const refill = await tokenRequests(challenge, keyPair.publicKey, 1);
    const refilled = await admission.issue({
      utcDate: config.utcDate,
      requests: refill.requests,
      session: issued.session,
    });
    expect(refilled.remaining).toBe(0);
    await expect(admission.issue({
      utcDate: config.utcDate,
      requests: refill.requests,
      session: issued.session,
    })).rejects.toBeInstanceOf(AdmissionQuotaError);

    const lastToken = await refill.clients[0]!.finalize(
      TokenResponse.deserialize(decode(refilled.responses[0]!)),
    );
    now = Date.UTC(2026, 6, 12, 0, 1);
    await expect(admission.issue({
      utcDate: config.utcDate,
      requests: refill.requests,
      session: refilled.session,
    })).rejects.toMatchObject({ status: 409 });
    await expect(admission.redeem(
      new AuthorizationHeader(lastToken).toString(),
    )).rejects.toThrow(/invalid or expired/u);
    admission.close();
  });

  it("rejects a reused SIWE nonce even with a fresh blind request", async () => {
    const now = Date.UTC(2026, 6, 11, 12);
    const wallet = Wallet.createRandom();
    const store = new SqliteAdmissionStore(":memory:");
    const keyPair = await store.loadOrCreateKeyPair(keyGen);
    const admission = new RelayAdmission({
      store,
      keyPair,
      holderVerifier: {
        verify: async (name) => ({ name, tokenId: gweiTokenId(name) }),
      },
      siweConfig: await createEthersConfig(),
      chainId: 11_155_111n,
      nameContract: GNS_CONTRACT_ADDRESS,
      issuerName: "gwei.test",
      originInfo: "gwei.test",
      domain: "gwei.test",
      uri: "https://gwei.test/",
      quotaPerName: 4,
      issueBatchSize: 1,
      now: () => now,
    });
    const challenge = TokenChallenge.deserialize(decode(admission.config().challenge));
    const nonce = admission.nonce();
    const message = new SiweMessage({
      domain: nonce.domain,
      address: wallet.address,
      statement: nonce.statement,
      uri: nonce.uri,
      version: "1",
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: nonce.issuedAt,
      expirationTime: nonce.expirationTime,
    }).prepareMessage();
    const signature = await wallet.signMessage(message);
    const auth = { name: "alice.gwei", message, signature, nonceToken: nonce.nonceToken };
    const first = await tokenRequests(challenge, keyPair.publicKey, 1);
    await admission.issue({
      utcDate: admission.config().utcDate,
      requests: first.requests,
      auth,
    });
    const second = await tokenRequests(challenge, keyPair.publicKey, 1);
    await expect(admission.issue({
      utcDate: admission.config().utcDate,
      requests: second.requests,
      auth,
    })).rejects.toThrow(
      /already used/u,
    );
    admission.close();
  });
});
