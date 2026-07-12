import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const MICROS_PER_USD = 1_000_000n;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const BASIS_POINTS = 10_000n;

interface StoredBudgetLedger {
  v: 0;
  utcDate: string;
  spentUsdMicros: string;
  reservations: Record<string, string>;
}

interface BudgetLedger {
  utcDate: string;
  spentUsdMicros: bigint;
  reservations: Record<string, bigint>;
}

export interface BudgetLedgerStore {
  read(): Promise<unknown>;
  write(value: StoredBudgetLedger): Promise<void>;
}

export interface EthUsdPriceSource {
  usdMicrosPerEth(): Promise<bigint>;
}

export interface DailyUsdBudgetOptions {
  limitUsdMicros: bigint;
  priceSafetyBps: bigint;
  store: BudgetLedgerStore;
  priceSource: EthUsdPriceSource;
  now?: () => number;
}

export interface DailyUsdBudgetStatus {
  utcDate: string;
  limitUsdMicros: bigint;
  spentUsdMicros: bigint;
  reservedUsdMicros: bigint;
  remainingUsdMicros: bigint;
}

export class DailyBudgetExceededError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "DailyBudgetExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextUtcDay(timestamp: number): number {
  const current = new Date(timestamp);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1);
}

function nonNegativeBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return BigInt(value);
}

function emptyLedger(date: string): BudgetLedger {
  return { utcDate: date, spentUsdMicros: 0n, reservations: {} };
}

function normalizeLedger(value: unknown, date: string): BudgetLedger {
  if (!value || typeof value !== "object") return emptyLedger(date);
  const record = value as Partial<StoredBudgetLedger>;
  if (record.v !== 0 || record.utcDate !== date) return emptyLedger(date);
  if (!record.reservations || typeof record.reservations !== "object") {
    throw new Error("Budget reservations are malformed");
  }
  const reservations: Record<string, bigint> = {};
  for (const [id, amount] of Object.entries(record.reservations)) {
    if (!id || id.length > 128) throw new Error("Budget reservation ID is malformed");
    reservations[id] = nonNegativeBigInt(amount, "Budget reservation");
  }
  return {
    utcDate: date,
    spentUsdMicros: nonNegativeBigInt(record.spentUsdMicros, "Budget spend"),
    reservations,
  };
}

function storedLedger(ledger: BudgetLedger): StoredBudgetLedger {
  return {
    v: 0,
    utcDate: ledger.utcDate,
    spentUsdMicros: ledger.spentUsdMicros.toString(),
    reservations: Object.fromEntries(
      Object.entries(ledger.reservations).map(([id, amount]) => [id, amount.toString()]),
    ),
  };
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

export function parseUsdMicros(value: string, label = "USD amount"): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(value.trim());
  if (!match) throw new Error(`${label} must be a non-negative decimal with at most 6 places`);
  return BigInt(match[1]!) * MICROS_PER_USD + BigInt((match[2] || "").padEnd(6, "0"));
}

export function weiCostInUsdMicros(
  wei: bigint,
  usdMicrosPerEth: bigint,
  safetyBps: bigint,
): bigint {
  if (wei < 0n || usdMicrosPerEth < 1n || safetyBps < BASIS_POINTS) {
    throw new RangeError("Budget conversion inputs are invalid");
  }
  return ceilDivide(wei * usdMicrosPerEth * safetyBps, WEI_PER_ETH * BASIS_POINTS);
}

export class DailyUsdBudget {
  readonly #limitUsdMicros: bigint;
  readonly #priceSafetyBps: bigint;
  readonly #store: BudgetLedgerStore;
  readonly #priceSource: EthUsdPriceSource;
  readonly #now: () => number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DailyUsdBudgetOptions) {
    if (options.limitUsdMicros < 1n) throw new RangeError("Daily USD budget must be positive");
    if (options.priceSafetyBps < BASIS_POINTS) {
      throw new RangeError("Budget price safety must be at least 10000 basis points");
    }
    this.#limitUsdMicros = options.limitUsdMicros;
    this.#priceSafetyBps = options.priceSafetyBps;
    this.#store = options.store;
    this.#priceSource = options.priceSource;
    this.#now = options.now ?? Date.now;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #ledger(now: number): Promise<BudgetLedger> {
    return normalizeLedger(await this.#store.read(), utcDate(now));
  }

