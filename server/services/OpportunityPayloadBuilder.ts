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
    accountSizeUsd: number,
  ): AnalysisPayload {
    const dataWarnings = [...market.warnings, ...news.warnings];
    const dataQuality = combineQuality(
      market.dataQuality,
      news.status === "UNAVAILABLE" ? "MEDIUM" : "HIGH",
    );
    const maxLossUsdPerTrade = calculateMaxLossUsd(accountSizeUsd);

    return {
      generatedAt: new Date().toISOString(),
      accountSizeUsd,
      maxLossUsdPerTrade,
      maxLossPercentPerTrade: tradingRules.maxLossPercentPerTrade,
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
        if (!indicator) {
          throw new Error(`Thiếu chỉ báo kỹ thuật cho ${snapshot.symbol}`);
        }
        return { market: snapshot, indicators: indicator };
      }),
      news,
      rules: [
        "Hệ thống chỉ là AI Trading Assistant cho giao dịch thủ công XAUUSD. Không đặt lệnh.",
        "Chỉ phân tích XAUUSD. Không quét hoặc chọn symbol khác.",
        "Phong cách giao dịch có thể mạo hiểm hơn nhưng vẫn phải có setup rõ ràng và quản trị rủi ro.",
        `Vốn hiện tại là ${accountSizeUsd} USD.`,
        `Mức lỗ tối đa mỗi giao dịch là ${tradingRules.maxLossPercentPerTrade}% vốn, tương đương ${maxLossUsdPerTrade} USD.`,
        `Nếu confidence < ${tradingRules.minConfidence}, trả NO_TRADE.`,
        `Nếu risk_reward < 1:${tradingRules.minRiskReward}, trả NO_TRADE.`,
        "Nếu setup rất mạnh theo kỹ thuật hoặc tin tức, có thể dùng lot cao hơn nhưng estimated_loss_if_sl_hit không được vượt quá giới hạn lỗ tối đa.",
        "Không giao dịch khi data_quality LOW, thiếu giá realtime, thiếu candle, hoặc spread quá cao.",
        "Nếu news_data_status là UNAVAILABLE, phải giảm độ tin cậy và chỉ TRADE khi setup kỹ thuật rất rõ.",
        "All user-facing content MUST be written in Vietnamese. Only enum values may remain in English.",
        "Không khuyến nghị martingale, DCA lỗ, all-in, tăng khối lượng sau khi thua, copy trade hoặc auto trade.",
        `Thời gian giữ lệnh dự kiến không vượt quá ${tradingRules.maxHoldingMinutes} phút.`,
      ],
    };
  }
}

function calculateMaxLossUsd(accountSizeUsd: number): number {
  return Number(
    (
      accountSizeUsd *
      (tradingRules.maxLossPercentPerTrade / 100)
    ).toFixed(2),
  );
}

function combineQuality(left: DataQuality, right: DataQuality): DataQuality {
  if (left === "LOW" || right === "LOW") return "LOW";
  if (left === "MEDIUM" || right === "MEDIUM") return "MEDIUM";
  return "HIGH";
}
