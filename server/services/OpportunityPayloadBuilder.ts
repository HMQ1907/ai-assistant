import type {
  AnalysisPayload,
  DataQuality,
  IndicatorSnapshot,
  NewsSnapshot,
} from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import type { MarketDataCollection } from "../providers/market/MarketDataProvider";

export class OpportunityPayloadBuilder {
  build(
    market: MarketDataCollection,
    indicators: IndicatorSnapshot[],
    news: NewsSnapshot,
  ): AnalysisPayload {
    const dataWarnings = [...market.warnings, ...news.warnings];
    const dataQuality = combineQuality(
      market.dataQuality,
      news.status === "UNAVAILABLE" ? "MEDIUM" : "HIGH",
    );

    return {
      generatedAt: new Date().toISOString(),
      accountSizeUsd: tradingRules.accountSizeUsd,
      maxLossUsdPerTrade: tradingRules.maxLossUsdPerTrade,
      marketDataProvider: market.provider,
      newsProvider: news.provider,
      dataQuality,
      dataWarnings,
      marketDataTimestamp: market.timestamp,
      newsDataTimestamp: news.updatedAt,
      newsDataStatus: news.status,
      symbols: market.snapshots.map((snapshot) => {
        const indicator = indicators.find(
          (item) => item.symbol === snapshot.symbol,
        );
        if (!indicator)
          throw new Error(`Thiếu chỉ báo kỹ thuật cho ${snapshot.symbol}`);
        return { market: snapshot, indicators: indicator };
      }),
      news,
      rules: [
        "Hệ thống chỉ là AI Trading Assistant cho giao dịch thủ công XAUUSD. Không đặt lệnh.",
        "Chỉ phân tích XAUUSD. Không quét hoặc chọn symbol khác.",
        "Chỉ trả TRADE khi setup rõ ràng, rủi ro được kiểm soát và tin tức không quá bất lợi; nếu không thì trả NO_TRADE.",
        `Nếu confidence < ${tradingRules.minConfidence}, trả NO_TRADE.`,
        `Nếu risk_reward < 1:${tradingRules.minRiskReward}, trả NO_TRADE.`,
        `Tài khoản ${tradingRules.accountSizeUsd} USD, lỗ tối đa mỗi giao dịch ${tradingRules.maxLossUsdPerTrade} USD.`,
        "Không giao dịch khi data_quality LOW, thiếu giá realtime, thiếu candle, hoặc spread quá cao.",
        "Nếu news_data_status là UNAVAILABLE, phải giảm độ tin cậy và chỉ TRADE khi setup kỹ thuật rất rõ.",
        "All user-facing content MUST be written in Vietnamese. Only enum values may remain in English.",
        "Không khuyến nghị martingale, DCA lỗ, all-in, tăng khối lượng sau khi thua, copy trade hoặc auto trade.",
        `Thời gian giữ lệnh dự kiến không vượt quá ${tradingRules.maxHoldingMinutes} phút.`,
      ],
    };
  }
}

function combineQuality(left: DataQuality, right: DataQuality): DataQuality {
  if (left === "LOW" || right === "LOW") return "LOW";
  if (left === "MEDIUM" || right === "MEDIUM") return "MEDIUM";
  return "HIGH";
}
