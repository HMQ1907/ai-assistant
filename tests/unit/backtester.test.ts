import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import { defaultBacktestConfig, runBacktest } from "../../server/backtest/backtester";

const H1_START = Date.parse("2026-01-01T00:00:00.000Z");

function mk(timeMs: number, o: number, h: number, l: number, c: number): Candle {
  return { time: new Date(timeMs).toISOString(), open: o, high: h, low: l, close: c, volume: 100 };
}

// H4 tăng đều, bắt đầu sớm hơn H1 800 giờ để có sẵn >=200 nến lịch sử khi backtest chạy.
function uptrendH4(): Candle[] {
  const start = H1_START - 800 * 3_600_000;
  return Array.from({ length: 600 }, (_, i) => {
    const base = 40 + i * 0.4;
    return mk(start + i * 4 * 3_600_000, base - 0.2, base + 0.3, base - 0.3, base);
  });
}

// H1 răng cưa trong xu hướng tăng: mỗi chu kỳ tăng -> hồi về EMA -> nến xác nhận tăng.
function sawtoothUptrendH1(cycles = 60): Candle[] {
  const out: Candle[] = [];
  let idx = 0;
  for (let cyc = 0; cyc < cycles; cyc += 1) {
    const level = 100 + cyc * 6;
    for (let k = 0; k < 13; k += 1) {
      const base = level + k * 0.9;
      out.push(mk(H1_START + idx++ * 3_600_000, base - 0.2, base + 0.3, base - 0.3, base));
    }
    const dips = [level + 9, level + 7, level + 5.5, level + 5, level + 4.8];
    for (const close of dips) {
      out.push(mk(H1_START + idx++ * 3_600_000, close + 0.5, close + 0.6, close - 0.6, close));
    }
    const confirmClose = level + 13;
    out.push(mk(H1_START + idx++ * 3_600_000, level + 5, confirmClose + 0.3, level + 4.7, confirmClose));
    out.push(mk(H1_START + idx++ * 3_600_000, confirmClose, confirmClose + 0.8, confirmClose - 0.4, confirmClose + 0.5));
  }
  return out;
}

describe("runBacktest", () => {
  const result = runBacktest("TESTUSD", sawtoothUptrendH1(), uptrendH4(), defaultBacktestConfig);

  it("generates trades on a trending dataset", () => {
    expect(result.trades).toBeGreaterThan(0);
  });

  it("keeps outcome counts internally consistent", () => {
    expect(result.wins + result.losses + result.expired).toBe(result.trades);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(100);
  });

  it("totalR equals the sum of per-trade R multiples", () => {
    const sumR = result.tradeList.reduce((s, t) => s + t.rMultiple, 0);
    expect(result.totalR).toBeCloseTo(Number(sumR.toFixed(3)), 2);
  });

  it("every trade has valid SL/TP geometry for its direction", () => {
    for (const trade of result.tradeList) {
      if (trade.direction === "BUY") {
        expect(trade.stopLoss).toBeLessThan(trade.entry);
        expect(trade.takeProfit).toBeGreaterThan(trade.entry);
      } else {
        expect(trade.stopLoss).toBeGreaterThan(trade.entry);
        expect(trade.takeProfit).toBeLessThan(trade.entry);
      }
    }
  });

  it("expectancyR is finite and equals totalR / trades", () => {
    expect(Number.isFinite(result.expectancyR)).toBe(true);
    if (result.trades > 0) {
      expect(result.expectancyR).toBeCloseTo(
        Number((result.totalR / result.trades).toFixed(3)),
        2,
      );
    }
  });
});
