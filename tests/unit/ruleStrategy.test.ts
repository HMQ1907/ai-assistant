import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  defaultXauIctConfig,
  evaluateXauClassicPriceActionSignal,
  evaluateXauIctSignal,
  explainXauIctRejection,
  resolveIctSession,
} from "../../server/strategy/ruleStrategy";

function c(time: string, o: number, h: number, l: number, close: number): Candle {
  return { time, open: o, high: h, low: l, close, volume: 100 };
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

const fixtureConfig = {
  ...defaultXauIctConfig,
  minStopLossAtr: 0,
  maxStopLossAtr: 10,
};

describe("resolveIctSession", () => {
  it("cho phép toàn bộ 08:00-17:59 UTC theo Frequency Mode", () => {
    const cases: Array<[string, string, boolean]> = [
      ["2026-06-01T00:00:00.000Z", "ASIA", false],
      ["2026-06-01T07:59:00.000Z", "ASIA", false],
      ["2026-06-01T08:00:00.000Z", "LONDON_OPEN", true],
      ["2026-06-01T10:29:00.000Z", "LONDON_OPEN", true],
      ["2026-06-01T10:30:00.000Z", "LONDON_CONTINUATION", true],
      ["2026-06-01T12:59:00.000Z", "LONDON_CONTINUATION", true],
      ["2026-06-01T13:00:00.000Z", "LONDON_NY_OVERLAP", true],
      ["2026-06-01T15:59:00.000Z", "LONDON_NY_OVERLAP", true],
      ["2026-06-01T16:00:00.000Z", "NY_LATE", true],
      ["2026-06-01T17:59:00.000Z", "NY_LATE", true],
      ["2026-06-01T18:00:00.000Z", "ROLLOVER_LOW_PRIORITY", false],
      ["2026-06-01T21:00:00.000Z", "ROLLOVER_LOW_PRIORITY", false],
      ["2026-06-01T23:59:00.000Z", "ROLLOVER_LOW_PRIORITY", false],
    ];
    for (const [time, label, allowed] of cases) {
      const result = resolveIctSession(new Date(time));
      expect(result.label).toBe(label);
      expect(result.allowed).toBe(allowed);
    }
  });
});

describe("evaluateXauIctSignal — edge cases", () => {
  it("returns null when there is not enough M15/H4 history", () => {
    expect(evaluateXauIctSignal([], [], [])).toBeNull();
    expect(explainXauIctRejection([], [], [])).toMatch(/candles/i);
  });

  it("returns null when H4 has no clear HH/HL or LL/LH sequence (NEUTRAL)", () => {
    const flatH4 = Array.from({ length: 30 }, (_, i) =>
      c(addMinutes("2026-06-01T00:00:00.000Z", i * 240), 2000, 2000.5, 1999.5, 2000),
    );
    const m15 = Array.from({ length: 40 }, (_, i) =>
      c(addMinutes("2026-06-01T00:00:00.000Z", i * 15), 2000, 2000.5, 1999.5, 2000),
    );
    const m5 = Array.from({ length: 5 }, (_, i) =>
      c(addMinutes("2026-06-01T00:00:00.000Z", i * 5), 2000, 2000.5, 1999.5, 2000),
    );
    expect(evaluateXauIctSignal(m5, m15, flatH4)).toBeNull();
    expect(explainXauIctRejection(m5, m15, flatH4)).toMatch(/NEUTRAL/);
  });
});

describe("evaluateXauClassicPriceActionSignal", () => {
  it("phát BUY sau M15 quét đáy và M5 nến từ chối, đồng thời nhận RR cấu hình", () => {
    const start = "2026-06-01T08:00:00.000Z";
    const m15 = Array.from({ length: 8 }, (_, i) => c(addMinutes(start, i * 15), 100, 101, 99, 100));
    m15[7] = c(m15[7]!.time, 99.5, 101.2, 98.5, 100.9);
    const m5 = Array.from({ length: 8 }, (_, i) => c(addMinutes("2026-06-01T09:10:00.000Z", i * 5), 100, 100.4, 99.5, 100.1));
    m5[7] = c(m5[7]!.time, 99.2, 100.8, 98.9, 100.7);
    const h1 = Array.from({ length: 8 }, (_, i) => c(addMinutes(start, i * 60), 100, 101, 99, 100));

    const signal = evaluateXauClassicPriceActionSignal(m5, m15, h1, { now: new Date("2026-06-01T09:45:00.000Z") }, {
      sweepLookbackM15: 6,
      m15CloseEdgeMax: 0.25,
      m5MinBodyRatio: 0.35,
      m5CloseEdgeMax: 0.25,
      stopAtrBuffer: 0.15,
      targetR: 1,
    });
    expect(signal?.direction).toBe("BUY");
    expect((signal!.takeProfit - signal!.entry) / (signal!.entry - signal!.stopLoss)).toBeCloseTo(1, 2);
  });
});

/**
 * Fixture v0.1: H4 bullish (HH/HL) -> M15 bullish liquidity sweep -> displacement
 * + M15 BOS (không ATR) -> retest zone [BOS_LEVEL, BOS_LEVEL+50%thân displacement]
 * -> M5 rejection tại 09:35 UTC (LONDON_OPEN, 5 phút sau khi displacement đóng).
 */
function buildBullishFixture(): { m5: Candle[]; m15: Candle[]; h4: Candle[] } {
  // ----- H4: zigzag tăng, 3 swing high (110/120/130) + 3 swing low (90/100/110). -----
  const h4Start = "2026-05-20T00:00:00.000Z";
  const h4Spec: Array<[number, number, number]> = [
    // [high, low, close]
    [96, 90, 93],
    [101, 95, 98],
    [110, 99, 105], // swing high #1
    [106, 100, 103],
    [103, 97, 100],
    [100, 90, 95], // swing low #1
    [108, 95, 102],
    [115, 98, 110],
    [120, 108, 115], // swing high #2
    [116, 105, 110],
    [112, 103, 106],
    [109, 100, 104], // swing low #2
    [114, 104, 110],
    [122, 108, 118],
    [130, 112, 122], // swing high #3
    [126, 115, 121],
    [120, 112, 116],
    [119, 110, 115], // swing low #3
    [124, 114, 120],
    [132, 122, 128], // forming, chưa confirm
  ];
  const h4 = h4Spec.map(([high, low, close], i) =>
    c(addMinutes(h4Start, i * 240), (high + low) / 2, high, low, close),
  );

  // ----- M15: 40 nến, baseline ~2002, dip swing-low tại idx20 (2000.5, mục tiêu
  // sweep), swing-high tại idx30 (2005.0, = BOS_LEVEL), sweep idx35, displacement
  // idx38 (thân 5.0 -> zone = [2005.0, 2007.5]). idx39 phải đóng TRÊN BOS_LEVEL để
  // không tự vô hiệu hoá setup (§5: giá đóng xuyên ngược qua BOS -> invalid). -----
  const m15Start = "2026-06-01T00:00:00.000Z"; // -> displacement (idx38) rơi vào 09:30Z
  const m15: Candle[] = [];
  for (let i = 0; i < 40; i += 1) {
    const level = 2002;
    m15.push(c(addMinutes(m15Start, i * 15), level - 0.3, level + 0.5, level - 0.5, level + 0.2));
  }
  m15[20] = c(m15[20]!.time, 2000.9, 2001.0, 2000.5, 2000.9);
  m15[30] = c(m15[30]!.time, 2002.5, 2005.0, 2002.0, 2002.8);
  m15[35] = c(m15[35]!.time, 2000.55, 2000.65, 2000.2, 2000.6);
  m15[36] = c(m15[36]!.time, 2000.65, 2000.8, 2000.6, 2000.7);
  m15[37] = c(m15[37]!.time, 2000.7, 2000.85, 2000.6, 2000.75);
  m15[38] = c(m15[38]!.time, 2001.0, 2006.1, 2000.9, 2006.0);
  m15[39] = c(m15[39]!.time, 2006.0, 2006.5, 2005.8, 2006.3);

  // ----- M5: 1 nến filler + 1 nến rejection chạm zone [2005.0, 2007.5], đóng lại
  // trên zoneLow với close gần đỉnh range (rejection bullish). -----
  const m5: Candle[] = [
    c("2026-06-01T09:45:00.000Z", 2006.0, 2006.2, 2005.9, 2006.1),
    c("2026-06-01T09:50:00.000Z", 2005.3, 2006.6, 2005.1, 2006.5),
  ];

  return { m5, m15, h4 };
}

describe("evaluateXauIctSignal — full PA v0.1 chain (happy path)", () => {
  it("phát BUY khi sweep + displacement + M15 BOS + retest zone + M5 rejection đều hợp lệ trong session cho phép", () => {
    const { m5, m15, h4 } = buildBullishFixture();
    const signal = evaluateXauIctSignal(m5, m15, h4, h4, fixtureConfig, {
      now: new Date("2026-06-01T09:50:00.000Z"),
      newsWindowClear: true,
    });
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe("BUY");
    expect(signal!.entry).toBeCloseTo(2006.5, 2);
    expect(signal!.stopLoss).toBeLessThan(signal!.entry);
    expect(signal!.takeProfit).toBeGreaterThan(signal!.entry);
    const rr = (signal!.takeProfit - signal!.entry) / (signal!.entry - signal!.stopLoss);
    expect(rr).toBeCloseTo(fixtureConfig.minTargetR, 2);
    expect(signal!.strategyKind).toBe("ICT_SETUP");
  });

  it("KHÔNG phát tín hiệu nếu nến trigger rơi ngoài session cho phép (final-time gate, không cache)", () => {
    const { m5, m15, h4 } = buildBullishFixture();
    // Cùng dữ liệu hệt happy-path, chỉ đổi `now` sang sau 18:00 UTC (không cho phép).
    const options = { now: new Date("2026-06-01T18:05:00.000Z"), newsWindowClear: true };
    expect(evaluateXauIctSignal(m5, m15, h4, h4, fixtureConfig, options)).toBeNull();
    expect(explainXauIctRejection(m5, m15, h4, h4, fixtureConfig, options)).toMatch(/session/i);
  });

  it("KHÔNG phát tín hiệu khi đang trong news blackout tại thời điểm trigger", () => {
    const { m5, m15, h4 } = buildBullishFixture();
    const options = { now: new Date("2026-06-01T09:35:00.000Z"), newsWindowClear: false };
    expect(evaluateXauIctSignal(m5, m15, h4, h4, fixtureConfig, options)).toBeNull();
    expect(explainXauIctRejection(m5, m15, h4, h4, fixtureConfig, options)).toMatch(/news/i);
  });

  it("KHÔNG phát tín hiệu nếu M15 đã đóng xuyên ngược qua mức BOS trước khi retest (setup invalidated, §5)", () => {
    const { m5, m15, h4 } = buildBullishFixture();
    // Thêm 1 nến M15 sau displacement đóng NGƯỢC xuống dưới BOS_LEVEL (2005.0).
    const invalidated = [...m15, c(addMinutes(m15[39]!.time, 15), 2004.0, 2004.5, 2003.5, 2004.0)];
    const options = { now: new Date("2026-06-01T09:35:00.000Z"), newsWindowClear: true };
    expect(evaluateXauIctSignal(m5, invalidated, h4, h4, fixtureConfig, options)).toBeNull();
    expect(explainXauIctRejection(m5, invalidated, h4, h4, fixtureConfig, options)).toMatch(/xuyên ngược/i);
  });

  it("KHÔNG phát tín hiệu nếu retest quá hạn (> retestExpiryM5Bars nến M5 sau displacement)", () => {
    const { m5, m15, h4 } = buildBullishFixture();
    const lateTrigger = Array.from({ length: 10 }, (_, index) =>
      c(addMinutes("2026-06-01T09:50:00.000Z", index * 5), 2005.3, 2006.6, 2005.1, 2006.5),
    );
    const options = { now: new Date("2026-06-01T10:15:00.000Z"), newsWindowClear: true };
    expect(evaluateXauIctSignal(lateTrigger, m15, h4, h4, fixtureConfig, options)).toBeNull();
    expect(explainXauIctRejection(lateTrigger, m15, h4, h4, fixtureConfig, options)).toMatch(/retest quá hạn/i);
  });
});
