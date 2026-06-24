import { describe, expect, it } from "vitest";
import type { Candle } from "../../types/trading";
import {
  evaluateSignalOutcome,
  type OutcomeSignalInput,
} from "../../server/utils/signalOutcome";

const CREATED = "2026-06-23T14:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(CREATED) + minutes * 60_000).toISOString();
}

function candle(
  minutes: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { time: at(minutes), open, high, low, close, volume: 100 };
}

function sellSignal(patch: Partial<OutcomeSignalInput> = {}): OutcomeSignalInput {
  return {
    direction: "SELL",
    orderType: "SELL_LIMIT",
    entryFrom: 4123,
    entryTo: 4125.5,
    stopLoss: 4141,
    takeProfit: 4095,
    createdAt: CREATED,
    cancelAfterMinutes: 120,
    maxHoldingMinutes: 240,
    ...patch,
  };
}

describe("evaluateSignalOutcome", () => {
  it("flags swept-then-reversed when SL is hit first but price later reaches TP (the yesterday case)", () => {
    const candles = [
      candle(0, 4117, 4119, 4116, 4118), // chua cham entry
      candle(5, 4118, 4126, 4120, 4124), // khop entry
      candle(10, 4124, 4143, 4130, 4140), // quet SL 4141 truoc
      candle(15, 4140, 4141, 4090, 4092), // sau do roi toi TP 4095
    ];
    const result = evaluateSignalOutcome(sellSignal(), candles, at(60));

    expect(result.outcome).toBe("LOSS");
    expect(result.filled).toBe(true);
    expect(result.firstHit).toBe("SL");
    expect(result.sweptThenReversed).toBe(true);
    expect(result.mae).toBeCloseTo(18.75, 2); // 4143 - 4124.25
  });

  it("is WIN when TP is reached before SL", () => {
    const candles = [
      candle(5, 4118, 4126, 4120, 4124), // khop
      candle(10, 4124, 4126, 4096, 4100), // gan TP
      candle(15, 4100, 4101, 4094, 4095), // cham TP 4095 truoc khi cham SL
    ];
    const result = evaluateSignalOutcome(sellSignal(), candles, at(60));

    expect(result.outcome).toBe("WIN");
    expect(result.firstHit).toBe("TP");
    expect(result.sweptThenReversed).toBe(false);
  });

  it("is NOT_FILLED when price never touches the entry zone before the cancel window ends", () => {
    const candles = [
      candle(0, 4117, 4119, 4116, 4118),
      candle(60, 4110, 4112, 4105, 4108), // giam, khong bao gio len vung entry
    ];
    const result = evaluateSignalOutcome(sellSignal(), candles, at(150));

    expect(result.outcome).toBe("NOT_FILLED");
    expect(result.filled).toBe(false);
  });

  it("stays PENDING when unfilled but still inside the cancel window", () => {
    const candles = [candle(0, 4117, 4119, 4116, 4118)];
    const result = evaluateSignalOutcome(sellSignal(), candles, at(30));

    expect(result.outcome).toBe("PENDING");
  });

  it("is OPEN when filled but neither SL nor TP hit yet, still inside hold window", () => {
    const candles = [
      candle(5, 4118, 4126, 4120, 4124), // khop
      candle(10, 4124, 4128, 4118, 4122), // chua cham SL/TP
    ];
    const result = evaluateSignalOutcome(sellSignal(), candles, at(30));

    expect(result.outcome).toBe("OPEN");
    expect(result.filled).toBe(true);
  });

  it("is EXPIRED when filled but hold window elapses without hitting SL/TP", () => {
    const candles = [
      candle(5, 4118, 4126, 4120, 4124), // khop luc 14:05
      candle(250, 4124, 4130, 4118, 4126), // qua maxHolding 240' tinh tu khop
    ];
    const result = evaluateSignalOutcome(sellSignal(), candles, at(300));

    expect(result.outcome).toBe("EXPIRED");
  });

  it("fills a MARKET order immediately at signal time", () => {
    const candles = [
      candle(5, 4124, 4126, 4118, 4122),
      candle(10, 4122, 4124, 4094, 4096), // cham TP
    ];
    const result = evaluateSignalOutcome(
      sellSignal({ orderType: "MARKET" }),
      candles,
      at(60),
    );

    expect(result.filled).toBe(true);
    expect(result.outcome).toBe("WIN");
  });
});
