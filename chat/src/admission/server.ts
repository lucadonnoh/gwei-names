import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  getAddress,
} from "ethers";
import type { BlockTag, TransactionRequest } from "ethers";
import {
  SiweMessage,
  createEthersConfig,
} from "@signinwithethereum/siwe";
import type { SiweConfig } from "@signinwithethereum/siwe";
import {
  AuthorizationHeader,
  Issuer,
  Origin,
  Token,
  TokenRequest,
  VOPRF,
  keyGen,
} from "./privacy-pass";
import type { Token as PrivacyPassToken, TokenChallenge } from "./privacy-pass";

import {
  GNS_CONTRACT_ADDRESS,
  gweiTokenId,
  normalizeGweiName,
} from "../gns-chat";
import {
  RELAY_ADMISSION_PROTOCOL,
} from "./protocol";
import type {
  ProtectedRelayAdmissionConfig,
  RelayAdmissionIssueResponse,
  RelayAdmissionNonce,
} from "./protocol";
import {
  AdmissionQuotaError,
  SqliteAdmissionStore,
} from "./store";
import type {
  AdmissionIssuerKeyPair,
  AdmissionStore,
} from "./store";

const SEPOLIA_CHAIN_ID = 11_155_111n;
const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SUBDOMAIN_REGISTRAR_ADDRESS = "0xc1D5245bfd98dDB7E73B33209B346b4FC0E03f3c";
const SIWE_STATEMENT =
  "Prove ownership of a top-level .gwei name and receive unlinkable one-time relay passes.";
const NONCE_LIFETIME_MS = 5 * 60_000;
const TOKEN_REQUEST_LENGTH = 3 + VOPRF.Ne;

const nameInterface = new Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function resolve(uint256 tokenId) view returns (address)",
  "function records(uint256 tokenId) view returns (string label, uint256 parent, uint64 expiresAt, uint64 epoch, uint64 parentEpoch)",
]);

const registrarInterface = new Interface([
  "function escrowedController(uint256 tokenId) view returns (address)",
]);

export interface VerifiedGweiHolder {
  name: string;
  tokenId: bigint;
}

export interface GweiHolderVerifier {
  verify(name: string, address: string): Promise<VerifiedGweiHolder>;
  close?(): void;
}

export interface RelayAdmissionOptions {
  store: AdmissionStore;
  keyPair: AdmissionIssuerKeyPair;
  holderVerifier: GweiHolderVerifier;
  siweConfig: SiweConfig;
  chainId: bigint;
  nameContract: string;
  issuerName: string;
  originInfo: string;
  domain: string;
  uri: string;
  quotaPerName: number;
  issueBatchSize: number;
  now?: () => number;
}

export interface RelayAdmissionStatus {
  required: true;
  protocol: typeof RELAY_ADMISSION_PROTOCOL;
  utcDate: string;
  quotaPerName: number;
  issueBatchSize: number;
  issued: number;
  spent: number;
}

interface SignedPayload {
  v: 0;
  purpose: "nonce" | "session";
  exp: number;
  nonce?: string;
  utcDate?: string;
  name?: string;
  tokenId?: string;
  address?: string;
}

interface AuthenticatedGweiHolder extends VerifiedGweiHolder {
  address: string;
}

interface IssuePayload {
  utcDate: string;
  requests: string[];
  session?: string;
  auth?: {
    name: string;
    message: string;
    signature: string;
    nonceToken: string;
  };
}

