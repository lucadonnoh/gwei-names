import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRANSPORT_SETTINGS,
  normalizeTransportSettings,
  resolveTransportSettings,
} from "./settings";

const ORIGIN = "https://gwei.domains/chat";

describe("transport settings", () => {
  it("uses safe, usable Sepolia defaults", () => {
    expect(resolveTransportSettings({ origin: ORIGIN })).toEqual(DEFAULT_TRANSPORT_SETTINGS);
  });

  it("lets query parameters override a persisted batcher and RPC", () => {
    const stored = JSON.stringify({
      v: 0,
      batcherUrl: "https://batcher.saved.example/api",
      executionRpcUrl: "https://rpc.saved.example/key",
      beaconApiUrl: "https://beacon.saved.example",
      onchainEnabled: false,
    });
    expect(
      resolveTransportSettings({
        origin: ORIGIN,
        stored,
        search: "?batcher=https%3A%2F%2Fbatcher.example&executionRpc=https%3A%2F%2Frpc.example&onchain=1",
      }),
    ).toEqual({
      batcherUrl: "https://batcher.example",
      executionRpcUrl: "https://rpc.example",
      beaconApiUrl: "https://beacon.saved.example",
      onchainEnabled: true,
    });
  });

  it("allows relative and local batchers but rejects unsafe remote endpoints", () => {
    expect(
      normalizeTransportSettings({
        ...DEFAULT_TRANSPORT_SETTINGS,
        batcherUrl: "/custom-batcher/",
      }, ORIGIN).batcherUrl,
    ).toBe("/custom-batcher");
    expect(
      normalizeTransportSettings({
        ...DEFAULT_TRANSPORT_SETTINGS,
        batcherUrl: "http://127.0.0.1:8790/",
      }, ORIGIN).batcherUrl,
    ).toBe("http://127.0.0.1:8790");
    expect(() =>
      normalizeTransportSettings({
        ...DEFAULT_TRANSPORT_SETTINGS,
        executionRpcUrl: "http://rpc.example",
      }, ORIGIN),
    ).toThrow(/HTTPS/u);
    expect(() =>
      normalizeTransportSettings({
        ...DEFAULT_TRANSPORT_SETTINGS,
        batcherUrl: "https://secret:password@batcher.example",
      }, ORIGIN),
    ).toThrow(/credentials/u);
  });
});
