import { createError, getRouterParam, readBody } from "h3";
import { z } from "zod";
import { AiAnalysisService } from "../../../services/AiAnalysisService";
import { AnalysisHistoryService } from "../../../services/AnalysisHistoryService";
import { IndicatorService } from "../../../services/IndicatorService";
import { MarketDataService } from "../../../services/MarketDataService";
import { NewsService } from "../../../services/NewsService";
import { OpportunityPayloadBuilder } from "../../../services/OpportunityPayloadBuilder";
import { SupabaseService } from "../../../services/SupabaseService";

const reviewRequestSchema = z.object({
  result_status: z.string().default("PENDING"),
  actual_entry: z.number().nullable().default(null),
  actual_exit: z.number().nullable().default(null),
  actual_profit_loss: z.number().nullable().default(null),
  user_note: z.string().default(""),
});

export default defineEventHandler(async (event) => {
  try {
    const id = getRouterParam(event, "id");
    if (!id) {
      throw createError({
        statusCode: 400,
        message: "Thiếu ID lịch sử cần check lại.",
      });
    }

    const body = await readBody<unknown>(event);
    const input = reviewRequestSchema.parse(body ?? {});
    const config = useRuntimeConfig();
    const supabase = new SupabaseService({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
    }).getClient();
    const historyService = new AnalysisHistoryService(supabase);
    const history = await historyService.getById(id);

    const marketService = new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
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

    const market = await marketService.collectAll();
    const indicators = indicatorService.calculateMany(market.snapshots);
    const news = await newsService.collect();
    const payload = payloadBuilder.build(
      market,
      indicators,
      news,
      history.request_payload.accountSizeUsd,
    );
    const review = await aiService.reviewOrder({
      history,
      latestPayload: payload,
      actualEntry: input.actual_entry,
      actualExit: input.actual_exit,
      actualProfitLoss: input.actual_profit_loss,
      userNote: input.user_note,
      resultStatus: input.result_status,
    });

    return { review: review.parsed, raw: review.raw, latestPayload: payload };
  } catch (error) {
    throw createError({
      statusCode: 500,
      message:
        error instanceof Error ? error.message : "Check lại lệnh thất bại",
    });
  }
});
