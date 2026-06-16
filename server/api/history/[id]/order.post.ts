import { createError, getRouterParam } from "h3";
import type { AiTradeRecommendation } from "../../../../types/ai";
import type { OrderState } from "../../../../types/trading";
import { AnalysisHistoryService } from "../../../services/AnalysisHistoryService";
import { MarketDataService } from "../../../services/MarketDataService";
import { Mt5OrderService } from "../../../services/Mt5OrderService";
import { SupabaseService } from "../../../services/SupabaseService";

export default defineEventHandler(async (event) => {
  try {
    const id = getRouterParam(event, "id");
    if (!id) {
      throw createError({ statusCode: 400, message: "Thiếu ID lịch sử." });
    }

    const config = useRuntimeConfig();
    const historyService = new AnalysisHistoryService(
      new SupabaseService({
        url: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
      }).getClient(),
    );

    const history = await historyService.getById(id);

    if (history.order_state !== "NONE") {
      throw createError({
        statusCode: 409,
        message: `Lệnh đã ở trạng thái ${history.order_state}, không đặt lại được.`,
      });
    }

    const parsed = asRecommendation(history.parsed_result);
    if (!parsed || parsed.decision !== "TRADE" || parsed.direction === "NONE") {
      throw createError({
        statusCode: 400,
        message: "Bản ghi này không phải tín hiệu TRADE hợp lệ để đặt lệnh.",
      });
    }

    const volume = parsed.position_sizing.suggested_lot;
    if (volume === null || !Number.isFinite(volume) || volume <= 0) {
      throw createError({
        statusCode: 400,
        message: "Không có lot gợi ý hợp lệ để đặt lệnh.",
      });
    }

    const entryPrice =
      parsed.entry_zone === null
        ? null
        : Number(
            ((parsed.entry_zone.from + parsed.entry_zone.to) / 2).toFixed(2),
          );
    const latestMarket = await new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
      mt5BridgeUrl: config.mt5BridgeUrl,
      mt5Symbol: config.mt5Symbol,
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
      debug: config.marketDataDebug,
    }).getLatestPrice("XAUUSD");

    assertOrderStillMatchesCurrentPrice(parsed, entryPrice, latestMarket.price);

    const orderService = new Mt5OrderService({
      bridgeUrl: config.mt5BridgeUrl,
      symbol: config.mt5Symbol,
    });

    const placed = await orderService.placeOrder({
      direction: parsed.direction,
      orderType: parsed.order_type,
      volume,
      price: entryPrice,
      stopLoss: parsed.stop_loss,
      takeProfit: parsed.take_profit,
    });

    const orderState: OrderState = placed.isPending ? "PENDING" : "FILLED";
    const record = await historyService.markOrderPlaced(id, {
      mt5_ticket: placed.ticket,
      order_type: parsed.order_type,
      order_state: orderState,
    });

    return { record, placed };
  } catch (error) {
    if (isH3Error(error)) throw error;
    throw createError({
      statusCode: 500,
      message: error instanceof Error ? error.message : "Đặt lệnh thất bại.",
    });
  }
});

function asRecommendation(value: unknown): AiTradeRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AiTradeRecommendation>;
  if (record.symbol !== "XAUUSD") return null;
  if (record.decision !== "TRADE" && record.decision !== "NO_TRADE") return null;
  if (typeof record.position_sizing !== "object") return null;
  return value as AiTradeRecommendation;
}

function assertOrderStillMatchesCurrentPrice(
  recommendation: AiTradeRecommendation,
  entryPrice: number | null,
  currentPrice: number,
): void {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw createError({
      statusCode: 400,
      message: "Không lấy được giá XAUUSD mới nhất trước khi đặt lệnh.",
    });
  }

  const tolerance = Math.max(currentPrice * 0.00005, 0.2);
  const orderType = recommendation.order_type;

  if (orderType === "MARKET") {
    if (!recommendation.entry_zone) return;
    const { from, to } = recommendation.entry_zone;
    if (currentPrice < from - tolerance || currentPrice > to + tolerance) {
      throw createError({
        statusCode: 409,
        message: `Giá hiện tại ${currentPrice.toFixed(2)} đã rời khỏi vùng entry ${from.toFixed(2)} - ${to.toFixed(2)} của tín hiệu MARKET. Hãy phân tích lại trước khi vào lệnh.`,
      });
    }
    return;
  }

  if (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw createError({
      statusCode: 400,
      message: "Lệnh chờ thiếu giá entry hợp lệ.",
    });
  }

  const invalidReason =
    orderType === "BUY_LIMIT" && entryPrice >= currentPrice - tolerance
      ? "BUY_LIMIT phải nằm dưới giá hiện tại"
      : orderType === "SELL_LIMIT" && entryPrice <= currentPrice + tolerance
        ? "SELL_LIMIT phải nằm trên giá hiện tại"
        : orderType === "BUY_STOP" && entryPrice <= currentPrice + tolerance
          ? "BUY_STOP phải nằm trên giá hiện tại"
          : orderType === "SELL_STOP" && entryPrice >= currentPrice - tolerance
            ? "SELL_STOP phải nằm dưới giá hiện tại"
            : "";

  if (invalidReason) {
    throw createError({
      statusCode: 409,
      message: `${invalidReason}. Giá hiện tại ${currentPrice.toFixed(2)}, entry dự kiến ${entryPrice.toFixed(2)}. Hãy phân tích lại trước khi đặt lệnh.`,
    });
  }
}

function isH3Error(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error
  );
}
