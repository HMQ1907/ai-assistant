import type {
  AnalysisPayload,
  Candle,
  DataQuality,
  IndicatorSnapshot,
  MarketPayloadSnapshot,
  MarketSnapshot,
  NewsSnapshot,
  SymbolCode,
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
    maxLossPercentPerTrade: number = tradingRules.maxLossPercentPerTrade,
  ): AnalysisPayload {
    const selectedSymbols = market.snapshots.map((snapshot) => snapshot.symbol);
    const filteredNews = filterNewsForSymbols(news, selectedSymbols);
    const dataWarnings = [...market.warnings, ...filteredNews.warnings];
    const dataQuality = combineQuality(
      market.dataQuality,
      filteredNews.status === "AVAILABLE" ? "HIGH" : "MEDIUM",
    );
    const maxLossUsdPerTrade = calculateMaxLossUsd(
      accountSizeUsd,
      maxLossPercentPerTrade,
    );
    const symbolList = selectedSymbols.join(", ");

    return {
      generatedAt: new Date().toISOString(),
      accountSizeUsd,
      maxLossUsdPerTrade,
      maxLossPercentPerTrade,
      marketDataProvider: market.provider,
      newsProvider: filteredNews.provider,
      dataQuality,
      dataWarnings,
      marketDataTimestamp: market.timestamp,
      newsDataTimestamp: filteredNews.updatedAt,
      newsDataStatus: filteredNews.status,
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
      news: filteredNews,
      rules: [
        `Requested analysis symbol(s): ${symbolList}. Analyze only these symbol(s).`,
        `Hệ thống chỉ phân tích symbol được yêu cầu: ${symbolList}. Không quét hoặc chọn symbol khác.`,
        "Trong chế độ auto-bot, hệ thống local mới là nơi quyết định/đặt lệnh; AI chỉ phân tích hoặc veto theo dữ liệu được cung cấp.",
        "Phong cách giao dịch phải thận trọng. Chỉ TRADE khi setup rõ, dữ liệu mới và điều kiện khớp lệnh đáng tin cậy.",
        `Vốn hiện tại là ${accountSizeUsd} USD.`,
        `Mức lỗ tham khảo mỗi giao dịch là ${maxLossPercentPerTrade}% vốn, tương đương ${maxLossUsdPerTrade} USD; đây không phải điều kiện để quyết định TRADE hay NO_TRADE.`,
        `Nếu confidence < ${tradingRules.minConfidence}%, trả NO_TRADE.`,
        `Nếu risk_reward < 1:${tradingRules.minRiskReward}, trả NO_TRADE.`,
        "Vốn, lot và estimated_loss_if_sl_hit chỉ mang tính tham khảo; không được dùng để phủ quyết một setup kỹ thuật hợp lệ. Người dùng tự quản trị vốn và khối lượng.",
        "Không giao dịch khi data_quality LOW, thiếu giá realtime, thiếu candle, hoặc spread quá cao.",
        "Thiếu bid/ask/spread thật là lý do NO_TRADE vì không đủ điều kiện kiểm tra khớp lệnh tiền thật.",
        `Nếu quoteAgeSeconds null hoặc vượt ${tradingRules.maxQuoteAgeSeconds}s, trả NO_TRADE.`,
        "Nếu news_data_status là UNAVAILABLE, phải giảm độ tin cậy và chỉ TRADE khi setup kỹ thuật rất rõ.",
        "EMA H1/H4 là chỉ báo trễ, không được dùng làm lý do bắt buộc BUY/SELL khi nến H1/M15 đã đóng và phá cấu trúc theo hướng ngược lại.",
        "Không SELL vào động lượng tăng đang mở rộng và không BUY vào động lượng giảm đang mở rộng. Khi có dấu hiệu chuyển pha mạnh, phải chờ pullback/retest hoặc trả NO_TRADE.",
        "Setup pullback/retest chỉ được trả TRADE khi bối cảnh đa khung rõ ràng, quote mới, bid/ask/spread thật có sẵn, và điều kiện hủy kèo cụ thể.",
        "Khung quyết định là H1, H4 làm bias lọc hướng, M15 chỉ để canh điểm vào, M5 gần như bỏ. Chỉ trade thuận bias H4.",
        `Stop loss phải đặt ngoài cấu trúc H1 và cách entry tối thiểu ${tradingRules.minStopLossAtrMultiple} lần ATR(H1) để không bị noise hoặc quét thanh khoản. Không được bóp SL sát lại chỉ để đạt risk_reward; nếu SL đúng cấu trúc làm RR dưới ngưỡng thì trả NO_TRADE.`,
        "Ưu tiên lệnh MARKET tại giá hiện tại khi có setup H1 hợp lệ ngay lúc này, vì người dùng không ngồi canh để chờ lệnh chờ khớp. Chỉ dùng lệnh chờ khi giá đang thực sự hồi về vùng retest gần và có điều kiện hủy kèo cụ thể.",
        "All user-facing content MUST be written in Vietnamese. Only enum values may remain in English.",
        "Không khuyến nghị martingale, DCA lỗ, all-in, tăng khối lượng sau khi thua, copy trade hoặc auto trade.",
        `Thời gian giữ lệnh dự kiến không vượt quá ${tradingRules.maxHoldingMinutes} phút.`,
      ],
    };
  }
}

function filterNewsForSymbols(
  news: NewsSnapshot,
  symbols: SymbolCode[],
): NewsSnapshot {
  const symbolSet = new Set<SymbolCode>(symbols);
  const items = news.items.filter((item) =>
    item.symbols.some((symbol) => symbolSet.has(symbol)),
  );
  return {
    ...news,
    items,
    status:
      items.length > 0
        ? "AVAILABLE"
        : news.status === "UNAVAILABLE"
          ? "UNAVAILABLE"
          : "NO_RELEVANT_DATA",
    warnings:
      items.length > 0
        ? news.warnings
        : [
            ...news.warnings,
            `Khong co tin tuc moi duoc gan truc tiep cho ${symbols.join(", ")}.`,
          ],
  };
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

function calculateMaxLossUsd(
  accountSizeUsd: number,
  maxLossPercentPerTrade: number,
): number {
  return Number(
    (
      accountSizeUsd *
      (maxLossPercentPerTrade / 100)
    ).toFixed(2),
  );
}

function combineQuality(left: DataQuality, right: DataQuality): DataQuality {
  if (left === "LOW" || right === "LOW") return "LOW";
  if (left === "MEDIUM" || right === "MEDIUM") return "MEDIUM";
  return "HIGH";
}