  reserve(id: string, worstCaseCostWei: bigint): Promise<bigint> {
    return this.#exclusive(async () => {
      if (!id || id.length > 128) throw new RangeError("Budget reservation ID is invalid");
      if (worstCaseCostWei < 1n) throw new RangeError("Worst-case publication cost must be positive");
      const now = this.#now();
      const ledger = await this.#ledger(now);
      const existing = ledger.reservations[id];
      if (existing !== undefined) return existing;

      const price = await this.#priceSource.usdMicrosPerEth();
      const reservation = weiCostInUsdMicros(
        worstCaseCostWei,
        price,
        this.#priceSafetyBps,
      );
      const reserved = sum(Object.values(ledger.reservations));
      if (ledger.spentUsdMicros + reserved + reservation > this.#limitUsdMicros) {
        const retryAfterMs = Math.max(1_000, nextUtcDay(now) - now);
        throw new DailyBudgetExceededError(
          "Daily publication budget is exhausted; the encrypted batch remains queued",
          retryAfterMs,
        );
      }
      ledger.reservations[id] = reservation;
      await this.#store.write(storedLedger(ledger));
      return reservation;
    });
  }

  commit(id: string): Promise<void> {
    return this.#exclusive(async () => {
      const now = this.#now();
      const ledger = await this.#ledger(now);
      const reservation = ledger.reservations[id];
      if (reservation === undefined) return;
      ledger.spentUsdMicros += reservation;
      delete ledger.reservations[id];
      await this.#store.write(storedLedger(ledger));
    });
  }

  status(): Promise<DailyUsdBudgetStatus> {
    return this.#exclusive(async () => {
      const now = this.#now();
      const ledger = await this.#ledger(now);
      const reservedUsdMicros = sum(Object.values(ledger.reservations));
      const used = ledger.spentUsdMicros + reservedUsdMicros;
      return {
        utcDate: ledger.utcDate,
        limitUsdMicros: this.#limitUsdMicros,
        spentUsdMicros: ledger.spentUsdMicros,
        reservedUsdMicros,
        remainingUsdMicros: used >= this.#limitUsdMicros ? 0n : this.#limitUsdMicros - used,
      };
    });
  }
}

export class JsonFileBudgetStore implements BudgetLedgerStore {
  readonly #path: string;

  constructor(pathValue: string) {
    this.#path = resolve(pathValue);
  }

  async read(): Promise<unknown> {
    try {
      const file = await stat(this.#path);
      if ((file.mode & 0o077) !== 0) throw new Error("Budget file permissions must be 0600");
      return JSON.parse(await readFile(this.#path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value: StoredBudgetLedger): Promise<void> {
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
  }
}

export class CoinbaseEthUsdPriceSource implements EthUsdPriceSource {
  readonly #url: string;
  readonly #ttlMs: number;
  #cached: { price: bigint; expiresAt: number } | undefined;

  constructor(
    url = "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    ttlMs = 60_000,
  ) {
    this.#url = url;
    this.#ttlMs = ttlMs;
  }

  async usdMicrosPerEth(): Promise<bigint> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt > now) return this.#cached.price;
    const response = await fetch(this.#url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`ETH/USD quote failed (${response.status})`);
    const value = await response.json() as unknown;
    const amount = (value as { data?: { amount?: unknown } })?.data?.amount;
    if (typeof amount !== "string") throw new Error("ETH/USD quote is malformed");
    const price = parseUsdMicros(amount, "ETH/USD quote");
    if (price < MICROS_PER_USD) throw new Error("ETH/USD quote is implausibly low");
    this.#cached = { price, expiresAt: now + this.#ttlMs };
    return price;
  }
}

export function dailyUsdBudgetFromEnvironment(): DailyUsdBudget {
  const limitUsdMicros = parseUsdMicros(
    process.env.DAILY_BUDGET_USD?.trim() || "20",
    "DAILY_BUDGET_USD",
  );
  const priceSafetyBps = BigInt(process.env.BUDGET_PRICE_SAFETY_BPS?.trim() || "11000");
  const ttlMs = Number.parseInt(process.env.ETH_USD_PRICE_TTL_MS || "60000", 10);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
    throw new Error("ETH_USD_PRICE_TTL_MS must be at least 1000");
  }
  return new DailyUsdBudget({
    limitUsdMicros,
    priceSafetyBps,
    store: new JsonFileBudgetStore(
      process.env.BUDGET_FILE?.trim() || "../.gwei-batcher-budget.json",
    ),
    priceSource: new CoinbaseEthUsdPriceSource(
      process.env.ETH_USD_PRICE_URL?.trim() || undefined,
      ttlMs,
    ),
  });
}
