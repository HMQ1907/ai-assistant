import { describe, expect, it } from "vitest";
import type { AiTradeRecommendation } from "../../types/ai";
import type { AnalysisPayload, SymbolCode } from "../../types/trading";
import { TradeValidationService } from "../../server/services/TradeValidationService";

function recommendation(
  patch: Partial<AiTradeRecommendation> = {},
): AiTradeRecommendation {
  return {
    decision: "NO_TRADE",
    symbol: "XAUUSD",
    direction: "NONE",
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
    no_trade_reason: "Không có setup.",
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

// Payload có 1 symbol với market/indicator hợp lệ để validation tìm thấy
// đúng symbol (price > 0, spread null, data_quality HIGH — không tự chặn).
function payloadFor(symbol: SymbolCode): AnalysisPayload {
  const base = payload();
  const price = symbol === "EURUSD" ? 1.08 : 4300;
  return {
    ...base,
    symbols: [
      {
        market: {
          symbol,
          price,
          bid: null,
          ask: null,
          spread: null,
          bidAskStatus: "UNAVAILABLE",
          data_quality: "HIGH",
          data_warnings: [],
          informational_diagnostics: [],
          critical_errors: [],
          updated_at: base.marketDataTimestamp,
          provider: "test",
          providerFetchedAt: base.marketDataTimestamp,
          providerQuoteTime: null,
          quoteAgeSeconds: null,
          quoteTimestampReliable: true,
          candle_summary: {} as never,
          recent_candles: { M5: [], M15: [], H1: [], H4: [] },
          candle_patterns: {} as never,
          candle_diagnostics: {} as never,
          timeframe_quality: {} as never,
        },
        indicators: {
          symbol,
          ema20: null,
          ema50: null,
          ema200: null,
          rsi14: null,
          macd: { macd: null, signal: null, histogram: null },
          atr14: null,
          nearestSupport: null,
          nearestResistance: null,
          swingHigh: 0,
          swingLow: 0,
          trendM15: "INSUFFICIENT_DATA",
          trendH1: "INSUFFICIENT_DATA",
          structureTrendM15: "INSUFFICIENT_DATA",
          structureTrendH1: "INSUFFICIENT_DATA",
          momentumScore: null,
          volatilityScore: null,
          timeframes: {} as never,
          timeframeAlignment: "INSUFFICIENT_DATA",
        },
      },
    ],
  };
}

describe("trade validation", () => {
  it("does not validate entry/sl/tp for a deliberate NO_TRADE", () => {
    const result = new TradeValidationService().validate(recommendation(), payload());
    expect(result.decision).toBe("NO_TRADE");
    expect(result.entry_zone).toBeNull();
    expect(result.invalid_conditions).toEqual([]);
  });

  it("forces TRADE above max risk to NO_TRADE", () => {
    const result = new TradeValidationService().validate(
      recommendation({
        decision: "TRADE",
        direction: "BUY",
        confidence: 80,
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
      payload(),
    );

    expect(result.decision).toBe("NO_TRADE");
    expect(result.trade_validation_failures?.join(" ")).toContain(
      "vượt giới hạn",
    );
  });

  it("sizes EURUSD with forex contract size (100000), not the gold formula", () => {
    // EURUSD: entry 1.08000, SL 1.07500 -> distance 0.005.
    // Với lot tối thiểu 0.01: loss = 0.01 * 0.005 * 100000 = $5 (<= maxLoss 10.5).
    const result = new TradeValidationService().validate(
      recommendation({
        symbol: "EURUSD",
        decision: "TRADE",
        direction: "BUY",
        confidence: 80,
        entry_zone: { from: 1.08, to: 1.08 },
        stop_loss: 1.075,
        take_profit: 1.09,
        risk_reward: "1:2",
        position_sizing: {
          account_size_usd: 70,
          max_loss_usd: 10.5,
          max_loss_percent: 15,
          suggested_lot: null,
          estimated_loss_if_sl_hit: null,
          position_sizing_explanation: "",
        },
      }),
      payloadFor("EURUSD"),
    );

    expect(result.decision).toBe("TRADE");
    expect(result.symbol).toBe("EURUSD");
    expect(result.position_sizing.suggested_lot).toBe(0.01);
    // 0.01 * 0.005 * 100000 = 5
    expect(result.position_sizing.estimated_loss_if_sl_hit).toBeCloseTo(5, 5);
  });

  it("forces NO_TRADE when AI returns a symbol different from the analyzed one", () => {
    const result = new TradeValidationService().validate(
      recommendation({
        symbol: "EURUSD",
        decision: "TRADE",
        direction: "BUY",
        confidence: 80,
        entry_zone: { from: 1.08, to: 1.08 },
        stop_loss: 1.075,
        take_profit: 1.09,
        risk_reward: "1:2",
      }),
      payloadFor("XAUUSD"),
    );

    expect(result.decision).toBe("NO_TRADE");
    expect(result.trade_validation_failures?.join(" ")).toContain("khác symbol");
  });
});
