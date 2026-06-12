import type {
  AnalysisPayload,
  Candle,
  DataQuality,
  IndicatorSnapshot,
  MarketPayloadSnapshot,
  MarketSnapshot,
  NewsSnapshot,
  Timeframe,
  TimeframeCandleSummary,
} from "../../types/trading";
import { TIMEFRAMES } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import type { MarketDataCollection } from "../providers/market/MarketDataProvider";
import { detectCandlePatterns } from "../utils/candlePatterns";

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
      news.status === "AVAILABLE" ? "HIGH" : "MEDIUM",
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
        return {
          market: toMarketPayloadSnapshot(snapshot),
          indicators: indicator,
        };
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
        "Thiếu bid/ask/spread không phải lý do NO_TRADE khi data_quality từ MEDIUM trở lên và candle/indicator đủ điều kiện. Chỉ xem đây là yếu tố rủi ro và nhắc người dùng tự kiểm tra spread trên sàn trước khi vào lệnh.",
        "Nếu news_data_status là UNAVAILABLE, phải giảm độ tin cậy và chỉ TRADE khi setup kỹ thuật rất rõ.",
        "EMA H1/H4 là chỉ báo trễ, không được dùng làm lý do bắt buộc BUY/SELL khi nến H1/M15 đã đóng và phá cấu trúc theo hướng ngược lại.",
        "Không SELL vào động lượng tăng đang mở rộng và không BUY vào động lượng giảm đang mở rộng. Khi có dấu hiệu chuyển pha mạnh, phải chờ pullback/retest hoặc trả NO_TRADE.",
        "All user-facing content MUST be written in Vietnamese. Only enum values may remain in English.",
        "Không khuyến nghị martingale, DCA lỗ, all-in, tăng khối lượng sau khi thua, copy trade hoặc auto trade.",
        `Thời gian giữ lệnh dự kiến không vượt quá ${tradingRules.maxHoldingMinutes} phút.`,
      ],
    };
  }
}

function toMarketPayloadSnapshot(
  snapshot: MarketSnapshot,
): MarketPayloadSnapshot {
  const payload: MarketPayloadSnapshot = {
    symbol: snapshot.symbol,
    price: snapshot.price,
    bid: snapshot.bid,
    ask: snapshot.ask,
    spread: snapshot.spread,
    bidAskStatus: snapshot.bidAskStatus,
    data_quality: snapshot.data_quality,
    data_warnings: snapshot.data_warnings,
    informational_diagnostics: snapshot.informational_diagnostics,
    critical_errors: snapshot.critical_errors,
    updated_at: snapshot.updated_at,
    provider: snapshot.provider,
    providerFetchedAt: snapshot.providerFetchedAt,
    providerQuoteTime: snapshot.providerQuoteTime,
    quoteAgeSeconds: snapshot.quoteAgeSeconds,
    quoteTimestampReliable: snapshot.quoteTimestampReliable,
    candle_summary: {} as Record<Timeframe, TimeframeCandleSummary>,
    recent_candles: {} as Record<Timeframe, Candle[]>,
    candle_patterns: {} as MarketPayloadSnapshot["candle_patterns"],
    candle_diagnostics: snapshot.candle_diagnostics,
    timeframe_quality: snapshot.timeframe_quality,
  };

  for (const timeframe of TIMEFRAMES) {
    const candles = snapshot.candles[timeframe] ?? [];
    payload.candle_summary[timeframe] = summarizeCandles(
      timeframe,
      candles,
      snapshot.filtered_candles?.[timeframe] ?? 0,
    );
    payload.recent_candles[timeframe] = candles.slice(-40);
    payload.candle_patterns[timeframe] = detectCandlePatterns(
      timeframe,
      candles,
    );
  }

  return payload;
}

function summarizeCandles(
  timeframe: Timeframe,
  candles: Candle[],
  filteredOutCandles: number,
): TimeframeCandleSummary {
  const first = candles[0];
  const last = candles.at(-1);
  const ranges = candles.map((candle) => candle.high - candle.low);
  const bodies = candles.map((candle) => Math.abs(candle.close - candle.open));

  return {
    timeframe,
    candleCount: candles.length,
    firstCandleTime: first?.time ?? "",
    lastCandleTime: last?.time ?? "",
    open: round(first?.open ?? 0),
    high: round(
      candles.length ? Math.max(...candles.map((candle) => candle.high)) : 0,
    ),
    low: round(
      candles.length ? Math.min(...candles.map((candle) => candle.low)) : 0,
    ),
    close: round(last?.close ?? 0),
    averageRange: average(ranges),
    averageBody: average(bodies),
    filteredOutCandles,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(4));
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
