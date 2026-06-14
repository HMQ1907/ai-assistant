import { createError, readBody } from "h3";
import { z } from "zod";
import { tradingRules } from "../config/tradingRules";
import { AiAnalysisService } from "../services/AiAnalysisService";
import { AnalysisHistoryService } from "../services/AnalysisHistoryService";
import { IndicatorService } from "../services/IndicatorService";
import { MarketDataService } from "../services/MarketDataService";
import { NewsService } from "../services/NewsService";
import { OpportunityPayloadBuilder } from "../services/OpportunityPayloadBuilder";
import { SupabaseService } from "../services/SupabaseService";

const analyzeRequestSchema = z.object({
  accountSizeUsd: z
    .number()
    .positive()
    .max(1_000_000)
    .default(tradingRules.defaultAccountSizeUsd),
});

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    const input = analyzeRequestSchema.parse(body ?? {});
    const config = useRuntimeConfig();
    const marketService = new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
      mt5BridgeUrl: config.mt5BridgeUrl,
      mt5Symbol: config.mt5Symbol,
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

    const market = await marketService.collectAll();
    const indicators = indicatorService.calculateMany(market.snapshots);
    const news = await newsService.collect();
    const payload = payloadBuilder.build(
      market,
      indicators,
      news,
      input.accountSizeUsd,
    );
    const aiResult = await aiService.analyze(payload);
    const history = await historyService.create({
      requestPayload: payload,
      aiResponseRaw: aiResult.raw,
      parsedResult: aiResult.parsed,
    });

    return { result: aiResult.parsed, history };
  } catch (error) {
    throw createError({
      statusCode: 500,
      message: error instanceof Error ? error.message : "Phân tích thất bại",
    });
  }
});