export class RelayAdmissionError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "RelayAdmissionError";
    this.status = status;
  }
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextUtcDay(timestamp: number): number {
  const current = new Date(timestamp);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string, label: string, maximum = 8_192): Uint8Array {
  if (!value || value.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new RelayAdmissionError(`${label} is malformed`, 400);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new RelayAdmissionError(`${label} is malformed`, 400);
  }
  return new Uint8Array(bytes);
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodedResult(
  contractInterface: Interface,
  functionName: string,
  value: string,
  index = 0,
): unknown {
  return contractInterface.decodeFunctionResult(functionName, value)[index];
}

function callAt(to: string, data: string, blockTag: BlockTag): TransactionRequest {
  return { to, data, blockTag };
}

function addressResult(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} returned malformed data`);
  return getAddress(value);
}

export class OnchainGweiHolderVerifier implements GweiHolderVerifier {
  readonly #provider: JsonRpcProvider;
  readonly #chainId: bigint;
  readonly #nameContract: string;
  readonly #registrar: string;

  constructor(options: {
    provider: JsonRpcProvider;
    chainId: bigint;
    nameContract: string;
    registrar: string;
  }) {
    this.#provider = options.provider;
    this.#chainId = options.chainId;
    this.#nameContract = getAddress(options.nameContract);
    this.#registrar = getAddress(options.registrar);
  }

  async verify(rawName: string, rawAddress: string): Promise<VerifiedGweiHolder> {
    const name = normalizeGweiName(rawName);
    if (name.split(".").length !== 2) {
      throw new RelayAdmissionError("Relay passes require a top-level .gwei name", 403);
    }
    const address = getAddress(rawAddress);
    const network = await this.#provider.getNetwork();
    if (network.chainId !== this.#chainId) {
      throw new Error(`Admission RPC is on chain ${network.chainId}; expected ${this.#chainId}`);
    }
    const tokenId = gweiTokenId(name);
    const blockNumber = await this.#provider.getBlockNumber();
    let ownerResult: string;
    let resolvedResult: string;
    let recordResult: string;
    try {
      [ownerResult, resolvedResult, recordResult] = await Promise.all([
        this.#provider.call(callAt(
          this.#nameContract,
          nameInterface.encodeFunctionData("ownerOf", [tokenId]),
          blockNumber,
        )),
        this.#provider.call(callAt(
          this.#nameContract,
          nameInterface.encodeFunctionData("resolve", [tokenId]),
          blockNumber,
        )),
        this.#provider.call(callAt(
          this.#nameContract,
          nameInterface.encodeFunctionData("records", [tokenId]),
          blockNumber,
        )),
      ]);
    } catch {
      throw new RelayAdmissionError(`${name} is not an active top-level name`, 403);
    }
    const owner = addressResult(
      decodedResult(nameInterface, "ownerOf", ownerResult),
      "GNS ownerOf",
    );
    const resolved = addressResult(
      decodedResult(nameInterface, "resolve", resolvedResult),
      "GNS resolve",
    );
    const parent = decodedResult(nameInterface, "records", recordResult, 1);
    if (resolved === ZeroAddress || typeof parent !== "bigint" || parent !== 0n) {
      throw new RelayAdmissionError(`${name} is not an active top-level name`, 403);
    }

    let controller = owner;
    if (owner === this.#registrar) {
      const result = await this.#provider.call(callAt(
        this.#registrar,
        registrarInterface.encodeFunctionData("escrowedController", [tokenId]),
        blockNumber,
      ));
      controller = addressResult(
        decodedResult(registrarInterface, "escrowedController", result),
        "Registrar controller",
      );
    }
    if (controller !== address) {
      throw new RelayAdmissionError(`The signed wallet does not control ${name}`, 403);
    }
    return { name, tokenId };
  }

  close(): void {
    this.#provider.destroy();
  }
}

export class RelayAdmission {
  readonly #store: AdmissionStore;
  readonly #keyPair: AdmissionIssuerKeyPair;
  readonly #issuer: Issuer;
  readonly #holderVerifier: GweiHolderVerifier;
  readonly #siweConfig: SiweConfig;
  readonly #chainId: bigint;
  readonly #nameContract: string;
  readonly #issuerName: string;
  readonly #originInfo: string;
  readonly #domain: string;
  readonly #uri: string;
  readonly #quotaPerName: number;
  readonly #issueBatchSize: number;
  readonly #now: () => number;
  readonly #tokenKeyIdPromise: Promise<Uint8Array>;
  readonly #signedTokenKey: Uint8Array;

