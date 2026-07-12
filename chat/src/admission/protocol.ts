export const RELAY_ADMISSION_PROTOCOL = "gwei-relay-privacy-pass-rfc9578-v0";

export interface OpenRelayAdmissionConfig {
  required: false;
}

export interface ProtectedRelayAdmissionConfig {
  required: true;
  protocol: typeof RELAY_ADMISSION_PROTOCOL;
  chainId: string;
  nameContract: string;
  issuerName: string;
  issuerPublicKey: string;
  challenge: string;
  utcDate: string;
  quotaPerName: number;
  issueBatchSize: number;
}

export type RelayAdmissionConfig =
  | OpenRelayAdmissionConfig
  | ProtectedRelayAdmissionConfig;

export interface RelayAdmissionNonce {
  nonce: string;
  nonceToken: string;
  domain: string;
  uri: string;
  statement: string;
  chainId: number;
  issuedAt: string;
  expirationTime: string;
}

export interface RelayAdmissionIssueRequest {
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

export interface RelayAdmissionIssueResponse {
  responses: string[];
  session: string;
  remaining: number;
}

export class RelayHolderNameRequiredError extends Error {
  constructor() {
    super("Choose the .gwei name you own before using this subsidized batcher");
    this.name = "RelayHolderNameRequiredError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is malformed`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is malformed`);
  }
  return value as number;
}

export function parseRelayAdmissionConfig(value: unknown): RelayAdmissionConfig {
  const record = object(value, "Relay admission config");
  if (record.required === false) return { required: false };
  if (record.required !== true || record.protocol !== RELAY_ADMISSION_PROTOCOL) {
    throw new Error("Relay admission config is unsupported");
  }
  const chainId = text(record.chainId, "Relay admission chain ID", 32);
  if (!/^\d+$/u.test(chainId) || BigInt(chainId) < 1n) {
    throw new Error("Relay admission chain ID is malformed");
  }
  const utcDate = text(record.utcDate, "Relay admission date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(utcDate)) {
    throw new Error("Relay admission date is malformed");
  }
  const quotaPerName = positiveInteger(record.quotaPerName, "Relay daily quota");
  const issueBatchSize = positiveInteger(record.issueBatchSize, "Relay issue batch size");
  if (quotaPerName > 1_000_000 || issueBatchSize > 512 || issueBatchSize > quotaPerName) {
    throw new Error("Relay admission limits are unreasonable");
  }
  const nameContract = text(record.nameContract, "Relay name contract", 42);
  if (!/^0x[0-9a-f]{40}$/iu.test(nameContract)) {
    throw new Error("Relay name contract is malformed");
  }
  return {
    required: true,
    protocol: RELAY_ADMISSION_PROTOCOL,
    chainId,
    nameContract,
    issuerName: text(record.issuerName, "Relay issuer name", 255),
    issuerPublicKey: text(record.issuerPublicKey, "Relay issuer key"),
    challenge: text(record.challenge, "Relay token challenge"),
    utcDate,
    quotaPerName,
    issueBatchSize,
  };
}

export function parseRelayAdmissionNonce(value: unknown): RelayAdmissionNonce {
  const record = object(value, "Relay admission nonce");
  return {
    nonce: text(record.nonce, "SIWE nonce", 128),
    nonceToken: text(record.nonceToken, "SIWE nonce token"),
    domain: text(record.domain, "SIWE domain", 255),
    uri: text(record.uri, "SIWE URI"),
    statement: text(record.statement, "SIWE statement", 512),
    chainId: positiveInteger(record.chainId, "SIWE chain ID"),
    issuedAt: text(record.issuedAt, "SIWE issued-at", 64),
    expirationTime: text(record.expirationTime, "SIWE expiration", 64),
  };
}

export function parseRelayAdmissionIssueResponse(value: unknown): RelayAdmissionIssueResponse {
  const record = object(value, "Relay issuance response");
  if (!Array.isArray(record.responses) || record.responses.length === 0) {
    throw new Error("Relay issuance response is malformed");
  }
  return {
    responses: record.responses.map((response) =>
      text(response, "Relay token response")),
    session: text(record.session, "Relay issuance session"),
    remaining: nonNegativeInteger(record.remaining, "Relay remaining quota"),
  };
}
