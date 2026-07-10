import { afterEach, describe, expect, it, vi } from "vitest";
import { Mt5MarketDataProvider } from "../../server/providers/market/Mt5MarketDataProvider";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("MT5 market data provider", () => {
  it("maps the local bridge snapshot to the shared market snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T21:00:00Z"));
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(bridgeSnapshot()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const provider = new Mt5MarketDataProvider({
      bridgeUrl: "http://127.0.0.1:8765",
      symbol: "XAUUSDm",
      maxQuoteAgeSeconds: 180,
    });
    const result = await provider.getSnapshots(["XAUUSD"]);
    const snapshot = result.snapshots[0];

    expect(result.provider).toBe("mt5-exness");
    expect(result.dataQuality).toBe("HIGH");
    expect(snapshot?.provider).toBe("mt5-exness");
    expect(snapshot?.bid).toBe(4218.665);
    expect(snapshot?.ask).toBe(4218.945);
    expect(snapshot?.spread).toBe(0.28);
    expect(snapshot?.candles.M1).toHaveLength(350);
    expect(snapshot?.candles.M5).toHaveLength(350);
    expect(snapshot?.candles.M15).toHaveLength(350);
    expect(snapshot?.candles.H1).toHaveLength(350);
    expect(snapshot?.candles.H4).toHaveLength(350);
    expect(snapshot?.candles.M5[0]?.time).toBe("2026-06-11T15:45:00.000Z");
    expect(snapshot?.candles.M5.at(-1)?.time).toBe(
      "2026-06-12T20:50:00.000Z",
    );
  });

  it("uses the bridge price for the lightweight price endpoint", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(bridgeSnapshot()), { status: 200 }),
    ) as typeof fetch;
    const provider = new Mt5MarketDataProvider({
      bridgeUrl: "http://127.0.0.1:8765",
      symbol: "XAUUSDm",
    });

    await expect(provider.getLatestPrice("XAUUSD")).resolves.toMatchObject({
      symbol: "XAUUSD",
      price: 4218.665,
    });
  });
});

function bridgeSnapshot() {
  return {
    symbol: "XAUUSDm",
    price: 4218.665,
    bid: 4218.665,
    ask: 4218.945,
    spread: 0.28,
    spread_points: 280,
    digits: 3,
    time: "2026-06-12T20:59:00+00:00",
    time_msc: 1_781_297_940_000,
    provider: "mt5-exness",
    candles: {
      M1: candles(1),
      M5: candles(5),
      M15: candles(15),
      H1: candles(60),
      H4: candles(240),
    },
  };
}

function candles(intervalMinutes: number) {
  const end = new Date("2026-06-12T20:50:00Z").getTime();
  return Array.from({ length: 350 }, (_, index) => {
    const sequence = index + 1;
    const close = 4100 + sequence * 0.1;
    return {
      time: new Date(
        end - (349 - index) * intervalMinutes * 60_000,
      ).toISOString(),
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 100 + sequence,
    };
  });
}
