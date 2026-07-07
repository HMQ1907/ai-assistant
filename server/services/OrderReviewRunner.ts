import type {
  AiOrderReview,
  AiOrderScenarioReview,
  AiTradeRecommendation,
} from "../../types/ai";
import type { SymbolCode } from "../../types/trading";
import { AiAnalysisService } from "./AiAnalysisService";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import { IndicatorService } from "./IndicatorService";
import { MarketDataService } from "./MarketDataService";
import { NewsService } from "./NewsService";
import { OpportunityPayloadBuilder } from "./OpportunityPayloadBuilder";
import { SupabaseService } from "./SupabaseService";

export async function runOrderReview(input: {
  id: string;
  resultStatus?: string;
  actualEntry?: number | null;
  actualExit?: number | null;
  actualProfitLoss?: number | null;
  actualOrderPlacedAt?: string | null;
  userNote?: string;
}) {
  const config = useRuntimeConfig();
  const historyService = new AnalysisHistoryService(
    new SupabaseService({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
    }).getClient(),
  );
  const history = await historyService.getById(input.id);
  const symbol = history.symbol === "EURUSD" ? "EURUSD" : "XAUUSD";

  const marketService = new MarketDataService({
    providerName: config.marketDataProvider,
    apiKey: config.marketDataApiKey,
    baseUrl: config.marketDataBaseUrl,
    mt5BridgeUrl: config.mt5BridgeUrl,
    mt5Symbol: mt5SymbolFor(config, symbol),
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

  const market = await marketService.collectAll([symbol]);
  const indicators = indicatorService.calculateMany(market.snapshots);
  const news = await newsService.collect();
  const latestPayload = payloadBuilder.build(
    market,
    indicators,
    news,
    history.request_payload.accountSizeUsd,
    history.request_payload.maxLossPercentPerTrade,
  );
  const review = await aiService.reviewOrder({
    history,
    latestPayload,
    actualEntry: input.actualEntry ?? null,
    actualExit: input.actualExit ?? null,
    actualProfitLoss: input.actualProfitLoss ?? null,
    actualOrderPlacedAt: input.actualOrderPlacedAt ?? null,
    userNote: input.userNote ?? "",
    resultStatus: input.resultStatus ?? "PENDING",
  });

  return {
    history,
    latestPayload,
    raw: review.raw,
    review: promoteRiskyScenarioWhenMainIsNoTrade(
      history.parsed_result,
      review.parsed,
    ),
  };
}

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

function scenarioStopLossPlan(
  scenario: AiOrderScenarioReview,
): AiOrderReview["stop_loss_plan"] {
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

function mt5SymbolFor(
  config: ReturnType<typeof useRuntimeConfig>,
  symbol: SymbolCode,
): string {
  return symbol === "EURUSD" ? config.mt5EurUsdSymbol : config.mt5Symbol;
}
