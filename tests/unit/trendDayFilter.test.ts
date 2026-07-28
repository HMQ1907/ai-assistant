import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  computeAsiaSessionRange,
  resolveTrendDayBlock,
} from "../../server/strategy/trendDayFilter";

/** 2026-07-23 17:00 Asia/Saigon = 10:00 UTC (sau phiên Á). */
const NOW = new Date("2026-07-23T10:00:00.000Z");

function h1AtUtc(
  hourUtc: number,
  o: number,
  h: number,
  l: number,
  close: number,
  day = "2026-07-23",
): Candle {
  const hh = String(hourUtc).padStart(2, "0");
  return {
    time: `${day}T${hh}:00:00.000Z`,
    open: o,
    high: h,
    low: l,
    close,
    volume: 100,
  };
}

function risingH4(n = 70, start = 3900, step = 2): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = start + i * step;
    return {
      time: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 4 * 3600_000).toISOString(),
      open: base - 0.5,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: 100,
    };
  });
}

function fallingH4(n = 70, start = 4200, step = 2): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = start - i * step;
    return {
      time: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 4 * 3600_000).toISOString(),
      open: base + 0.5,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: 100,
    };
  });
}

/** H1: warmup EMA + Asia 07–14 Saigon (= 00–07 UTC) range 4000–4010. */
function asiaRangeH1(lastClose = 4005): Candle[] {
  const warmup = Array.from({ length: 60 }, (_, i) => {
    const base = 3990 + i * 0.2;
    return {
      time: new Date(
        Date.parse("2026-07-20T00:00:00.000Z") + i * 3600_000,
      ).toISOString(),
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base,
      volume: 100,
    };
  });
  // Asia: 00–06 UTC on 2026-07-23 → 07–13 Saigon
  const asia = [0, 1, 2, 3, 4, 5, 6].map((hour) =>
    h1AtUtc(hour, 4005, 4010, 4000, 4005),
  );
  // Current H1 (after Asia) for stretch / entry context
  const current = h1AtUtc(9, lastClose, lastClose + 0.5, lastClose - 0.5, lastClose);
  return [...warmup, ...asia, current];
}

describe("computeAsiaSessionRange", () => {
  it("lấy high/low phiên Á cùng ngày theo Asia/Saigon", () => {
    const h1 = asiaRangeH1();
    const range = computeAsiaSessionRange(h1, NOW);
    expect(range).not.toBeNull();
    expect(range!.dayKey).toBe("2026-07-23");
    expect(range!.high).toBe(4010);
    expect(range!.low).toBe(4000);
    expect(range!.barCount).toBe(7);
  });
});

describe("resolveTrendDayBlock", () => {
  it("cho phép BUY khi H4 uptrend + phá Asia high", () => {
    const h1 = asiaRangeH1(4012);
    const block = resolveTrendDayBlock({
      direction: "BUY",
      entry: 4012,
      h1,
      h4: risingH4(),
      now: NOW,
    });
    expect(block).toBeNull();
  });

  it("cho phép BUY khi H4 uptrend + H1 stretch vs EMA50 (không cần phá Asia)", () => {
    // Asia vẫn 4000–4010 nhưng H1 close đã kéo xa EMA nhờ warmup + jump lớn
    const warmup = Array.from({ length: 60 }, (_, i) => {
      const base = 3900 + i * 0.05;
      return {
        time: new Date(
          Date.parse("2026-07-20T00:00:00.000Z") + i * 3600_000,
        ).toISOString(),
        open: base,
        high: base + 0.3,
        low: base - 0.3,
        close: base,
        volume: 100,
      };
    });
    const asia = [0, 1, 2, 3, 4, 5, 6].map((hour) =>
      h1AtUtc(hour, 3905, 3910, 3900, 3905),
    );
    // ATR nhỏ (~0.6), close 3920 → |close-EMA|/ATR lớn
    const current = h1AtUtc(9, 3918, 3921, 3917, 3920);
    const h1 = [...warmup, ...asia, current];

    const block = resolveTrendDayBlock({
      direction: "BUY",
      entry: 3920,
      h1,
      h4: risingH4(70, 3800, 1),
      now: NOW,
      config: { minEmaDistAtrMult: 0.5 },
    });
    expect(block).toBeNull();
  });

  it("chặn BUY khi H4 chưa uptrend", () => {
    const h1 = asiaRangeH1(4012);
    const block = resolveTrendDayBlock({
      direction: "BUY",
      entry: 4012,
      h1,
      h4: fallingH4(),
      now: NOW,
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("H4");
  });

  it("chặn BUY khi H4 ok nhưng chưa phá Asia và chưa stretch", () => {
    const h1 = asiaRangeH1(4005);
    const block = resolveTrendDayBlock({
      direction: "BUY",
      entry: 4005,
      h1,
      h4: risingH4(),
      now: NOW,
      config: { minEmaDistAtrMult: 5 },
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("Asia");
  });

  it("cho phép SELL khi H4 downtrend + phá Asia low", () => {
    const h1 = asiaRangeH1(3995);
    const block = resolveTrendDayBlock({
      direction: "SELL",
      entry: 3995,
      h1,
      h4: fallingH4(),
      now: NOW,
    });
    expect(block).toBeNull();
  });

  it("tắt filter khi enabled=false", () => {
    const block = resolveTrendDayBlock({
      direction: "BUY",
      entry: 4000,
      h1: [],
      h4: [],
      config: { enabled: false },
    });
    expect(block).toBeNull();
  });
});
