import { BrowserProvider } from "ethers";
import type { Eip1193Provider } from "ethers";
import { SiweMessage } from "@signinwithethereum/siwe";
import {
  AuthorizationHeader,
  Client,
  Token,
  TokenChallenge,
  TokenResponse,
  VOPRF,
} from "./privacy-pass";
import type { TokenChallenge as TokenChallengeType } from "./privacy-pass";

import { fromBase64Url, toBase64Url } from "../encoding";
import { normalizeGweiName } from "../gns-chat";
import { mutateState, readState } from "../storage";
import type { PrivateState, RelayPassState } from "../storage";
import {
  RelayHolderNameRequiredError,
  parseRelayAdmissionConfig,
  parseRelayAdmissionIssueResponse,
  parseRelayAdmissionNonce,
} from "./protocol";
import type {
  ProtectedRelayAdmissionConfig,
  RelayAdmissionConfig,
  RelayAdmissionIssueRequest,
} from "./protocol";

const CONFIG_CACHE_MS = 30_000;
const TOKEN_LENGTH = 2 + 32 + 32 + VOPRF.Nid + VOPRF.Nk;

interface CachedConfig {
  value: RelayAdmissionConfig;
  expiresAt: number;
}

interface PreparedPass {
  authorization: string;
  serialized: string;
}

export interface RelayPassActivation {
  required: boolean;
  passes: number;
  utcDate?: string;
}

const configCache = new Map<string, CachedConfig>();

