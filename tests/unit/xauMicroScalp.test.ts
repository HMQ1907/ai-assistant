import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  defaultEurUsdMicroScalpConfig,
  defaultXauMicroScalpConfig,
  evaluateXauMicroScalpSignal,
  microScalpConfigForSymbol,
  resolveScalpTpSl,
} from "../../server/strategy/xauMicroScalpStrategy";

const T0 = Date.parse("2026-06-01T00:00:00.000Z");

function c(
  i: number,
  o: number,
  h: number,
  l: number,
  close: number,
  stepMs = 60_000,
): Candle {
  return {
    time: new Date(T0 + i * stepMs).toISOString(),
    open: o,
    high: h,
    low: l,
    close,
    volume: 100,
  };
}

function baseM1(n = 50): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 4100 + (i % 7) * 0.15;
    return c(i, base, base + 0.5, base - 0.5, base + 0.05);
  });
}

function bullishM15(n = 80): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 4000 + i * 1.2;
    return c(i, base - 0.3, base + 0.5, base - 0.5, base, 15 * 60_000);
  });
}

function bearishM15(n = 80): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 4200 - i * 1.2;
    return c(i, base + 0.3, base + 0.5, base - 0.5, base, 15 * 60_000);
  });
}

function eurM1(n = 50): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 1.1 + (i % 7) * 0.00002;
    return c(i, base, base + 0.00005, base - 0.00005, base + 0.00001);
  });
}

function eurBullishM15(n = 80): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 1.08 + i * 0.0004;
    return c(i, base - 0.00005, base + 0.00008, base - 0.00008, base, 15 * 60_000);
  });
}

describe("micro-scalp config by symbol", () => {
  it("maps EURUSDm to pip geometry and XAU to point geometry", () => {
    expect(microScalpConfigForSymbol("EURUSDm").slPoints).toBe(0.0005);
    expect(microScalpConfigForSymbol("XAUUSDm").slPoints).toBe(5);
  });

  it("defaults SL=TP and bumps TP on strong setup (XAU + EUR)", () => {
    const xau = resolveScalpTpSl(false, defaultXauMicroScalpConfig);
    expect(xau.slPoints).toBe(5);
    expect(xau.tpPoints).toBe(5);
    expect(resolveScalpTpSl(true, defaultXauMicroScalpConfig).tpPoints).toBe(7.5);

    const eur = resolveScalpTpSl(false, defaultEurUsdMicroScalpConfig);
    expect(eur.slPoints).toBe(0.0005);
    expect(eur.tpPoints).toBe(0.0005);
    expect(resolveScalpTpSl(true, defaultEurUsdMicroScalpConfig).tpPoints).toBe(
      0.00075,
    );
  });
});

describe("xauMicroScalpStrategy (M1)", () => {
  it("emits BUY when H1+M15 above EMA50 and M1 confirms", () => {
    const h1 = Array.from({ length: 80 }, (_, i) => {
      const base = 4000 + i * 1.5;
      return c(i, base - 0.3, base + 0.5, base - 0.5, base, 60 * 60_000);
    });
    const m15 = bullishM15(80);
    const m1 = baseM1(45);
    for (let i = 30; i < 42; i += 1) {
      const p = 4090 - (i - 30) * 0.3;
      m1[i] = c(i, p + 0.2, p + 0.4, p - 0.5, p - 0.3);
    }
    m1[42] = c(42, 4085.0, 4085.2, 4083.8, 4084.0);
    m1[43] = c(43, 4084.0, 4084.1, 4082.5, 4082.7);
    m1[44] = c(44, 4082.8, 4085.2, 4082.5, 4085.0);

    const signal = evaluateXauMicroScalpSignal(m1, m15, h1);
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe("BUY");
    const tp = signal!.takeProfit - signal!.entry;
    const sl = signal!.entry - signal!.stopLoss;
    expect(sl).toBeCloseTo(5.0, 1);
    expect(tp).toBeGreaterThanOrEqual(5);
    expect(tp).toBeLessThanOrEqual(7.5);
    expect(signal!.reason).toContain("XAUUSD MICRO_SCALP");
  });

  it("emits EURUSD BUY with 5-pip SL/TP geometry", () => {
    const h1 = Array.from({ length: 80 }, (_, i) => {
      const base = 1.08 + i * 0.0005;
      return c(i, base - 0.00005, base + 0.00008, base - 0.00008, base, 60 * 60_000);
    });
    const m15 = eurBullishM15(80);
    const m1 = eurM1(45);
    for (let i = 30; i < 42; i += 1) {
      const p = 1.1 - (i - 30) * 0.00003;
      m1[i] = c(i, p + 0.00002, p + 0.00004, p - 0.00005, p - 0.00003);
    }
    m1[42] = c(42, 1.0985, 1.09852, 1.09838, 1.0984);
    m1[43] = c(43, 1.0984, 1.09841, 1.09825, 1.09827);
    m1[44] = c(44, 1.09828, 1.09852, 1.09825, 1.0985);

    const signal = evaluateXauMicroScalpSignal(
      m1,
      m15,
      h1,
      defaultEurUsdMicroScalpConfig,
    );
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe("BUY");
    expect(signal!.reason).toContain("EURUSD MICRO_SCALP");
    const sl = signal!.entry - signal!.stopLoss;
    const tp = signal!.takeProfit - signal!.entry;
    expect(sl).toBeCloseTo(0.0005, 6);
    expect(tp).toBeGreaterThanOrEqual(0.0005 - 1e-9);
    expect(tp).toBeLessThanOrEqual(0.00075 + 1e-9);
  });

  it("blocks BUY when H1 above EMA50 but M15 below EMA50", () => {
    const h1 = Array.from({ length: 80 }, (_, i) => {
      const base = 4000 + i * 1.5;
      return c(i, base - 0.3, base + 0.5, base - 0.5, base, 60 * 60_000);
    });
    const m15 = bearishM15(80);
    const m1 = baseM1(45);
    m1[43] = c(43, 4084.0, 4084.1, 4082.5, 4082.7);
    m1[44] = c(44, 4082.8, 4085.2, 4082.5, 4085.0);
    expect(evaluateXauMicroScalpSignal(m1, m15, h1)).toBeNull();
  });

  it("blocks BUY when H1 below EMA50", () => {
    const h1 = Array.from({ length: 80 }, (_, i) => {
      const base = 4200 - i * 1.5;
      return c(i, base + 0.3, base + 0.5, base - 0.5, base, 60 * 60_000);
    });
    const m1 = baseM1(45);
    m1[43] = c(43, 4084.0, 4084.1, 4082.5, 4082.7);
    m1[44] = c(44, 4082.8, 4085.2, 4082.5, 4085.0);
    expect(evaluateXauMicroScalpSignal(m1, bullishM15(80), h1)).toBeNull();
  });
});
