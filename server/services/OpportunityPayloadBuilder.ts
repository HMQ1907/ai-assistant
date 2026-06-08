import type {
  AnalysisPayload,
  DataQuality,
  IndicatorSnapshot,
  NewsSnapshot,
} from "../../types/trading";
import type { MarketDataCollection } from "../providers/market/MarketDataProvider";
import { tradingRules } from "../config/tradingRules";

export class OpportunityPayloadBuilder {
  build(
    market: MarketDataCollection,
    indicators: IndicatorSnapshot[],
    news: NewsSnapshot,
  ): AnalysisPayload {
    const dataWarnings = [...market.warnings, ...news.warnings];
    const dataQuality = combineQuality(
      market.dataQuality,
      news.status === "UNAVAILABLE" ? "LOW" : "HIGH",
    );

    return {
      generatedAt: new Date().toISOString(),
      accountSizeUsd: tradingRules.accountSizeUsd,
      marketDataProvider: market.provider,
      newsProvider: news.provider,
      dataQuality,
      dataWarnings,
      skippedSymbols: market.skippedSymbols,
      marketDataTimestamp: market.timestamp,
      newsDataTimestamp: news.updatedAt,
      newsDataStatus: news.status,
      symbols: market.snapshots.map((snapshot) => {
        const indicator = indicators.find(
          (item) => item.symbol === snapshot.symbol,
        );
        if (!indicator)
          throw new Error(`Missing indicators for ${snapshot.symbol}`);
        return { market: snapshot, indicators: indicator };
      }),
      news,
      rules: [
        "Manual trading assistant only. Do not execute trades.",
        "Return TRADE only when setup is clear and safe; otherwise return NO_TRADE.",
        `If confidence < ${tradingRules.minConfidence}, return NO_TRADE.`,
        `If risk reward < 1:${tradingRules.minRiskReward}, return NO_TRADE.`,
        "Never trade a symbol with data_quality LOW, missing realtime price, missing candle data, or excessive spread.",
        "If news_data_status is UNAVAILABLE and the setup depends on news or macro catalysts, return NO_TRADE or reduce confidence.",
        "All user-facing explanations must be written in Vietnamese. Only enum values and symbols may remain in English.",
        "If high-impact event is within 30 minutes, prefer NO_TRADE.",
        "If spread is too high or market is sideway/choppy, return NO_TRADE.",
        "Never recommend martingale, loss DCA, all-in, or increasing lot after losing.",
        `Risk per trade must use configured riskPercent ${tradingRules.riskPercent}% and accountSizeUsd ${tradingRules.accountSizeUsd}.`,
        `Expected holding time should not exceed ${tradingRules.maxHoldingMinutes} minutes.`,
      ],
    };
  }
}

function combineQuality(left: DataQuality, right: DataQuality): DataQuality {
  if (left === "LOW" || right === "LOW") return "LOW";
  if (left === "MEDIUM" || right === "MEDIUM") return "MEDIUM";
  return "HIGH";
}
