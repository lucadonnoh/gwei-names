import { describe, expect, it } from "vitest";

import {
  DailyBudgetExceededError,
  DailyUsdBudget,
  parseUsdMicros,
  weiCostInUsdMicros,
} from "./daily-budget";
import type {
  BudgetLedgerStore,
  EthUsdPriceSource,
} from "./daily-budget";

class MemoryBudgetStore implements BudgetLedgerStore {
  value: unknown = null;

  async read(): Promise<unknown> {
    return structuredClone(this.value);
  }

  async write(value: Parameters<BudgetLedgerStore["write"]>[0]): Promise<void> {
    this.value = structuredClone(value);
  }
}

function fixedPrice(usdMicrosPerEth: bigint): EthUsdPriceSource {
  return { usdMicrosPerEth: async () => usdMicrosPerEth };
}

describe("daily USD publication budget", () => {
  it("converts worst-case wei using a conservative ETH/USD quote", () => {
    expect(parseUsdMicros("20")).toBe(20_000_000n);
    expect(parseUsdMicros("1798.38")).toBe(1_798_380_000n);
    expect(
      weiCostInUsdMicros(
        1_000_000_000_000_000_000n,
        2_000_000_000n,
        11_000n,
      ),
    ).toBe(2_200_000_000n);
  });

  it("persists reservations before committing them and enforces the cap", async () => {
    const store = new MemoryBudgetStore();
    const budget = new DailyUsdBudget({
      limitUsdMicros: 20_000_000n,
      priceSafetyBps: 10_000n,
      store,
      priceSource: fixedPrice(2_000_000_000n),
      now: () => Date.UTC(2026, 6, 11, 12),
    });
    const tenDollarsInWei = 5_000_000_000_000_000n;

    expect(await budget.reserve("attempt-a", tenDollarsInWei)).toBe(10_000_000n);
    // Retrying the same persistence operation is idempotent.
    expect(await budget.reserve("attempt-a", 10n ** 18n)).toBe(10_000_000n);
    expect(await budget.status()).toMatchObject({
      spentUsdMicros: 0n,
      reservedUsdMicros: 10_000_000n,
      remainingUsdMicros: 10_000_000n,
    });

    await budget.commit("attempt-a");
    await budget.reserve("attempt-b", tenDollarsInWei);
    await expect(budget.reserve("attempt-c", 1n)).rejects.toBeInstanceOf(
      DailyBudgetExceededError,
    );
    expect(await budget.status()).toMatchObject({
      spentUsdMicros: 10_000_000n,
      reservedUsdMicros: 10_000_000n,
      remainingUsdMicros: 0n,
    });
  });

  it("serializes concurrent reservations so they cannot oversubscribe", async () => {
    const budget = new DailyUsdBudget({
      limitUsdMicros: 20_000_000n,
      priceSafetyBps: 10_000n,
      store: new MemoryBudgetStore(),
      priceSource: fixedPrice(2_000_000_000n),
      now: () => Date.UTC(2026, 6, 11, 12),
    });
    const fifteenDollarsInWei = 7_500_000_000_000_000n;
    const results = await Promise.allSettled([
      budget.reserve("attempt-a", fifteenDollarsInWei),
      budget.reserve("attempt-b", fifteenDollarsInWei),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await budget.status()).toMatchObject({
      reservedUsdMicros: 15_000_000n,
      remainingUsdMicros: 5_000_000n,
    });
  });

  it("starts a fresh ledger on the next UTC day", async () => {
    let now = Date.UTC(2026, 6, 11, 23, 59);
    const budget = new DailyUsdBudget({
      limitUsdMicros: 20_000_000n,
      priceSafetyBps: 10_000n,
      store: new MemoryBudgetStore(),
      priceSource: fixedPrice(2_000_000_000n),
      now: () => now,
    });
    await budget.reserve("attempt-a", 5_000_000_000_000_000n);
    await budget.commit("attempt-a");
    expect((await budget.status()).spentUsdMicros).toBe(10_000_000n);

    now = Date.UTC(2026, 6, 12, 0, 1);
    expect(await budget.status()).toMatchObject({
      utcDate: "2026-07-12",
      spentUsdMicros: 0n,
      reservedUsdMicros: 0n,
      remainingUsdMicros: 20_000_000n,
    });
  });

  it("fails closed when the ETH/USD quote is unavailable", async () => {
    const store = new MemoryBudgetStore();
    const budget = new DailyUsdBudget({
      limitUsdMicros: 20_000_000n,
      priceSafetyBps: 10_000n,
      store,
      priceSource: {
        usdMicrosPerEth: async () => {
          throw new Error("quote unavailable");
        },
      },
    });

    await expect(budget.reserve("attempt-a", 1n)).rejects.toThrow("quote unavailable");
    expect(store.value).toBeNull();
  });
});
