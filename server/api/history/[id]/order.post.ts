import { createError, getRouterParam, readBody } from "h3";
import type {
  AiTradeRecommendation,
  OrderType,
  RiskyTradeScenario,
} from "../../../../types/ai";
import type {
  OrderState,
  SymbolCode,
  TradeDirection,
} from "../../../../types/trading";
import { AnalysisHistoryService } from "../../../services/AnalysisHistoryService";
import { MarketDataService } from "../../../services/MarketDataService";
import { Mt5OrderService } from "../../../services/Mt5OrderService";
import { SupabaseService } from "../../../services/SupabaseService";

type OrderScenario = "MAIN" | "RISKY";

interface OrderRequestBody {
  scenario?: OrderScenario;
}

interface ExecutableScenario {
  scenario: OrderScenario;
  symbol: SymbolCode;
  direction: Exclude<TradeDirection, "NONE">;
  orderType: OrderType;
  winProbability: number;
  entryZone: { from: number; to: number } | null;
  stopLoss: number | null;
  takeProfit: number | null;
  cancelAfterMinutes: number | null;
}

export default defineEventHandler(async (event) => {
  try {
    const id = getRouterParam(event, "id");
    if (!id) {
      throw createError({ statusCode: 400, message: "Thiếu ID lịch sử." });
    }

    const body: OrderRequestBody = await readBody<OrderRequestBody>(event).catch(
      () => ({}),
    );
    const scenario = body.scenario === "RISKY" ? "RISKY" : "MAIN";

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
    if (!parsed) {
      throw createError({
        statusCode: 400,
        message: "Bản ghi này không có kết quả AI hợp lệ để đặt lệnh.",
      });
    }

    const executable = selectExecutableScenario(parsed, scenario);
    const volume = volumeFromWinProbability(executable.winProbability);
    if (volume === null) {
      throw createError({
        statusCode: 400,
        message:
          "%win kèo dưới 55%, không tự đặt lệnh MT5 theo rule hiện tại.",
      });
    }

    const entryPrice =
      executable.entryZone === null
        ? null
        : Number(
            (
              (executable.entryZone.from + executable.entryZone.to) /
              2
            ).toFixed(6),
          );

    const mt5Symbol = mt5SymbolFor(config, executable.symbol);
    const latestMarket = await new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
      mt5BridgeUrl: config.mt5BridgeUrl,
      mt5Symbol,
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
      debug: config.marketDataDebug,
    }).getLatestPrice(executable.symbol);

    assertOrderStillMatchesCurrentPrice(
      executable,
      entryPrice,
      latestMarket.price,
    );

    const orderService = new Mt5OrderService({
      bridgeUrl: config.mt5BridgeUrl,
      symbol: mt5Symbol,
    });

    const placed = await orderService.placeOrder({
      direction: executable.direction,
      orderType: executable.orderType,
      volume,
      price: entryPrice,
      stopLoss: executable.stopLoss,
      takeProfit: executable.takeProfit,
      expirationMinutes: executable.cancelAfterMinutes,
      comment:
        executable.scenario === "RISKY"
          ? "ai-assistant-risky"
          : "ai-assistant-main",
    });

    const orderState: OrderState = placed.isPending ? "PENDING" : "FILLED";
    const record = await historyService.markOrderPlaced(id, {
      mt5_ticket: placed.ticket,
      order_type: executable.orderType,
      order_state: orderState,
    });

    return { record, placed, scenario: executable.scenario, volume };
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
  if (record.symbol !== "XAUUSD" && record.symbol !== "EURUSD") return null;
  if (record.decision !== "TRADE" && record.decision !== "NO_TRADE") return null;
  return value as AiTradeRecommendation;
}

function selectExecutableScenario(
  recommendation: AiTradeRecommendation,
  scenario: OrderScenario,
): ExecutableScenario {
  if (scenario === "RISKY") {
    if (!recommendation.risky_trade?.enabled) {
      throw createError({
        statusCode: 400,
        message: "Không có kịch bản phụ hợp lệ để đặt lệnh.",
      });
    }
    return riskyTradeToExecutable(recommendation.symbol, recommendation.risky_trade);
  }

  if (
    recommendation.decision !== "TRADE" ||
    recommendation.direction === "NONE"
  ) {
    throw createError({
      statusCode: 400,
      message: "Kịch bản chính không phải tín hiệu TRADE hợp lệ để đặt lệnh.",
    });
  }

  return {
    scenario: "MAIN",
    symbol: recommendation.symbol,
    direction: recommendation.direction,
    orderType: recommendation.order_type,
    winProbability:
      recommendation.estimated_win_probability ?? recommendation.confidence,
    entryZone: recommendation.entry_zone,
    stopLoss: recommendation.stop_loss,
    takeProfit: recommendation.take_profit,
    cancelAfterMinutes: recommendation.cancel_after_minutes ?? null,
  };
}

function riskyTradeToExecutable(
  symbol: SymbolCode,
  riskyTrade: RiskyTradeScenario,
): ExecutableScenario {
  return {
    scenario: "RISKY",
    symbol,
    direction: riskyTrade.direction,
    orderType: riskyTrade.order_type,
    winProbability: riskyTrade.estimated_win_probability,
    entryZone: riskyTrade.entry_zone,
    stopLoss: riskyTrade.stop_loss,
    takeProfit: riskyTrade.take_profit,
    cancelAfterMinutes: riskyTrade.cancel_after_minutes ?? 30,
  };
}

function volumeFromWinProbability(winProbability: number): number | null {
  if (!Number.isFinite(winProbability) || winProbability < 55) return null;
  return winProbability > 65 ? 0.02 : 0.01;
}

function mt5SymbolFor(
  config: ReturnType<typeof useRuntimeConfig>,
  symbol: SymbolCode,
): string {
  return symbol === "EURUSD" ? config.mt5EurUsdSymbol : config.mt5Symbol;
}

function assertOrderStillMatchesCurrentPrice(
  scenario: ExecutableScenario,
  entryPrice: number | null,
  currentPrice: number,
): void {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw createError({
      statusCode: 400,
      message: `Không lấy được giá ${scenario.symbol} mới nhất trước khi đặt lệnh.`,
    });
  }

  const tolerance =
    scenario.symbol === "EURUSD"
      ? Math.max(currentPrice * 0.00005, 0.00005)
      : Math.max(currentPrice * 0.00005, 0.2);
  const orderType = scenario.orderType;

  if (orderType === "MARKET") {
    if (!scenario.entryZone) return;
    const { from, to } = scenario.entryZone;
    if (currentPrice < from - tolerance || currentPrice > to + tolerance) {
      throw createError({
        statusCode: 409,
        message: `Giá hiện tại ${formatPrice(currentPrice, scenario.symbol)} đã rời khỏi vùng entry ${formatPrice(from, scenario.symbol)} - ${formatPrice(to, scenario.symbol)} của tín hiệu MARKET. Hãy phân tích lại trước khi vào lệnh.`,
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
      message: `${invalidReason}. Giá hiện tại ${formatPrice(currentPrice, scenario.symbol)}, entry dự kiến ${formatPrice(entryPrice, scenario.symbol)}. Hãy phân tích lại trước khi đặt lệnh.`,
    });
  }
}

function formatPrice(value: number, symbol: SymbolCode): string {
  return value.toFixed(symbol === "EURUSD" ? 5 : 2);
}

function isH3Error(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error
  );
}
