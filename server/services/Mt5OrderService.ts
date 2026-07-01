import type { OrderType } from "../../types/ai";
import type {
  ActiveMt5Order,
  OrderState,
  TradeDirection,
} from "../../types/trading";

export interface PlaceOrderInput {
  direction: Exclude<TradeDirection, "NONE">;
  orderType: OrderType;
  volume: number;
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expirationMinutes?: number | null;
  comment?: string;
}

export interface PlaceOrderResult {
  ticket: number;
  orderType: string;
  isPending: boolean;
  price: number;
  volume: number;
}

export interface CancelOrderResult {
  ticket: number;
  state: OrderState;
}

export interface ModifyOrderInput {
  ticket: number;
  stopLoss: number | null;
  takeProfit: number | null;
  comment?: string;
}

export interface ModifyOrderResult {
  ticket: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

interface BridgePlaceResponse {
  ok: boolean;
  ticket: number;
  order_type: string;
  is_pending: boolean;
  price: number;
  volume: number;
}

interface BridgeCancelResponse {
  ok: boolean;
  ticket: number;
  state: string;
}

interface BridgeModifyResponse {
  ok: boolean;
  ticket: number;
  stop_loss: number | null;
  take_profit: number | null;
}

interface BridgeActiveOrdersResponse {
  ok: boolean;
  symbol: string;
  orders: ActiveMt5Order[];
}

// Chuyển (direction + order_type của AI) sang order_type mà bridge hiểu.
function toBridgeOrderType(
  direction: Exclude<TradeDirection, "NONE">,
  orderType: OrderType,
): string {
  if (orderType === "MARKET") {
    return direction === "BUY" ? "MARKET_BUY" : "MARKET_SELL";
  }
  return orderType;
}

export class Mt5OrderService {
  constructor(
    private readonly options: {
      bridgeUrl: string;
      symbol: string;
      timeoutMs?: number;
    },
  ) {
    if (!options.bridgeUrl) {
      throw new Error("Chưa cấu hình MT5_BRIDGE_URL.");
    }
    if (!options.symbol) {
      throw new Error("Chưa cấu hình MT5_SYMBOL.");
    }
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (!Number.isFinite(input.volume) || input.volume <= 0) {
      throw new Error("Volume không hợp lệ.");
    }
    const bridgeOrderType = toBridgeOrderType(input.direction, input.orderType);
    const isPending = bridgeOrderType !== "MARKET_BUY" && bridgeOrderType !== "MARKET_SELL";
    if (isPending && !isFinitePositive(input.price)) {
      throw new Error("Lệnh chờ cần giá entry hợp lệ.");
    }

    const body = await this.call<BridgePlaceResponse>("/order", {
      symbol: this.options.symbol,
      order_type: bridgeOrderType,
      volume: input.volume,
      price: input.price,
      stop_loss: input.stopLoss,
      take_profit: input.takeProfit,
      expiration_minutes: isPending ? input.expirationMinutes ?? null : null,
      comment: input.comment ?? "ai-assistant",
    });

    return {
      ticket: body.ticket,
      orderType: body.order_type,
      isPending: body.is_pending,
      price: body.price,
      volume: body.volume,
    };
  }

  async cancelOrder(ticket: number): Promise<CancelOrderResult> {
    const body = await this.call<BridgeCancelResponse>("/order/cancel", {
      symbol: this.options.symbol,
      ticket,
    });
    return {
      ticket: body.ticket,
      state: body.state === "CANCELLED" ? "CANCELLED" : "CLOSED",
    };
  }

  async modifyOrder(input: ModifyOrderInput): Promise<ModifyOrderResult> {
    if (input.stopLoss === null && input.takeProfit === null) {
      throw new Error("Cần có SL hoặc TP mới để modify lệnh.");
    }

    const body = await this.call<BridgeModifyResponse>("/order/modify", {
      symbol: this.options.symbol,
      ticket: input.ticket,
      stop_loss: input.stopLoss,
      take_profit: input.takeProfit,
      comment: input.comment ?? "ai-assistant-modify",
    });
    return {
      ticket: body.ticket,
      stopLoss: body.stop_loss,
      takeProfit: body.take_profit,
    };
  }

  async getAccount(): Promise<{ balance: number; equity: number; tradeAllowed: boolean }> {
    const url = new URL("/health", this.options.bridgeUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Không kết nối được MT5 bridge tại ${this.options.bridgeUrl}: ${reason}`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MT5 bridge /health trả HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const body = (await response.json()) as {
      balance?: number;
      equity?: number;
      trade_allowed?: boolean;
    };
    return {
      balance: Number(body.balance ?? 0),
      equity: Number(body.equity ?? 0),
      tradeAllowed: Boolean(body.trade_allowed),
    };
  }

  async getActiveOrders(): Promise<ActiveMt5Order[]> {
    const url = new URL("/orders", this.options.bridgeUrl);
    url.searchParams.set("symbol", this.options.symbol);
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(
        `Không kết nối được MT5 bridge tại ${this.options.bridgeUrl}: ${reason}`,
      );
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `MT5 bridge trả HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
    }
    const body = (await response.json()) as BridgeActiveOrdersResponse;
    return body.orders;
  }

  private async call<T>(path: string, payload: unknown): Promise<T> {
    const url = new URL(path, this.options.bridgeUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(
        `Không kết nối được MT5 bridge tại ${this.options.bridgeUrl}: ${reason}`,
      );
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `MT5 bridge trả HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }
}

function isFinitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
