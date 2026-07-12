import { chmodSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AdmissionIssuerKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface AdmissionStoreStatus {
  issued: number;
  spent: number;
}

export interface AdmissionStore {
  loadOrCreateKeyPair(
    generate: () => Promise<AdmissionIssuerKeyPair>,
  ): Promise<AdmissionIssuerKeyPair>;
  authorizeAndReserve(
    utcDate: string,
    siweNonce: string,
    tokenId: string,
    count: number,
    quota: number,
  ): number;
  reserve(utcDate: string, tokenId: string, count: number, quota: number): number;
  spend(utcDate: string, tokenNonce: string): boolean;
  status(utcDate: string): AdmissionStoreStatus;
  close(): void;
}

export class AdmissionQuotaError extends Error {
  readonly remaining: number;

  constructor(remaining: number) {
    super("The daily relay-pass quota for this .gwei name is exhausted");
    this.name = "AdmissionQuotaError";
    this.remaining = remaining;
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function storedKey(value: unknown, expectedLength: number, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== expectedLength) throw new Error(`${label} has the wrong length`);
  return new Uint8Array(bytes);
}

export class SqliteAdmissionStore implements AdmissionStore {
  readonly #database: DatabaseSync;

  constructor(pathValue: string) {
    const memory = pathValue === ":memory:";
    const path = memory ? pathValue : resolve(pathValue);
    if (!memory) {
      try {
        const file = statSync(path);
        if ((file.mode & 0o077) !== 0) {
          throw new Error("Admission database permissions must be 0600");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    this.#database = new DatabaseSync(path);
    if (!memory) chmodSync(path, 0o600);
    this.#database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS issuance (
        utc_date TEXT NOT NULL,
        token_id TEXT NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 0),
        PRIMARY KEY (utc_date, token_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spent_passes (
        utc_date TEXT NOT NULL,
        nonce TEXT NOT NULL,
        PRIMARY KEY (utc_date, nonce)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS siwe_nonces (
        utc_date TEXT NOT NULL,
        nonce TEXT NOT NULL,
        PRIMARY KEY (utc_date, nonce)
      ) STRICT;
    `);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #prune(utcDate: string): void {
    this.#database.prepare("DELETE FROM issuance WHERE utc_date <> ?").run(utcDate);
    this.#database.prepare("DELETE FROM spent_passes WHERE utc_date <> ?").run(utcDate);
    this.#database.prepare("DELETE FROM siwe_nonces WHERE utc_date <> ?").run(utcDate);
  }

  async loadOrCreateKeyPair(
    generate: () => Promise<AdmissionIssuerKeyPair>,
  ): Promise<AdmissionIssuerKeyPair> {
    const rows = this.#database.prepare(
      "SELECT key, value FROM meta WHERE key IN ('issuer_private_key', 'issuer_public_key')",
    ).all() as Array<{ key: string; value: unknown }>;
    if (rows.length === 2) {
      const values = new Map(rows.map((row) => [row.key, row.value]));
      return {
        privateKey: storedKey(values.get("issuer_private_key"), 48, "Issuer private key"),
        publicKey: storedKey(values.get("issuer_public_key"), 49, "Issuer public key"),
      };
    }
    if (rows.length !== 0) throw new Error("Admission issuer key pair is incomplete");

    const generated = await generate();
    if (generated.privateKey.length !== 48 || generated.publicKey.length !== 49) {
      throw new Error("Generated admission issuer key pair is malformed");
    }
    this.#transaction(() => {
      const insert = this.#database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      insert.run("issuer_private_key", Buffer.from(generated.privateKey).toString("base64url"));
      insert.run("issuer_public_key", Buffer.from(generated.publicKey).toString("base64url"));
    });
    return {
      privateKey: generated.privateKey.slice(),
      publicKey: generated.publicKey.slice(),
    };
  }

  #reserve(utcDate: string, tokenId: string, count: number, quota: number): number {
    positiveInteger(count, "Issuance count");
    positiveInteger(quota, "Daily issuance quota");
    const row = this.#database.prepare(
      "SELECT count FROM issuance WHERE utc_date = ? AND token_id = ?",
    ).get(utcDate, tokenId) as { count?: number | bigint } | undefined;
    const issued = row?.count === undefined ? 0 : Number(row.count);
    if (!Number.isSafeInteger(issued) || issued < 0) {
      throw new Error("Persisted issuance count is malformed");
    }
    const remaining = Math.max(0, quota - issued);
    if (count > remaining) throw new AdmissionQuotaError(remaining);
    const next = issued + count;
    this.#database.prepare(`
      INSERT INTO issuance (utc_date, token_id, count) VALUES (?, ?, ?)
      ON CONFLICT (utc_date, token_id) DO UPDATE SET count = excluded.count
    `).run(utcDate, tokenId, next);
    return quota - next;
  }

  authorizeAndReserve(
    utcDate: string,
    siweNonce: string,
    tokenId: string,
    count: number,
    quota: number,
  ): number {
    return this.#transaction(() => {
      this.#prune(utcDate);
      const inserted = this.#database.prepare(
        "INSERT OR IGNORE INTO siwe_nonces (utc_date, nonce) VALUES (?, ?)",
      ).run(utcDate, siweNonce);
      if (Number(inserted.changes) !== 1) throw new Error("This SIWE nonce was already used");
      return this.#reserve(utcDate, tokenId, count, quota);
    });
  }

  reserve(utcDate: string, tokenId: string, count: number, quota: number): number {
    return this.#transaction(() => {
      this.#prune(utcDate);
      return this.#reserve(utcDate, tokenId, count, quota);
    });
  }

  spend(utcDate: string, tokenNonce: string): boolean {
    return this.#transaction(() => {
      this.#prune(utcDate);
      const inserted = this.#database.prepare(
        "INSERT OR IGNORE INTO spent_passes (utc_date, nonce) VALUES (?, ?)",
      ).run(utcDate, tokenNonce);
      return Number(inserted.changes) === 1;
    });
  }

  status(utcDate: string): AdmissionStoreStatus {
    this.#prune(utcDate);
    const issuedRow = this.#database.prepare(
      "SELECT COALESCE(SUM(count), 0) AS count FROM issuance WHERE utc_date = ?",
    ).get(utcDate) as { count?: number | bigint } | undefined;
    const spentRow = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM spent_passes WHERE utc_date = ?",
    ).get(utcDate) as { count?: number | bigint } | undefined;
    return {
      issued: Number(issuedRow?.count ?? 0),
      spent: Number(spentRow?.count ?? 0),
    };
  }

  close(): void {
    this.#database.close();
  }
}