  constructor(options: RelayAdmissionOptions) {
    if (options.chainId < 1n || options.chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Admission chain ID is unsupported by SIWE");
    }
    if (!Number.isSafeInteger(options.quotaPerName) || options.quotaPerName < 1) {
      throw new RangeError("Admission quota must be a positive integer");
    }
    if (
      !Number.isSafeInteger(options.issueBatchSize) ||
      options.issueBatchSize < 1 ||
      options.issueBatchSize > options.quotaPerName
    ) {
      throw new RangeError("Admission issue batch size is invalid");
    }
    this.#store = options.store;
    this.#keyPair = options.keyPair;
    this.#issuer = new Issuer(
      options.issuerName,
      options.keyPair.privateKey,
      options.keyPair.publicKey,
    );
    this.#holderVerifier = options.holderVerifier;
    this.#siweConfig = options.siweConfig;
    this.#chainId = options.chainId;
    this.#nameContract = getAddress(options.nameContract);
    this.#issuerName = options.issuerName;
    this.#originInfo = options.originInfo;
    this.#domain = options.domain;
    this.#uri = new URL(options.uri).toString();
    this.#quotaPerName = options.quotaPerName;
    this.#issueBatchSize = options.issueBatchSize;
    this.#now = options.now ?? Date.now;
    this.#tokenKeyIdPromise = this.#issuer.tokenKeyID();
    this.#signedTokenKey = createHmac("sha256", options.keyPair.privateKey)
      .update(`${RELAY_ADMISSION_PROTOCOL}/signed-tokens`)
      .digest();
  }

  #challenge(date: string): TokenChallenge {
    const context = createHash("sha256")
      .update(`${RELAY_ADMISSION_PROTOCOL}\n${this.#issuerName}\n${date}`)
      .digest();
    return new Origin([this.#originInfo]).createTokenChallenge(
      this.#issuerName,
      new Uint8Array(context),
    );
  }

  #sign(payload: SignedPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = createHmac("sha256", this.#signedTokenKey)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${mac}`;
  }

  #verifySigned(value: string, purpose: SignedPayload["purpose"]): SignedPayload {
    if (!value || value.length > 2_048) throw new RelayAdmissionError("Signed token is malformed");
    const parts = value.split(".");
    if (parts.length !== 2) throw new RelayAdmissionError("Signed token is malformed");
    const [encoded, suppliedMac] = parts as [string, string];
    const expectedMac = createHmac("sha256", this.#signedTokenKey)
      .update(encoded)
      .digest();
    const supplied = Buffer.from(suppliedMac, "base64url");
    if (!safeEqual(expectedMac, supplied)) {
      throw new RelayAdmissionError("Signed token is invalid");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new RelayAdmissionError("Signed token is malformed");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new RelayAdmissionError("Signed token is malformed");
    }
    const parsed = payload as Partial<SignedPayload>;
    if (
      parsed.v !== 0 ||
      parsed.purpose !== purpose ||
      !Number.isSafeInteger(parsed.exp) ||
      Number(parsed.exp) <= this.#now()
    ) {
      throw new RelayAdmissionError("Signed token is invalid or expired");
    }
    return parsed as SignedPayload;
  }

  config(): ProtectedRelayAdmissionConfig {
    const date = utcDate(this.#now());
    return {
      required: true,
      protocol: RELAY_ADMISSION_PROTOCOL,
      chainId: this.#chainId.toString(),
      nameContract: this.#nameContract,
      issuerName: this.#issuerName,
      issuerPublicKey: base64Url(this.#keyPair.publicKey),
      challenge: base64Url(this.#challenge(date).serialize()),
      utcDate: date,
      quotaPerName: this.#quotaPerName,
      issueBatchSize: this.#issueBatchSize,
    };
  }

  nonce(): RelayAdmissionNonce {
    const now = this.#now();
    const expiration = now + NONCE_LIFETIME_MS;
    const nonce = randomBytes(16).toString("hex");
    return {
      nonce,
      nonceToken: this.#sign({ v: 0, purpose: "nonce", nonce, exp: expiration }),
      domain: this.#domain,
      uri: this.#uri,
      statement: SIWE_STATEMENT,
      chainId: Number(this.#chainId),
      issuedAt: new Date(now).toISOString(),
      expirationTime: new Date(expiration).toISOString(),
    };
  }

  #session(holder: AuthenticatedGweiHolder, now: number): string {
    return this.#sign({
      v: 0,
      purpose: "session",
      utcDate: utcDate(now),
      name: holder.name,
      tokenId: holder.tokenId.toString(),
      address: holder.address,
      exp: nextUtcDay(now),
    });
  }

  async #authenticate(auth: NonNullable<IssuePayload["auth"]>): Promise<{
    holder: AuthenticatedGweiHolder;
    nonce: string;
  }> {
    if (
      !auth.name || auth.name.length > 512 ||
      !auth.message || auth.message.length > 8_192 ||
      !/^0x[0-9a-f]+$/iu.test(auth.signature) || auth.signature.length > 4_098
    ) {
      throw new RelayAdmissionError("SIWE authorization is malformed", 400);
    }
    const noncePayload = this.#verifySigned(auth.nonceToken, "nonce");
    if (typeof noncePayload.nonce !== "string") {
      throw new RelayAdmissionError("SIWE nonce token is malformed");
    }
    let message: SiweMessage;
    try {
      message = new SiweMessage(auth.message);
    } catch {
      throw new RelayAdmissionError("SIWE message is malformed", 400);
    }
    if (
      message.statement !== SIWE_STATEMENT ||
      !message.expirationTime ||
      Date.parse(message.expirationTime) > noncePayload.exp
    ) {
      throw new RelayAdmissionError("SIWE authorization has the wrong scope");
    }
    const verification = await message.verify(
      {
        signature: auth.signature,
        domain: this.#domain,
        nonce: noncePayload.nonce,
        uri: this.#uri,
        chainId: Number(this.#chainId),
        time: new Date(this.#now()).toISOString(),
      },
      { config: this.#siweConfig, strict: true, suppressExceptions: true },
    );
    if (!verification.success) throw new RelayAdmissionError("SIWE signature is invalid");
    const holder = await this.#holderVerifier.verify(auth.name, message.address);
    return { holder: { ...holder, address: getAddress(message.address) }, nonce: noncePayload.nonce };
  }

  async #sessionHolder(session: string): Promise<AuthenticatedGweiHolder> {
    const payload = this.#verifySigned(session, "session");
    const today = utcDate(this.#now());
    if (
      payload.utcDate !== today ||
      typeof payload.name !== "string" ||
      typeof payload.tokenId !== "string" ||
      typeof payload.address !== "string" ||
      !/^\d+$/u.test(payload.tokenId)
    ) {
      throw new RelayAdmissionError("Relay issuance session is invalid or expired");
    }
    const address = getAddress(payload.address);
    const current = await this.#holderVerifier.verify(payload.name, address);
    if (current.tokenId !== BigInt(payload.tokenId)) {
      throw new RelayAdmissionError("Relay issuance session no longer controls this name", 403);
    }
    return { ...current, address };
  }

  #issuePayload(value: unknown): IssuePayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RelayAdmissionError("Issuance request is malformed", 400);
    }
    const record = value as Record<string, unknown>;
    if (
      !Array.isArray(record.requests) ||
      record.requests.length < 1 ||
      record.requests.length > this.#issueBatchSize ||
      !record.requests.every((request) => typeof request === "string")
    ) {
      throw new RelayAdmissionError("Issuance request batch is malformed", 400);
    }
    if (typeof record.utcDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(record.utcDate)) {
      throw new RelayAdmissionError("Issuance request date is malformed", 400);
    }
    const payload: IssuePayload = {
      utcDate: record.utcDate,
      requests: record.requests as string[],
    };
    if (typeof record.session === "string") payload.session = record.session;
    if (record.auth && typeof record.auth === "object" && !Array.isArray(record.auth)) {
      const auth = record.auth as Record<string, unknown>;
      if (
        typeof auth.name === "string" &&
        typeof auth.message === "string" &&
        typeof auth.signature === "string" &&
        typeof auth.nonceToken === "string"
      ) {
        payload.auth = {
          name: auth.name,
          message: auth.message,
          signature: auth.signature,
          nonceToken: auth.nonceToken,
        };
      }
    }
    if (Boolean(payload.session) === Boolean(payload.auth)) {
      throw new RelayAdmissionError("Provide exactly one issuance authorization", 400);
    }
    return payload;
  }

  async issue(value: unknown): Promise<RelayAdmissionIssueResponse> {
    const payload = this.#issuePayload(value);
    const now = this.#now();
    const date = utcDate(now);
    if (payload.utcDate !== date) {
      throw new RelayAdmissionError("Relay token challenge expired; refresh and try again", 409);
    }
    const expectedKeyId = await this.#tokenKeyIdPromise;
    const requests = payload.requests.map((encoded) => {
      const bytes = decodeBase64Url(encoded, "Token request");
      if (bytes.length !== TOKEN_REQUEST_LENGTH) {
        throw new RelayAdmissionError("Token request has the wrong length", 400);
      }
      let request: TokenRequest;
      try {
        request = TokenRequest.deserialize(bytes);
      } catch {
        throw new RelayAdmissionError("Token request is malformed", 400);
      }
      if (request.truncatedTokenKeyId !== expectedKeyId.at(-1)) {
        throw new RelayAdmissionError("Token request uses the wrong issuer key", 400);
      }
      return request;
    });

    let holder: AuthenticatedGweiHolder;
    let remaining: number;
    if (payload.auth) {
      const authenticated = await this.#authenticate(payload.auth);
      holder = authenticated.holder;
      remaining = this.#store.authorizeAndReserve(
        date,
        authenticated.nonce,
        holder.tokenId.toString(),
        requests.length,
        this.#quotaPerName,
      );
    } else {
      holder = await this.#sessionHolder(payload.session!);
      remaining = this.#store.reserve(
        date,
        holder.tokenId.toString(),
        requests.length,
        this.#quotaPerName,
      );
    }

    const responses: string[] = [];
    for (const request of requests) {
      responses.push(base64Url((await this.#issuer.issue(request)).serialize()));
    }
    return {
      responses,
      session: this.#session(holder, now),
      remaining,
    };
  }

  async redeem(authorization: string | undefined): Promise<void> {
    if (!authorization || authorization.length > 4_096) {
      throw new RelayAdmissionError("A one-time relay pass is required");
    }
    let token: PrivacyPassToken;
    try {
      const parsed = AuthorizationHeader.parse(VOPRF, authorization);
      if (parsed.length !== 1) throw new Error("wrong token count");
      token = parsed[0]!.token;
    } catch {
      throw new RelayAdmissionError("The relay pass is malformed");
    }
    const expectedKeyId = await this.#tokenKeyIdPromise;
    const date = utcDate(this.#now());
    const expectedChallenge = createHash("sha256")
      .update(this.#challenge(date).serialize())
      .digest();
    if (
      token.authInput.tokenType !== VOPRF.value ||
      !safeEqual(token.authInput.tokenKeyId, expectedKeyId) ||
      !safeEqual(token.authInput.challengeDigest, expectedChallenge)
    ) {
      throw new RelayAdmissionError("The relay pass is invalid or expired");
    }
    if (!(await this.#issuer.verify(token))) {
      throw new RelayAdmissionError("The relay pass is invalid");
    }
    if (!this.#store.spend(date, base64Url(token.authInput.nonce))) {
      throw new RelayAdmissionError("The relay pass was already spent");
    }
  }

  status(): RelayAdmissionStatus {
    const date = utcDate(this.#now());
    return {
      required: true,
      protocol: RELAY_ADMISSION_PROTOCOL,
      utcDate: date,
      quotaPerName: this.#quotaPerName,
      issueBatchSize: this.#issueBatchSize,
      ...this.#store.status(date),
    };
  }

  close(): void {
    this.#holderVerifier.close?.();
    this.#store.close();
  }
}

function positiveEnvironment(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function admissionEnabled(): boolean {
  const configured = process.env.ADMISSION_REQUIRED?.trim().toLowerCase();
  if (configured) return !["0", "false", "off"].includes(configured);
  const publishing = !["0", "false", "off"].includes(
    (process.env.ONCHAIN_PUBLISH || "1").trim().toLowerCase(),
  );
  return publishing && Boolean(process.env.BATCHER_KEY_FILE?.trim());
}

export async function relayAdmissionFromEnvironment(): Promise<RelayAdmission | null> {
  if (!admissionEnabled()) return null;
  const chainId = BigInt(process.env.ADMISSION_CHAIN_ID?.trim() ||
    process.env.EXPECTED_CHAIN_ID?.trim() || SEPOLIA_CHAIN_ID);
  const nameContract = getAddress(
    process.env.ADMISSION_NAME_CONTRACT?.trim() || GNS_CONTRACT_ADDRESS,
  );
  const registrar = getAddress(
    process.env.ADMISSION_REGISTRAR?.trim() || SUBDOMAIN_REGISTRAR_ADDRESS,
  );
  const rpcUrl = process.env.ADMISSION_RPC_URL?.trim() ||
    process.env.PUBLISH_EXECUTION_RPC_URL?.trim() ||
    process.env.EXECUTION_RPC_URL?.trim() ||
    DEFAULT_SEPOLIA_RPC;
  const store = new SqliteAdmissionStore(
    process.env.ADMISSION_DATABASE?.trim() || "../.gwei-relay-admission.sqlite",
  );
  try {
    const keyPair = await store.loadOrCreateKeyPair(keyGen);
    const provider = new JsonRpcProvider(rpcUrl);
    const holderVerifier = new OnchainGweiHolderVerifier({
      provider,
      chainId,
      nameContract,
      registrar,
    });
    const siweConfig = await createEthersConfig(provider);
    return new RelayAdmission({
      store,
      keyPair,
      holderVerifier,
      siweConfig,
      chainId,
      nameContract,
      issuerName: process.env.ADMISSION_ISSUER_NAME?.trim() || "gwei.domains",
      originInfo: process.env.ADMISSION_ORIGIN_INFO?.trim() || "gwei.domains",
      domain: process.env.ADMISSION_SIWE_DOMAIN?.trim() || "gwei.domains",
      uri: process.env.ADMISSION_SIWE_URI?.trim() || "https://gwei.domains/",
      quotaPerName: positiveEnvironment("ADMISSION_DAILY_QUOTA", 256),
      issueBatchSize: positiveEnvironment("ADMISSION_BATCH_SIZE", 32),
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

export { AdmissionQuotaError };
