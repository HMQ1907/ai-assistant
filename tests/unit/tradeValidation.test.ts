import { describe, expect, it } from "vitest";
import type { AiTradeRecommendation } from "../../types/ai";
import type { AnalysisPayload } from "../../types/trading";
import { TradeValidationService } from "../../server/services/TradeValidationService";

function recommendation(
  patch: Partial<AiTradeRecommendation> = {},
): AiTradeRecommendation {
  return {
    decision: "NO_TRADE",
    symbol: "XAUUSD",
    direction: "NONE",
    order_type: "MARKET",
    confidence: 50,
    entry_zone: null,
    stop_loss: null,
    stop_loss_reason: "",
    take_profit: null,
    take_profit_reason: "",
    risk_reward: null,
    expected_holding_time: null,
    position_sizing: {
      account_size_usd: 70,
      max_loss_usd: 10.5,
      max_loss_percent: 15,
      suggested_lot: null,
      estimated_loss_if_sl_hit: null,
      position_sizing_explanation: "",
    },
    current_price: 4300,
    market_context: "",
    trade_reason: "",
    entry_plan: "",
    summary: "",
    technical_analysis: {
      trend: "",
      momentum: "",
      support_resistance: "",
      volatility: "",
      timeframe_alignment: "",
    },
    news_analysis: {
      sentiment: "",
      supporting_news: [],
      risk_news: [],
      upcoming_high_impact_events: [],
    },
    main_reasons: [],
    risk_factors: [],
    invalid_conditions: [],
    best_case_scenario: "",
    worst_case_scenario: "",
    pre_entry_checklist: [],
    no_trade_reason: "No valid setup.",
    next_check_suggestion: "",
    risky_trade: null,
    disclaimer: "",
    ...patch,
  };
}

function payload(): AnalysisPayload {
  return {
    generatedAt: "2026-06-09T00:00:00Z",
    accountSizeUsd: 70,
    maxLossUsdPerTrade: 10.5,
    maxLossPercentPerTrade: 15,
    marketDataProvider: "test",
    newsProvider: "test",
    dataQuality: "HIGH",
    dataWarnings: [],
    marketDataTimestamp: "2026-06-09T00:00:00Z",
    newsDataTimestamp: "2026-06-09T00:00:00Z",
    newsDataStatus: "NO_RELEVANT_DATA",
    symbols: [],
    news: {
      items: [],
      upcomingEvents: [],
      status: "NO_RELEVANT_DATA",
      provider: "test",
      updatedAt: "2026-06-09T00:00:00Z",
      warnings: [],
    },
    rules: [],
  };
}

describe("trade validation", () => {
  it("does not validate entry/sl/tp for a deliberate NO_TRADE", () => {
    const result = new TradeValidationService().validate(
      recommendation(),
      payload(),
    );
    expect(result.decision).toBe("NO_TRADE");
    expect(result.entry_zone).toBeNull();
    expect(result.invalid_conditions).toEqual([]);
  });

  it("keeps a technically valid TRADE despite low confidence and account sizing", () => {
    const result = new TradeValidationService().validate(
      recommendation({
        decision: "TRADE",
        direction: "BUY",
        confidence: 55,
        entry_zone: { from: 4300, to: 4300 },
        stop_loss: 4280,
        take_profit: 4340,
        risk_reward: "1:2",
        position_sizing: {
          account_size_usd: 70,
          max_loss_usd: 10.5,
          max_loss_percent: 15,
          suggested_lot: 0.1,
          estimated_loss_if_sl_hit: 200,
          position_sizing_explanation: "",
        },
      }),
    );

    expect(result.decision).toBe("TRADE");
    expect(result.confidence).toBe(55);
  });

  it("still rejects a technically poor risk reward", () => {
    const result = new TradeValidationService().validate(
      recommendation({
        decision: "TRADE",
        direction: "BUY",
        confidence: 80,
        entry_zone: { from: 4300, to: 4300 },
        stop_loss: 4280,
        take_profit: 4320,
        risk_reward: "1:1",
        position_sizing: {
          account_size_usd: 70,
          max_loss_usd: 10.5,
          max_loss_percent: 15,
          suggested_lot: 0.01,
          estimated_loss_if_sl_hit: 20,
          position_sizing_explanation: "",
        },
      }),
    );

    expect(result.decision).toBe("NO_TRADE");
    expect(result.trade_validation_failures?.join(" ")).toContain("risk_reward");
  });

  it("rejects an order_type that does not match the direction", () => {
    const result = new TradeValidationService().validate(
      recommendation({
        decision: "TRADE",
        direction: "BUY",
        order_type: "SELL_LIMIT",
        confidence: 80,
        entry_zone: { from: 4300, to: 4300 },
        stop_loss: 4280,
        take_profit: 4340,
        risk_reward: "1:2",
        position_sizing: {
          account_size_usd: 70,
          max_loss_usd: 10.5,
          max_loss_percent: 15,
          suggested_lot: 0.01,
          estimated_loss_if_sl_hit: 20,
          position_sizing_explanation: "",
        },
      }),
    );

    expect(result.decision).toBe("NO_TRADE");
    expect(result.order_type).toBe("MARKET");
    expect(result.trade_validation_failures?.join(" ")).toContain("order_type");
  });

  it("keeps a consistent MARKET buy order", () => {
    const result = new TradeValidationService().validate(
      recommendation({
        decision: "TRADE",
        direction: "BUY",
        order_type: "MARKET",
        confidence: 80,
        entry_zone: { from: 4300, to: 4300 },
        stop_loss: 4280,
        take_profit: 4340,
        risk_reward: "1:2",
        position_sizing: {
          account_size_usd: 70,
          max_loss_usd: 10.5,
          max_loss_percent: 15,
          suggested_lot: 0.01,
          estimated_loss_if_sl_hit: 20,
          position_sizing_explanation: "",
        },
      }),
    );

    expect(result.decision).toBe("TRADE");
    expect(result.order_type).toBe("MARKET");
  });
});
