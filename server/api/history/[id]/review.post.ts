import { createError, getRouterParam, readBody } from "h3";
import { z } from "zod";
import type {
  AiOrderReview,
  AiOrderScenarioReview,
  AiTradeRecommendation,
} from "../../../../types/ai";
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
  actual_order_placed_at: z
    .preprocess(normalizeOptionalDateTime, z.string().nullable())
    .default(null),
  user_note: z.string().default(""),
});

function normalizeOptionalDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

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
      actualOrderPlacedAt: input.actual_order_placed_at,
      userNote: input.user_note,
      resultStatus: input.result_status,
    });

    return {
      review: promoteRiskyScenarioWhenMainIsNoTrade(
        history.parsed_result,
        review.parsed,
      ),
      raw: review.raw,
      latestPayload: payload,
    };
  } catch (error) {
    throw createError({
      statusCode: 500,
      message:
        error instanceof Error ? error.message : "Check lại lệnh thất bại",
    });
  }
});

function promoteRiskyScenarioWhenMainIsNoTrade(
  parsedResult: unknown,
  review: AiOrderReview,
): AiOrderReview {
  const recommendation = asRecommendation(parsedResult);
  if (
    recommendation?.decision !== "NO_TRADE" ||
    !recommendation.risky_trade?.enabled
  ) {
    return review;
  }

  const riskyReview = review.scenario_reviews?.find(
    (item) => item.scenario === "RISKY_TRADE" && item.available,
  );
  if (!riskyReview) return review;

  return {
    ...review,
    order_status_assessment: riskyReview.order_status_assessment,
    recommended_action: riskyReview.recommended_action,
    confidence: riskyReview.confidence,
    summary: `Đang ưu tiên check kịch bản phụ vì khuyến nghị chính là NO_TRADE. ${riskyReview.summary}`,
    fill_assessment: riskyReview.fill_assessment,
    action_reason: riskyReview.action_reason,
    stop_loss_plan: scenarioStopLossPlan(riskyReview),
    take_profit_plan: scenarioTakeProfitPlan(riskyReview),
    cancellation_conditions: riskyReview.cancellation_conditions,
    risk_warnings: riskyReview.risk_warnings,
    checklist: riskyReview.checklist,
  };
}

function scenarioStopLossPlan(scenario: AiOrderScenarioReview): AiOrderReview["stop_loss_plan"] {
  return {
    keep_current: true,
    suggested_stop_loss: scenario.stop_loss,
    reason:
      scenario.stop_loss === null
        ? "Kịch bản phụ không có stop loss hợp lệ để đề xuất."
        : "Ưu tiên dùng stop loss của kịch bản phụ khi quản lý lệnh này.",
  };
}

function scenarioTakeProfitPlan(
  scenario: AiOrderScenarioReview,
): AiOrderReview["take_profit_plan"] {
  return {
    keep_current: true,
    suggested_take_profit: scenario.take_profit,
    reason:
      scenario.take_profit === null
        ? "Kịch bản phụ không có take profit hợp lệ để đề xuất."
        : "Ưu tiên dùng take profit của kịch bản phụ khi quản lý lệnh này.",
  };
}

function asRecommendation(value: unknown): AiTradeRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AiTradeRecommendation>;
  if (candidate.decision !== "TRADE" && candidate.decision !== "NO_TRADE") {
    return null;
  }
  return value as AiTradeRecommendation;
}