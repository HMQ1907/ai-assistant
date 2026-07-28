import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  defaultEurUsdMicroScalpConfig,
  defaultXauMicroScalpConfig,
  evaluateXauMicroScalpSignal,
  microScalpConfigForSymbol,
  resolveFormingH1AdverseBlock,
  resolveScalpTpSl,
  resolveStructureTp,
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
    expect(microScalpConfigForSymbol("EURUSDm").minSlDistance).toBe(0.0005);
    expect(microScalpConfigForSymbol("XAUUSDm").minSlDistance).toBe(3.5);
  });

  it("sizes SL from ATR and targets RR ~1.3 (strong 1.5)", () => {
    // ATR quá nhỏ → SL rơi về sàn minSlDistance, TP = SL × rrTarget.
    const xauFloor = resolveScalpTpSl(false, defaultXauMicroScalpConfig, 0.5);
    expect(xauFloor.slPoints).toBe(3.5);
    expect(xauFloor.rr).toBeCloseTo(1.3, 3);
    expect(xauFloor.tpPoints).toBeCloseTo(4.55, 3);

    // ATR vừa → SL = ATR × slAtrMult (2.2) trong khoảng [3.5, 6].
    const xauAtr = resolveScalpTpSl(false, defaultXauMicroScalpConfig, 2.0);
    expect(xauAtr.slPoints).toBeCloseTo(4.4, 3);
    expect(xauAtr.tpPoints).toBeCloseTo(5.72, 2);

    // ATR lớn → SL bị chặn trần maxSlDistance.
    const xauCap = resolveScalpTpSl(false, defaultXauMicroScalpConfig, 10);
    expect(xauCap.slPoints).toBe(6);

    // Setup mạnh dùng strongRr = 1.5.
    const xauStrong = resolveScalpTpSl(true, defaultXauMicroScalpConfig, 2.0);
    expect(xauStrong.rr).toBeCloseTo(1.5, 3);
    expect(xauStrong.tpPoints / xauStrong.slPoints).toBeCloseTo(1.5, 3);

    const eur = resolveScalpTpSl(false, defaultEurUsdMicroScalpConfig, 0.00001);
    expect(eur.slPoints).toBeCloseTo(0.0005, 6);
    expect(eur.tpPoints / eur.slPoints).toBeCloseTo(1.3, 3);
  });

  it("mở rộng SL theo cấu trúc khi swing xa hơn ATR, vẫn chặn ở trần", () => {
    // ATR nhỏ (1.0×2.2=2.2) nhưng khoảng cấu trúc 5.0 → lấy 5.0.
    const struct = resolveScalpTpSl(false, defaultXauMicroScalpConfig, 1.0, 5.0);
    expect(struct.slPoints).toBe(5);
    expect(struct.tpPoints).toBeCloseTo(6.5, 3);

    // Cấu trúc quá xa (20) → chặn ở trần maxSlDistance = 6.
    const capped = resolveScalpTpSl(false, defaultXauMicroScalpConfig, 1.0, 20);
    expect(capped.slPoints).toBe(6);

    // Cấu trúc nhỏ hơn ATR → dùng ATR (2.0×2.2=4.4).
    const atrWins = resolveScalpTpSl(false, defaultXauMicroScalpConfig, 2.0, 1.0);
    expect(atrWins.slPoints).toBeCloseTo(4.4, 3);
  });
});

describe("resolveStructureTp (TP theo cấu trúc M5)", () => {
  const cfg = defaultXauMicroScalpConfig;

  function m5With(low: number, high: number, n = 20): Candle[] {
    return Array.from({ length: n }, (_, i) =>
      c(i, (low + high) / 2, high, low, (low + high) / 2, 5 * 60_000),
    );
  }

  it("nhắm đáy swing M5 cho SELL khi RR mốc đạt ngưỡng", () => {
    const res = resolveStructureTp({
      config: cfg,
      direction: "SELL",
      entry: 4092.19,
      slPoints: 4.279,
      m1Atr: 2.0,
      m5: m5With(4086, 4095),
    });
    expect(res).not.toBeNull();
    // target = 4086 + 0.3×2.0 = 4086.6 -> tpDist = 5.59 -> RR ~1.31
    expect(res!.tpPoints).toBeCloseTo(5.59, 2);
    expect(res!.rr).toBeCloseTo(1.31, 2);
  });

  it("fallback (null) khi mốc cấu trúc quá gần, RR < ngưỡng", () => {
    const res = resolveStructureTp({
      config: cfg,
      direction: "SELL",
      entry: 4092.19,
      slPoints: 4.279,
      m1Atr: 2.0,
      m5: m5With(4090.5, 4095),
    });
    expect(res).toBeNull();
  });

  it("chặn TP ở tpStructureMaxRr khi mốc quá xa", () => {
    const res = resolveStructureTp({
      config: cfg,
      direction: "SELL",
      entry: 4092.19,
      slPoints: 4.279,
      m1Atr: 2.0,
      m5: m5With(4060, 4095),
    });
    expect(res).not.toBeNull();
    expect(res!.rr).toBeCloseTo(3.0, 3);
    expect(res!.tpPoints).toBeCloseTo(4.279 * 3, 2);
  });

  it("null khi thiếu dữ liệu M5", () => {
    const res = resolveStructureTp({
      config: cfg,
      direction: "SELL",
      entry: 4092.19,
      slPoints: 4.279,
      m1Atr: 2.0,
      m5: m5With(4086, 4095, 5),
    });
    expect(res).toBeNull();
  });
});

