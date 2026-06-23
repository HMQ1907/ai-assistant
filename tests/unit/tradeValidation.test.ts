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

function payloadWithXauMarket(price = 4175, atrM15 = 11): AnalysisPayload {
  return {
    ...payload(),
    symbols: [
      {
        market: {
          symbol: "XAUUSD",
          price,
          bid: price,
          ask: price + 0.25,
          spread: 0.25,
          bidAskStatus: "AVAILABLE",
          data_quality: "HIGH",
          data_warnings: [],
          informational_diagnostics: [],
          critical_errors: [],
          updated_at: "2026-06-09T00:00:00Z",
          provider: "test",
          providerFetchedAt: "2026-06-09T00:00:00Z",
          providerQuoteTime: "2026-06-09T00:00:00Z",
          quoteAgeSeconds: 1,
          quoteTimestampReliable: true,
          recent_candles: { M5: [], M15: [], H1: [], H4: [] },
          candle_summary: {
            M5: summary("M5", price),
            M15: summary("M15", price),
            H1: summary("H1", price),
            H4: summary("H4", price),
          },
          candle_patterns: { M5: [], M15: [], H1: [], H4: [] },
          candle_diagnostics: {
            M5: diagnostics(),
            M15: diagnostics(),
            H1: diagnostics(),
            H4: diagnostics(),
          },
          timeframe_quality: {
            M5: timeframeQuality("M5"),
            M15: timeframeQuality("M15"),
            H1: timeframeQuality("H1"),
            H4: timeframeQuality("H4"),
          },
        },
        indicators: {
          symbol: "XAUUSD",
          ema20: null,
          ema50: null,
          ema200: null,
          rsi14: null,
          macd: { macd: null, signal: null, histogram: null },
          atr14: atrM15,
          nearestSupport: null,
          nearestResistance: null,
          swingHigh: price + 20,
          swingLow: price - 20,
          trendM15: "SIDEWAY_OR_MIXED",
          trendH1: "SIDEWAY_OR_MIXED",
          structureTrendM15: "SIDEWAY_OR_MIXED",
          structureTrendH1: "SIDEWAY_OR_MIXED",
          momentumScore: 50,
          volatilityScore: 50,
          timeframeAlignment: "mixed",
          timeframes: {
            M5: timeframeIndicator("M5", price, 50, 5),
            M15: timeframeIndicator("M15", price, 50, atrM15),
            H1: timeframeIndicator("H1", price, 50, atrM15 * 2),
            H4: timeframeIndicator("H4", price, 50, atrM15 * 4),
          },
        },
      },
    ],
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

  it("rejects a technically valid TRADE when confidence is too low", () => {
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

    expect(result.decision).toBe("NO_TRADE");
    expect(result.trade_validation_failures?.join(" ")).toContain("confidence");
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

  it("rejects a pending entry when price is not rotating back toward that zone", () => {
    const result = new TradeValidationService().validate(
      recommendation({
        decision: "TRADE",
        direction: "SELL",
        order_type: "SELL_LIMIT",
        confidence: 80,
        entry_zone: { from: 4187, to: 4190 },
        stop_loss: 4196.5,
        take_profit: 4171,
        risk_reward: "1:2",
      }),
      payloadWithXauMarket(4175, 11),
    );

    expect(result.decision).toBe("NO_TRADE");
    expect(result.trade_validation_failures?.join(" ")).toContain(
      "chưa cho thấy giá đang hồi/rotate",
    );
  });

  it("keeps a farther pending entry when recent candles rotate toward that zone", () => {
    const testPayload = payloadWithXauMarket(4175, 11);
    testPayload.symbols[0]!.market.recent_candles.M5 = [
      candle(4169, 4170, 4168, 4169.5),
      candle(4169.5, 4173, 4169, 4172),
      candle(4172, 4176, 4171, 4175),
      candle(4175, 4180, 4174, 4179),
    ];

    const result = new TradeValidationService().validate(
      recommendation({
        decision: "TRADE",
        direction: "SELL",
        order_type: "SELL_LIMIT",
        confidence: 80,
        entry_zone: { from: 4187, to: 4190 },
        // SL >= 0.8x ATR(H1)=22 cach entry 4188.5 (>= 17.6) de qua duoc gate dem ATR moi.
        stop_loss: 4207,
        take_profit: 4151,
        risk_reward: "1:2",
      }),
      testPayload,
    );

    expect(result.decision).toBe("TRADE");
  });
});

function summary(timeframe: "M5" | "M15" | "H1" | "H4", price: number) {
  return {
    timeframe,
    candleCount: 350,
    firstCandleTime: "2026-06-08T00:00:00Z",
    lastCandleTime: "2026-06-09T00:00:00Z",
    open: price,
    high: price + 10,
    low: price - 10,
    close: price,
    averageRange: 5,
    averageBody: 2,
    filteredOutCandles: 0,
  };
}

function diagnostics() {
  return {
    requestedCount: 350,
    receivedCount: 350,
    validCount: 350,
    filteredCount: 0,
    reasons: {},
    firstRawCandleTime: "2026-06-08T00:00:00Z",
    lastRawCandleTime: "2026-06-09T00:00:00Z",
    firstValidCandleTime: "2026-06-08T00:00:00Z",
    lastValidCandleTime: "2026-06-09T00:00:00Z",
    indicatorDataSufficient: true,
  };
}

function timeframeQuality(timeframe: "M5" | "M15" | "H1" | "H4") {
  return {
    timeframe,
    quality: "HIGH" as const,
    validCandleCount: 350,
    requiredCandleCount: 200,
    invalidRatio: 0,
    indicatorReadiness: {
      ema20: true,
      ema50: true,
      ema200: true,
      rsi14: true,
      atr14: true,
      macd: true,
    },
    reasons: [],
  };
}

function timeframeIndicator(
  timeframe: "M5" | "M15" | "H1" | "H4",
  price: number,
  momentumScore: number,
  atr14: number,
) {
  return {
    timeframe,
    ema20: price,
    ema50: price,
    ema200: price,
    rsi14: 50,
    macd: { macd: 0, signal: 0, histogram: 0 },
    atr14,
    readiness: {
      ema20: true,
      ema50: true,
      ema200: true,
      rsi14: true,
      atr14: true,
      macd: true,
    },
    trend: "SIDEWAY_OR_MIXED" as const,
    structureTrend: "SIDEWAY_OR_MIXED" as const,
    momentumScore,
    volatilityScore: 50,
    marketStructure: {
      nearestSupport: price - 10,
      nearestResistance: price + 10,
      swingHigh: price + 20,
      swingLow: price - 20,
      supportLevels: [],
      resistanceLevels: [],
    },
  };
}

function candle(open: number, high: number, low: number, close: number) {
  return {
    time: "2026-06-09T00:00:00Z",
    open,
    high,
    low,
    close,
    volume: 100,
  };
}
