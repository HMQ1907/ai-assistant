import type { SymbolCode } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { AiAnalysisService } from "./AiAnalysisService";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import { IndicatorService } from "./IndicatorService";
import { MarketDataService } from "./MarketDataService";
import { NewsService } from "./NewsService";
import { OpportunityPayloadBuilder } from "./OpportunityPayloadBuilder";
import { SupabaseService } from "./SupabaseService";

export async function runTradingAnalysis(input: {
  symbol: SymbolCode;
  accountSizeUsd?: number;
}) {
  const config = useRuntimeConfig();
  const mt5Symbol =
    input.symbol === "EURUSD" ? config.mt5EurUsdSymbol : config.mt5Symbol;
  const marketService = new MarketDataService({
    providerName: config.marketDataProvider,
    apiKey: config.marketDataApiKey,
    baseUrl: config.marketDataBaseUrl,
    mt5BridgeUrl: config.mt5BridgeUrl,
    mt5Symbol,
    maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
    debug: config.marketDataDebug,
  });
  const indicatorService = new IndicatorService();
  const newsService = new NewsService({
    providerName: config.newsProvider,
    apiKey: config.newsApiKey,
    baseUrl: config.newsBaseUrl,
    maxAgeHours: config.newsMaxAgeHours,
  });
  const payloadBuilder = new OpportunityPayloadBuilder();
  const aiService = new AiAnalysisService({
    apiKey: config.evolinkApiKey,
    model: config.evolinkModel,
    baseUrl: config.evolinkBaseUrl,
    timeoutMs: config.aiTimeoutMs,
  });
  const historyService = new AnalysisHistoryService(
    new SupabaseService({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
    }).getClient(),
  );

  const market = await marketService.collectAll([input.symbol]);
  const indicators = indicatorService.calculateMany(market.snapshots);
  const news = await newsService.collect();
  const payload = payloadBuilder.build(
    market,
    indicators,
    news,
    input.accountSizeUsd ?? tradingRules.defaultAccountSizeUsd,
    config.maxLossPercentPerTrade,
  );

  // Track record thật của các tín hiệu gần đây -> AI tự hiệu chỉnh.
  // Lỗi thống kê không được chặn phân tích chính.
  let recentPerformance = null;
  try {
    recentPerformance = await historyService.recentSignalPerformance(input.symbol);
  } catch (error) {
    console.warn(
      "[analysis] không tải được track record gần đây, phân tích tiếp không có nó:",
      error instanceof Error ? error.message : error,
    );
  }

  const aiResult = await aiService.analyze(payload, recentPerformance);
  const history = await historyService.create({
    requestPayload: payload,
    aiResponseRaw: aiResult.raw,
    parsedResult: aiResult.parsed,
  });

  return { payload, result: aiResult.parsed, history };
}
