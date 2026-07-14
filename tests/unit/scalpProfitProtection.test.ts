import { describe, expect, it } from "vitest";
import type { ActiveMt5Order, MarketSnapshot } from "../../types/trading";
import {
  checkAggregateDailyRisk,
  estimateRemainingOrderDownsideUsd,
  resolveDailyLossLimitUsd,
  scalpProfitProtectionStop,
} from "../../server/services/AutoTradeRunner";

function sellOrder(stopLoss = 1.101): ActiveMt5Order {
  return {
    ticket: 1,
    state: "FILLED",
    symbol: "EURUSDm",
    type: "SELL",
    direction: "SELL",
    volume: 0.05,
    price_open: 1.1,
    stop_loss: stopLoss,
    take_profit: 1.098,
    profit: 0,
    opened_at: new Date().toISOString(),
    comment: "scalp-m1",
  };
}

function snapshot(price: number, spread = 0.0001): MarketSnapshot {
  return { price, spread } as MarketSnapshot;
}

describe("scalpProfitProtectionStop", () => {
  it("moves a SELL stop to spread-adjusted break-even at 1R", () => {
    expect(scalpProfitProtectionStop(sellOrder(), snapshot(1.099), 2)).toEqual({
      stopLoss: 1.0999,
      stage: "1r",
    });
  });

  it("locks about 0.5R once a SELL reaches 1.5R", () => {
    expect(scalpProfitProtectionStop(sellOrder(1.0999), snapshot(1.0985), 2)).toEqual({
      stopLoss: 1.0994,
      stage: "1.5r",
    });
  });

  it("does not repeatedly modify an already protected stop", () => {
    expect(scalpProfitProtectionStop(sellOrder(1.0994), snapshot(1.0985), 2)).toBeNull();
  });

  it("protects a BUY symmetrically", () => {
    const order: ActiveMt5Order = {
      ...sellOrder(),
      direction: "BUY",
      type: "BUY",
      stop_loss: 1.099,
      take_profit: 1.102,
    };
    expect(scalpProfitProtectionStop(order, snapshot(1.1015), 2)).toEqual({
      stopLoss: 1.1006,
      stage: "1.5r",
    });
  });
});

describe("resolveDailyLossLimitUsd", () => {
  it("prefers an explicit USD cap even when account equity changes", () => {
    expect(resolveDailyLossLimitUsd(137.5, 10, 15)).toBe(10);
  });

  it("falls back to the percentage cap when fixed USD is disabled", () => {
    expect(resolveDailyLossLimitUsd(100, 0, 10)).toBe(10);
  });
});

describe("multi-position daily risk guard", () => {
  it("estimates the remaining downside from current floating PnL to SL", () => {
    expect(
      estimateRemainingOrderDownsideUsd(
        { ...sellOrder(), profit: 2, stop_loss: 1.101 },
        "EURUSD",
      ),
    ).toBe(7);
  });

  it("allows a second order while projected worst equity stays above daily floor", () => {
    expect(
      checkAggregateDailyRisk({
        currentEquity: 101,
        dayBaselineEquity: 100,
        dailyLossLimitUsd: 10,
        openRemainingRiskUsd: 4,
        candidateLossUsd: 5,
      }).allowed,
    ).toBe(true);
  });

  it("blocks a second order when combined remaining risk exceeds the daily cap", () => {
    const result = checkAggregateDailyRisk({
      currentEquity: 99,
      dayBaselineEquity: 100,
      dailyLossLimitUsd: 10,
      openRemainingRiskUsd: 5,
      candidateLossUsd: 5,
    });
    expect(result.allowed).toBe(false);
    expect(result.projectedWorstEquity).toBe(89);
    expect(result.dailyFloorEquity).toBe(90);
  });
});
