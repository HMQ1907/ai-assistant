import { describe, expect, it } from "vitest";
import { evaluateByStrategyMode } from "../../server/services/RuleSignalService";
import type { Candle, MarketSnapshot } from "../../types/trading";

function candle(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { time, open, high, low, close, volume: 100 };
}

function flatCandles(count: number, price: number): Candle[] {
  return Array.from({ length: count }, (_, index) =>
    candle(
      `2026-07-09T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
      price,
      price + 1,
      price - 1,
      price,
    ),
  );
}

function snapshotWith(candles: {
  M1?: Candle[];
  M5?: Candle[];
  M15?: Candle[];
  H1?: Candle[];
  H4?: Candle[];
}): MarketSnapshot {
  return {
    symbol: "XAUUSD",
    price: 4200,
    bid: 4199.8,
    ask: 4200.2,
    spread: 0.4,
    bidAskStatus: "AVAILABLE",
    quoteTimestampReliable: true,
    quoteAgeSeconds: 5,
    data_quality: "HIGH",
    critical_errors: [],
    warnings: [],
    updatedAt: "2026-07-09T10:00:00Z",
    provider: "mt5",
    candles: {
      M1: candles.M1 ?? [],
      M5: candles.M5 ?? [],
      M15: candles.M15 ?? [],
      H1: candles.H1 ?? [],
      H4: candles.H4 ?? [],
    },
  } as unknown as MarketSnapshot;
}

const baseConfig = {
  autoStrategyMode: "xau_trend_pullback",
  autoUseM15: true,
  autoAllowScalp: false,
};

describe("evaluateByStrategyMode (luồng manual rule-signal)", () => {
  it("chọn đúng mode xau_trend_pullback và trả lý do từ chối khi thiếu nến", () => {
    const snapshot = snapshotWith({
      M5: flatCandles(10, 4200),
      M15: flatCandles(10, 4200),
      H1: flatCandles(10, 4200),
      H4: flatCandles(10, 4200),
    });
    const result = evaluateByStrategyMode(baseConfig, snapshot);

    expect(result.mode).toBe("xau_trend_pullback");
    expect(result.signal).toBeNull();
    expect(result.entryTf).toBe("M5");
    // Phải giải thích được VÌ SAO không có tín hiệu, không im lặng.
    expect(result.rejectReasons.length).toBeGreaterThan(0);
    expect(result.rejectReasons[0]).toMatch(/H1 candles|M15 candles/);
  });

  it("mode strict thiếu dữ liệu vẫn trả reject reason cho cả H1 và M15", () => {
    const snapshot = snapshotWith({
      M5: flatCandles(10, 4200),
      M15: flatCandles(10, 4200),
      H1: flatCandles(10, 4200),
      H4: flatCandles(10, 4200),
    });
    const result = evaluateByStrategyMode(
      { ...baseConfig, autoStrategyMode: "strict" },
      snapshot,
    );

    expect(result.mode).toBe("strict");
    expect(result.signal).toBeNull();
    expect(result.rejectReasons.some((item) => item.startsWith("H1:"))).toBe(true);
    expect(result.rejectReasons.some((item) => item.startsWith("M15:"))).toBe(true);
  });

  it("mode không hợp lệ rơi về strict (giống AutoTradeRunner)", () => {
    const snapshot = snapshotWith({
      M5: flatCandles(5, 4200),
      M15: flatCandles(5, 4200),
      H1: flatCandles(5, 4200),
      H4: flatCandles(5, 4200),
    });
    const result = evaluateByStrategyMode(
      { ...baseConfig, autoStrategyMode: "whatever" },
      snapshot,
    );
    expect(result.mode).toBe("strict");
  });

  it("MANUAL_SCALP=true chuyển quét tay sang mode bắt đỉnh/đáy manual_scalp", () => {
    const snapshot = snapshotWith({
      M1: flatCandles(10, 4200),
      M5: flatCandles(300, 4200),
      M15: flatCandles(300, 4200),
      H1: flatCandles(300, 4200),
      H4: flatCandles(300, 4200),
    });
    const result = evaluateByStrategyMode(
      { ...baseConfig, manualScalp: true },
      snapshot,
    );
    expect(result.mode).toBe("manual_scalp");
    expect(result.entryTf).toBe("M1");
    expect(result.rejectReasons[0]).toMatch(/M1 candles/);
  });

  it("thị trường đi ngang (đủ nến) không phát tín hiệu bừa", () => {
    // 300 nến flat: EMA dính nhau, ADX thấp -> mọi mode phải NO signal.
    const snapshot = snapshotWith({
      M5: flatCandles(300, 4200),
      M15: flatCandles(300, 4200),
      H1: flatCandles(300, 4200),
      H4: flatCandles(300, 4200),
    });
    for (const mode of ["xau_trend_pullback", "balanced", "strict"]) {
      const result = evaluateByStrategyMode(
        { ...baseConfig, autoStrategyMode: mode },
        snapshot,
      );
      expect(result.signal).toBeNull();
      expect(result.rejectReasons.length).toBeGreaterThan(0);
    }
  });
});