describe("resolveFormingH1AdverseBlock", () => {
  const cfg = defaultXauMicroScalpConfig;

  function flatH1(close: number, n = 60): Candle[] {
    return Array.from({ length: n }, (_, i) =>
      c(i, close, close + 0.5, close - 0.5, close, 60 * 60_000),
    );
  }

  it("chặn SELL khi entry đã hồi xa trên open H1 đang chạy", () => {
    // Open≈4043, entry 4053.4 (~+10), SL 5.1 → threshold max(ATR×0.6, 5.1×0.8)
    const h1 = flatH1(4043.3);
    const block = resolveFormingH1AdverseBlock({
      config: cfg,
      direction: "SELL",
      entry: 4053.4,
      slPoints: 5.1,
      h1,
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("forming H1 adverse");
  });

  it("cho phép SELL khi hồi nông dưới ngưỡng", () => {
    const h1 = flatH1(4050);
    const block = resolveFormingH1AdverseBlock({
      config: cfg,
      direction: "SELL",
      entry: 4051.5, // chỉ +1.5
      slPoints: 5.0,
      h1,
    });
    expect(block).toBeNull();
  });

  it("chặn BUY khi entry đã dump xa dưới open H1 đang chạy", () => {
    const h1 = flatH1(4100);
    const block = resolveFormingH1AdverseBlock({
      config: cfg,
      direction: "BUY",
      entry: 4090,
      slPoints: 5.0,
      h1,
    });
    expect(block).not.toBeNull();
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

    // Nới filter H1 đang chạy + tắt trend-day — case này test entry/SL/TP.
    const looseH1 = {
      ...defaultXauMicroScalpConfig,
      formingH1AdverseAtrMult: 50,
      formingH1AdverseSlMult: 50,
      trendDayEnabled: false,
    };
    const signal = evaluateXauMicroScalpSignal(m1, m15, h1, looseH1);
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe("BUY");
    const tp = signal!.takeProfit - signal!.entry;
    const sl = signal!.entry - signal!.stopLoss;
    expect(sl).toBeGreaterThanOrEqual(3.5 - 1e-6);
    expect(sl).toBeLessThanOrEqual(6 + 1e-6);
    expect(tp / sl).toBeGreaterThanOrEqual(1.3 - 1e-3);
    expect(tp / sl).toBeLessThanOrEqual(1.5 + 1e-3);
    expect(signal!.reason).toContain("XAUUSD MICRO_SCALP");
  });

  it("emits EURUSD BUY with ATR SL/TP geometry", () => {
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

    const looseH1 = {
      ...defaultEurUsdMicroScalpConfig,
      formingH1AdverseAtrMult: 50,
      formingH1AdverseSlMult: 50,
      trendDayEnabled: false,
    };
    const signal = evaluateXauMicroScalpSignal(m1, m15, h1, looseH1);
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe("BUY");
    expect(signal!.reason).toContain("EURUSD MICRO_SCALP");
    const sl = signal!.entry - signal!.stopLoss;
    const tp = signal!.takeProfit - signal!.entry;
    expect(sl).toBeGreaterThanOrEqual(0.0005 - 1e-9);
    expect(sl).toBeLessThanOrEqual(0.0008 + 1e-9);
    expect(tp / sl).toBeGreaterThanOrEqual(1.3 - 1e-3);
    expect(tp / sl).toBeLessThanOrEqual(1.5 + 1e-3);
  });

  it("blocks SELL when forming H1 already rallied hard (như lệnh 21:28)", () => {
    // H1 đóng dưới EMA50 (SELL bias), nhưng giá M1 đã hồi +10 từ close H1.
    const h1 = Array.from({ length: 80 }, (_, i) => {
      const base = 4200 - i * 1.5;
      return c(i, base + 0.3, base + 0.5, base - 0.5, base, 60 * 60_000);
    });
    const m15 = bearishM15(80);
    const h1Last = h1.at(-1)!.close; // ~4081.5
    const m1 = Array.from({ length: 45 }, (_, i) => {
      const base = h1Last + 8 + (i % 5) * 0.1;
      return c(i, base, base + 0.4, base - 0.4, base - 0.05);
    });
    // Bearish confirm candle nhưng entry đã cao hơn open H1 ~10 điểm.
    m1[43] = c(43, h1Last + 11.0, h1Last + 11.2, h1Last + 10.0, h1Last + 10.2);
    m1[44] = c(44, h1Last + 10.2, h1Last + 10.3, h1Last + 9.5, h1Last + 9.6);
    expect(evaluateXauMicroScalpSignal(m1, m15, h1)).toBeNull();
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

  it("blocks BUY when trend-day filter fails (no H4 / no Asia break)", () => {
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

    const looseH1 = {
      ...defaultXauMicroScalpConfig,
      formingH1AdverseAtrMult: 50,
      formingH1AdverseSlMult: 50,
      trendDayEnabled: true,
    };
    expect(evaluateXauMicroScalpSignal(m1, m15, h1, looseH1, [], [])).toBeNull();
  });
});