function relayKey(base: string): string {
  return new URL(base || "/", location.href).toString().replace(/\/+$/u, "");
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/u, "")}${path}`;
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function configFingerprint(config: ProtectedRelayAdmissionConfig): string {
  return [
    config.protocol,
    config.chainId,
    config.nameContract.toLowerCase(),
    config.issuerName,
    config.issuerPublicKey,
    config.challenge,
    config.utcDate,
  ].join("|");
}

function freshPassState(name: string | null, config: ProtectedRelayAdmissionConfig): RelayPassState {
  return {
    name,
    utcDate: config.utcDate,
    fingerprint: configFingerprint(config),
    session: null,
    tokens: [],
  };
}

function stateForConfig(
  state: PrivateState,
  key: string,
  config: ProtectedRelayAdmissionConfig,
): RelayPassState {
  const current = state.relayPasses[key];
  const fingerprint = configFingerprint(config);
  if (!current || current.fingerprint !== fingerprint || current.utcDate !== config.utcDate) {
    const next = freshPassState(current?.name ?? null, config);
    state.relayPasses[key] = next;
    return next;
  }
  return current;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const value = await response.json() as unknown;
    const message = (value as { error?: unknown })?.error;
    if (typeof message === "string" && message) return new Error(message);
  } catch {
    // Fall through to the stable status error.
  }
  return new Error(`${fallback} (${response.status})`);
}

async function fetchConfig(base: string, force = false): Promise<RelayAdmissionConfig> {
  const key = relayKey(base);
  const cached = configCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(endpoint(base, "/admission/config"), { cache: "no-store" });
  if (response.status === 404) {
    const open: RelayAdmissionConfig = { required: false };
    configCache.set(key, { value: open, expiresAt: Date.now() + CONFIG_CACHE_MS });
    return open;
  }
  if (!response.ok) throw await responseError(response, "Could not read relay admission config");
  const config = parseRelayAdmissionConfig(await response.json() as unknown);
  if (config.required) validateCryptographicConfig(config);
  configCache.set(key, { value: config, expiresAt: Date.now() + CONFIG_CACHE_MS });
  return config;
}

function validateCryptographicConfig(config: ProtectedRelayAdmissionConfig): void {
  const publicKey = fromBase64Url(config.issuerPublicKey);
  if (publicKey.length !== VOPRF.Ne) throw new Error("Relay issuer key has the wrong length");
  const serialized = fromBase64Url(config.challenge);
  let challenge: TokenChallengeType;
  try {
    challenge = TokenChallenge.deserialize(serialized);
  } catch {
    throw new Error("Relay token challenge is malformed");
  }
  if (
    challenge.tokenType !== VOPRF.value ||
    challenge.issuerName !== config.issuerName ||
    toBase64Url(challenge.serialize()) !== config.challenge
  ) {
    throw new Error("Relay token challenge does not match its config");
  }
}

async function passCount(base: string, config: ProtectedRelayAdmissionConfig): Promise<number> {
  const key = relayKey(base);
  return mutateState((state) => stateForConfig(state, key, config).tokens.length);
}

async function takePass(
  base: string,
  config: ProtectedRelayAdmissionConfig,
): Promise<PreparedPass | null> {
  const key = relayKey(base);
  const serialized = await mutateState((state) => stateForConfig(state, key, config).tokens.pop());
  if (!serialized) return null;
  const bytes = fromBase64Url(serialized);
  if (bytes.length !== TOKEN_LENGTH) return null;
  try {
    const token = Token.deserialize(VOPRF, bytes);
    return {
      serialized,
      authorization: new AuthorizationHeader(token).toString(),
    };
  } catch {
    return null;
  }
}

async function restorePass(
  base: string,
  config: ProtectedRelayAdmissionConfig,
  serialized: string,
): Promise<void> {
  const key = relayKey(base);
  await mutateState((state) => {
    const admission = stateForConfig(state, key, config);
    if (!admission.tokens.includes(serialized)) admission.tokens.push(serialized);
  });
}

function injectedWallet(): Eip1193Provider | undefined {
  return (window as Window & { ethereum?: Eip1193Provider }).ethereum;
}

async function newAuthorization(
  base: string,
  config: ProtectedRelayAdmissionConfig,
  name: string,
  ethereum: Eip1193Provider,
): Promise<NonNullable<RelayAdmissionIssueRequest["auth"]>> {
  const nonceResponse = await fetch(endpoint(base, "/admission/nonce"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!nonceResponse.ok) throw await responseError(nonceResponse, "Could not start relay access");
  const nonce = parseRelayAdmissionNonce(await nonceResponse.json() as unknown);
  if (BigInt(nonce.chainId) !== BigInt(config.chainId)) {
    throw new Error("Relay SIWE chain does not match its token config");
  }
  const provider = new BrowserProvider(ethereum);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(`Switch your wallet to chain ${config.chainId}`);
  }
  const message = new SiweMessage({
    domain: nonce.domain,
    address: await signer.getAddress(),
    statement: nonce.statement,
    uri: nonce.uri,
    version: "1",
    chainId: nonce.chainId,
    nonce: nonce.nonce,
    issuedAt: nonce.issuedAt,
    expirationTime: nonce.expirationTime,
  }).prepareMessage();
  return {
    name,
    message,
    signature: await signer.signMessage(message),
    nonceToken: nonce.nonceToken,
  };
}

async function refill(
  base: string,
  config: ProtectedRelayAdmissionConfig,
  ethereumOverride?: Eip1193Provider,
  allowSessionRetry = true,
): Promise<number> {
  const key = relayKey(base);
  const stored = await mutateState((state) => ({ ...stateForConfig(state, key, config) }));
  if (!stored.name) throw new RelayHolderNameRequiredError();

  const publicKey = fromBase64Url(config.issuerPublicKey);
  const challenge = TokenChallenge.deserialize(fromBase64Url(config.challenge));
  const clients = Array.from({ length: config.issueBatchSize }, () => new Client());
  const requests: string[] = [];
  for (const client of clients) {
    requests.push(toBase64Url((await client.createTokenRequest(challenge, publicKey)).serialize()));
  }

  let payload: RelayAdmissionIssueRequest;
  if (stored.session) {
    payload = { utcDate: config.utcDate, requests, session: stored.session };
  } else {
    const ethereum = ethereumOverride ?? injectedWallet();
    if (!ethereum) throw new Error("No browser wallet was found");
    payload = {
      utcDate: config.utcDate,
      requests,
      auth: await newAuthorization(base, config, stored.name, ethereum),
    };
  }
  const response = await fetch(endpoint(base, "/admission/issue"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 401 && stored.session && allowSessionRetry) {
    await mutateState((state) => {
      stateForConfig(state, key, config).session = null;
    });
    return refill(base, config, ethereumOverride, false);
  }
  if (!response.ok) throw await responseError(response, "Relay pass issuance failed");
  const issued = parseRelayAdmissionIssueResponse(await response.json() as unknown);
  if (issued.responses.length !== clients.length) {
    throw new Error("Relay returned the wrong number of token responses");
  }

  const tokens: string[] = [];
  for (let index = 0; index < clients.length; index += 1) {
    const tokenResponse = TokenResponse.deserialize(fromBase64Url(issued.responses[index]!));
    const token = await clients[index]!.finalize(tokenResponse);
    const serialized = token.serialize();
    if (serialized.length !== TOKEN_LENGTH) throw new Error("Relay issued a malformed pass");
    tokens.push(toBase64Url(serialized));
  }
  await mutateState((state) => {
    const admission = stateForConfig(state, key, config);
    admission.session = issued.session;
    admission.tokens.push(...tokens);
  });
  return tokens.length;
}

export async function setRelayHolderName(base: string, value: string): Promise<string> {
  const name = normalizeGweiName(value);
  if (name.split(".").length !== 2) {
    throw new Error("Relay access requires a top-level .gwei name");
  }
  const key = relayKey(base);
  await mutateState((state) => {
    const existing = state.relayPasses[key];
    if (existing) {
      if (existing.name !== name) {
        existing.name = name;
        existing.session = null;
        existing.tokens = [];
      }
    } else {
      state.relayPasses[key] = {
        name,
        utcDate: "",
        fingerprint: "",
        session: null,
        tokens: [],
      };
    }
  });
  return name;
}

export async function getRelayHolderName(base: string): Promise<string | null> {
  const state = await readState();
  return state.relayPasses[relayKey(base)]?.name ?? null;
}

export async function activateRelayPasses(
  base: string,
  name: string,
  ethereum?: Eip1193Provider,
): Promise<RelayPassActivation> {
  await setRelayHolderName(base, name);
  const config = await fetchConfig(base, true);
  if (!config.required) return { required: false, passes: 0 };
  if ((await passCount(base, config)) === 0) await refill(base, config, ethereum);
  return { required: true, passes: await passCount(base, config), utcDate: config.utcDate };
}

export async function submitWithRelayAdmission(
  base: string,
  body: Uint8Array,
): Promise<Response> {
  let config = await fetchConfig(base);
  if (!config.required) {
    return fetch(endpoint(base, "/submit"), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: requestBody(body),
    });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let pass = await takePass(base, config);
    if (!pass) {
      await refill(base, config);
      pass = await takePass(base, config);
    }
    if (!pass) throw new Error("The relay did not issue a usable pass");
    let response: Response;
    try {
      response = await fetch(endpoint(base, "/submit"), {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          authorization: pass.authorization,
        },
        body: requestBody(body),
      });
    } catch (error) {
      // The request may have reached the relay, so this one-time pass cannot be reused safely.
      throw error;
    }
    if (response.status === 503) {
      await restorePass(base, config, pass.serialized);
      return response;
    }
    if (response.status !== 401) return response;
    config = await fetchConfig(base, true);
    if (!config.required) return response;
  }
  return new Response(JSON.stringify({ error: "Relay pass was rejected" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
