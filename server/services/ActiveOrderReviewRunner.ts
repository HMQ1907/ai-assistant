import type { AiOrderReview } from "../../types/ai";
import type {
  ActiveMt5Order,
  AnalysisHistoryRecord,
} from "../../types/trading";
import { AiAnalysisService } from "./AiAnalysisService";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import { IndicatorService } from "./IndicatorService";
import { MarketDataService } from "./MarketDataService";
import { Mt5OrderService } from "./Mt5OrderService";
import { NewsService } from "./NewsService";
import { OpportunityPayloadBuilder } from "./OpportunityPayloadBuilder";
import { SupabaseService } from "./SupabaseService";

export interface ActiveOrderReviewItem {
  order: ActiveMt5Order;
  review: AiOrderReview;
  matching_history_id: string | null;
}

export async function runActiveXauUsdOrderReviews(): Promise<{
  orders: ActiveMt5Order[];
  reviews: ActiveOrderReviewItem[];
}> {
  const config = useRuntimeConfig();
  const orderService = new Mt5OrderService({
    bridgeUrl: config.mt5BridgeUrl,
    symbol: config.mt5Symbol,
  });
  const orders = await orderService.getActiveOrders();
  if (orders.length === 0) return { orders: [], reviews: [] };

  const historyService = new AnalysisHistoryService(
    new SupabaseService({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
    }).getClient(),
  );
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

  // One fresh XAUUSD snapshot is shared by all active-order reviews in this run.
  const market = await marketService.collectAll(["XAUUSD"]);
  const indicators = new IndicatorService().calculateMany(market.snapshots);
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
    const result = await aiService.reviewActiveOrder({
      order,
      latestPayload: payload,
      matchingHistory,
    });
    reviews.push({
      order,
      review: result.parsed,
      matching_history_id: matchingHistory?.id ?? null,
    });
  }

  return { orders, reviews };
}

export function findMatchingHistory(
  order: ActiveMt5Order,
  histories: AnalysisHistoryRecord[],
): AnalysisHistoryRecord | null {
  return (
    histories.find((history) => history.mt5_ticket === order.ticket) ??
    histories.find(
      (history) =>
        history.symbol === "XAUUSD" &&
        history.order_state === order.state &&
        history.direction === order.direction &&
        Math.abs(history.entry_from - order.price_open) <= 2 &&
        Math.abs(history.entry_to - order.price_open) <= 2,
    ) ??
    null
  );
}
