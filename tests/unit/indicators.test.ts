import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import { ema, supportResistance, trend } from "../../server/utils/indicators";

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 4300 + index * 0.5;
    return {
      time: new Date(Date.UTC(2026, 5, 9, index)).toISOString(),
      open: close - 0.2,
      high: close + 2,
      low: close - 2,
      close,
      volume: 0,
    };
  });
}

describe("indicators", () => {
  it("does not fallback EMA200 to current price when data is insufficient", () => {
    const closes = candles(199).map((candle) => candle.close);
    expect(ema(closes, 200)).toBeNull();
    expect(trend(closes)).toBe("INSUFFICIENT_DATA");
  });

  it("calculates EMA200 when enough data exists", () => {
    const closes = candles(200).map((candle) => candle.close);
    expect(ema(closes, 200)).not.toBeNull();
  });

  it("keeps support below current price and resistance above current price", () => {
    const levels = supportResistance(candles(120));
    const current = candles(120).at(-1)?.close ?? 0;

    expect(levels.supportLevels.every((level) => level.price <= current)).toBe(true);
    expect(levels.resistanceLevels.every((level) => level.price >= current)).toBe(true);
  });
});
