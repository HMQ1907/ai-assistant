import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  ema,
  supportResistance,
  trend,
  structureTrend,
} from "../../server/utils/indicators";

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

// candle thứ i có close = base + slope*i, dùng để dựng up/down/flat trend.
function rampCandles(count: number, slope: number, base = 4300): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = base + slope * index;
    return {
      time: new Date(Date.UTC(2026, 5, 9, index)).toISOString(),
      open: close - slope * 0.2,
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

  it("structureTrend reports INSUFFICIENT_DATA with too few candles", () => {
    expect(structureTrend(rampCandles(6, 1))).toBe("INSUFFICIENT_DATA");
  });

  it("structureTrend detects UPTREND on higher-high/higher-low price", () => {
    expect(structureTrend(rampCandles(20, 2))).toBe("UPTREND");
  });

  it("structureTrend detects DOWNTREND on lower-high/lower-low price", () => {
    expect(structureTrend(rampCandles(20, -2))).toBe("DOWNTREND");
  });

  it("structureTrend reports SIDEWAY_OR_MIXED on flat price", () => {
    expect(structureTrend(rampCandles(20, 0))).toBe("SIDEWAY_OR_MIXED");
  });

  it("structureTrend can disagree with lagging EMA trend after a fresh reversal", () => {
    // 60 nến giảm rồi 20 nến tăng mạnh: EMA200 vẫn DOWN/MIXED nhưng cấu trúc đã UP.
    const down = rampCandles(60, -3, 4600);
    const reversalBase = down.at(-1)!.close;
    const up = rampCandles(20, 4, reversalBase).map((candle, index) => ({
      ...candle,
      time: new Date(Date.UTC(2026, 5, 12, index)).toISOString(),
    }));
    const series = [...down, ...up];
    expect(structureTrend(series)).toBe("UPTREND");
    expect(trend(series.map((candle) => candle.close))).not.toBe("UPTREND");
  });
});
