import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  defaultRuleStrategyConfig,
  evaluateRuleSignal,
} from "../../server/strategy/ruleStrategy";

const H1_START = Date.parse("2026-01-01T00:00:00.000Z");

function candle(index: number, hours: number, o: number, h: number, l: number, c: number): Candle {
  return {
    time: new Date(H1_START + index * hours * 3_600_000).toISOString(),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
  };
}

// H4 tăng đều -> trend() = UPTREND (ema20>ema50>ema200).
function uptrendH4(n = 260): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 50 + i * 0.5;
    return candle(i, 4, base - 0.2, base + 0.3, base - 0.3, base);
  });
}

function downtrendH4(n = 260): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 350 - i * 0.5;
    return candle(i, 4, base + 0.2, base + 0.3, base - 0.3, base);
  });
}

// H1: tăng đều -> hồi nhẹ về EMA -> nến xác nhận tăng phá đỉnh nến trước.
function buySetupH1(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 70; i += 1) {
    const base = 100 + i * 0.5;
    out.push(candle(i, 1, base - 0.2, base + 0.3, base - 0.3, base));
  }
  // pullback
  const dips = [134, 132.5, 131.5, 131, 130.8];
  dips.forEach((close, k) => {
    const i = 70 + k;
    out.push(candle(i, 1, close + 0.5, close + 0.6, close - 0.5, close));
  });
  // confirmation: bullish, close trên EMA và phá đỉnh nến trước
  out.push(candle(75, 1, 131, 135.4, 130.6, 135));
  return out;
}

function sellSetupH1(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 70; i += 1) {
    const base = 200 - i * 0.5;
    out.push(candle(i, 1, base + 0.2, base + 0.3, base - 0.3, base));
  }
  const rallies = [166, 167.5, 168.5, 169, 169.2];
  rallies.forEach((close, k) => {
    const i = 70 + k;
    out.push(candle(i, 1, close - 0.5, close + 0.5, close - 0.6, close));
  });
  out.push(candle(75, 1, 169, 169.4, 164.6, 165));
  return out;
}

describe("evaluateRuleSignal", () => {
  it("returns null when H4 bias is not clearly trending", () => {
    const flatH4 = Array.from({ length: 260 }, (_, i) =>
      candle(i, 4, 100, 100.5, 99.5, 100),
    );
    expect(evaluateRuleSignal(buySetupH1(), flatH4)).toBeNull();
  });

  it("returns null when there is not enough history", () => {
    expect(evaluateRuleSignal(buySetupH1().slice(-30), uptrendH4())).toBeNull();
  });

  it("produces a geometrically valid BUY in an H4 uptrend pullback", () => {
    const signal = evaluateRuleSignal(buySetupH1(), uptrendH4());
    expect(signal).not.toBeNull();
    expect(signal?.direction).toBe("BUY");
    expect(signal!.stopLoss).toBeLessThan(signal!.entry);
    expect(signal!.takeProfit).toBeGreaterThan(signal!.entry);
    const rr =
      (signal!.takeProfit - signal!.entry) / (signal!.entry - signal!.stopLoss);
    expect(rr).toBeCloseTo(defaultRuleStrategyConfig.rrTarget, 1);
  });

  it("produces a geometrically valid SELL in an H4 downtrend pullback", () => {
    const signal = evaluateRuleSignal(sellSetupH1(), downtrendH4());
    expect(signal).not.toBeNull();
    expect(signal?.direction).toBe("SELL");
    expect(signal!.stopLoss).toBeGreaterThan(signal!.entry);
    expect(signal!.takeProfit).toBeLessThan(signal!.entry);
    const rr =
      (signal!.entry - signal!.takeProfit) / (signal!.stopLoss - signal!.entry);
    expect(rr).toBeCloseTo(defaultRuleStrategyConfig.rrTarget, 1);
  });

  it("does not BUY against an H4 downtrend", () => {
    // Setup BUY trên H1 nhưng bias H4 giảm -> không được trade ngược bias.
    expect(evaluateRuleSignal(buySetupH1(), downtrendH4())).toBeNull();
  });
});
