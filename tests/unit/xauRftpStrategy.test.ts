import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  defaultXauRftpConfig,
  explainXauRftp,
  isWithinUtcSession,
} from "../../server/strategy/xauRftpStrategy";

function candle(time: string, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { time, open, high, low, close, volume, spread: 0.2 };
}

function addMinutes(start: string, minutes: number): string {
  return new Date(Date.parse(start) + minutes * 60_000).toISOString();
}

function bullishM15(count = 260): Candle[] {
  const start = "2026-05-29T00:00:00.000Z";
  return Array.from({ length: count }, (_, index) => {
    const base = 2000 + index * 0.25;
    const halfRange = 0.7 + (index % 9) * 0.08;
    return candle(addMinutes(start, index * 15), base - 0.1, base + halfRange, base - halfRange, base + 0.2, 100 + index % 20);
  });
}

function bullishM5(): Candle[] {
  const start = "2026-06-01T06:00:00.000Z";
  const values = Array.from({ length: 58 }, (_, index) => {
    const base = 2061 + index * 0.08;
    return candle(addMinutes(start, index * 5), base - 0.05, base + 0.35, base - 0.3, base + 0.08);
  });
  // Pullback rejection followed by a momentum break.
  values[56] = candle(addMinutes(start, 56 * 5), 2065.5, 2065.9, 2064.9, 2065.75);
  values[57] = candle(addMinutes(start, 57 * 5), 2065.78, 2066.25, 2065.7, 2066.1);
  return values;
}

const testConfig = {
  ...defaultXauRftpConfig,
  atrPercentileLookbackBars: 200,
  minAtrPercentile: 0,
  maxAtrPercentile: 100,
  minStopAtr: 0.3,
  maxStopAtr: 3,
};

describe("XAU RFTP v1", () => {
  it("supports overnight and all-day UTC sessions", () => {
    expect(isWithinUtcSession(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isWithinUtcSession(6 * 60 + 59, 22 * 60, 7 * 60)).toBe(true);
    expect(isWithinUtcSession(12 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(isWithinUtcSession(12 * 60, 0, 24 * 60)).toBe(true);
  });

  it("emits a 2R BUY only after M15 regime, M5 rejection and breakout", () => {
    const result = explainXauRftp(bullishM5(), bullishM15(), [], {
      now: new Date("2026-06-01T10:50:00.000Z"),
      newsWindowClear: true,
      bid: 2066.08,
      ask: 2066.1,
      spreadPrice: 0.02,
    }, testConfig);
    expect(result.signal?.direction).toBe("BUY");
    const signal = result.signal!;
    expect((signal.takeProfit - signal.entry) / (signal.entry - signal.stopLoss)).toBeCloseTo(2, 2);
  });

  it("does not chase when the quote is too far beyond the rejection breakout", () => {
    const result = explainXauRftp(bullishM5(), bullishM15(), [], {
      now: new Date("2026-06-01T10:50:00.000Z"),
      newsWindowClear: true,
      bid: 2070,
      ask: 2070.2,
      spreadPrice: 0.2,
    }, testConfig);
    expect(result.signal).toBeNull();
    expect(result.reason).toMatch(/overextended|SL distance/);
  });

  it("blocks new entries during news blackout", () => {
    const result = explainXauRftp(bullishM5(), bullishM15(), [], {
      now: new Date("2026-06-01T10:50:00.000Z"),
      newsWindowClear: false,
    }, testConfig);
    expect(result.signal).toBeNull();
    expect(result.reason).toContain("news blackout");
  });
});
