import { createError } from "h3";
import type { AiOrderReview } from "../../../types/ai";
import type { ActiveMt5Order, AnalysisHistoryRecord } from "../../../types/trading";
import { AiAnalysisService } from "../../services/AiAnalysisService";
import { AnalysisHistoryService } from "../../services/AnalysisHistoryService";
import { IndicatorService } from "../../services/IndicatorService";
import { MarketDataService } from "../../services/MarketDataService";
import { Mt5OrderService } from "../../services/Mt5OrderService";
import { NewsService } from "../../services/NewsService";
import { OpportunityPayloadBuilder } from "../../services/OpportunityPayloadBuilder";
import { SupabaseService } from "../../services/SupabaseService";

interface ActiveOrderReviewItem {
  order: ActiveMt5Order;
  review: AiOrderReview;
  matching_history_id: string | null;
}

export default defineEventHandler(async () => {
  try {
    const config = useRuntimeConfig();
    const orderService = new Mt5OrderService({
      bridgeUrl: config.mt5BridgeUrl,
      symbol: config.mt5Symbol,
    });
    const orders = await orderService.getActiveOrders();

    if (orders.length === 0) {
      return { orders: [], reviews: [] as ActiveOrderReviewItem[] };
    }

    const supabase = new SupabaseService({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
    }).getClient();
    const historyService = new AnalysisHistoryService(supabase);
    const histories = await historyService.list();

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
    const aiService = new AiAnalysisService({
      apiKey: config.evolinkApiKey,
      model: config.evolinkModel,
      baseUrl: config.evolinkBaseUrl,
      timeoutMs: config.aiTimeoutMs,
    });

    const market = await marketService.collectAll();
    const indicators = indicatorService.calculateMany(market.snapshots);
    const news = await newsService.collect();
    const payload = new OpportunityPayloadBuilder().build(
      market,
      indicators,
      news,
      config.accountSizeUsd,
    );

    const reviews: ActiveOrderReviewItem[] = [];
    for (const order of orders) {
      const matchingHistory = findMatchingHistory(order, histories);
      const review = await aiService.reviewActiveOrder({
        order,
        latestPayload: payload,
        matchingHistory,
      });
      reviews.push({
        order,
        review: review.parsed,
        matching_history_id: matchingHistory?.id ?? null,
      });
    }

    return { orders, reviews };
  } catch (error) {
    throw createError({
      statusCode: 500,
      message:
        error instanceof Error
          ? error.message
          : "Check các lệnh đang active thất bại.",
    });
  }
});

function findMatchingHistory(
  order: ActiveMt5Order,
  histories: AnalysisHistoryRecord[],
): AnalysisHistoryRecord | null {
  return (
    histories.find((history) => history.mt5_ticket === order.ticket) ??
    histories.find(
      (history) =>
        history.order_state === order.state &&
        history.direction === order.direction &&
        Math.abs(history.entry_from - order.price_open) <= 2 &&
        Math.abs(history.entry_to - order.price_open) <= 2,
    ) ??
    null
  );
}
