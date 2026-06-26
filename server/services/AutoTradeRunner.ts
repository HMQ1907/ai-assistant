import type { AiTradeRecommendation } from "../../types/ai";
import type { AnalysisPayload, NewsSnapshot } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import {
  convictionScore,
  defaultRuleStrategyConfig,
  evaluateRuleSignal,
  type RuleSignal,
} from "../strategy/ruleStrategy";
import { AiAnalysisService } from "./AiAnalysisService";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import { IndicatorService } from "./IndicatorService";
import { MarketDataService } from "./MarketDataService";
import { Mt5OrderService } from "./Mt5OrderService";
import { OpportunityPayloadBuilder } from "./OpportunityPayloadBuilder";
import { SupabaseService } from "./SupabaseService";
import { TelegramService } from "./TelegramService";
import { isInsideTradeScannerWindow } from "./TradeScannerService";

/**
 * Auto-bot Rules Engine H1 (KHÔNG dùng AI cho quyết định vào lệnh).
 * Mỗi tick (5 phút): nếu có lệnh đang mở -> để SL/TP server-side lo, bỏ qua.
 * Nếu rảnh + trong khung giờ + nến H1 mới đóng -> chạy rules engine, có setup thì
 * tự đặt MARKET kèm SL/TP. Nâng lot theo độ đẹp tất định; AI chỉ VETO khi nâng lot.
 */
export class AutoTradeRunner {
  private running = false;
  private lastEvaluatedH1 = "";
  private lastEvaluatedM15 = "";
  private dayKey = "";
  private dayBaselineEquity = 0;
  private tradesToday = 0;
  private haltedForDay = false;
  private lastErrorKey = "";
  private lastErrorNotifyAt = 0;

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const config = useRuntimeConfig();
      const orderService = new Mt5OrderService({
        bridgeUrl: config.mt5BridgeUrl,
        symbol: config.mt5Symbol,
      });

      // Trạng thái tài khoản + reset theo ngày + kill-switch lỗ ngày.
      const account = await orderService.getAccount();
      this.rollDay(config.tradeScannerTimezone, account.equity);
      if (!account.tradeAllowed) {
        console.warn("[auto-bot] AutoTrading đang TẮT trong MT5 — bật Algo Trading để đặt lệnh.");
        await this.notifyError(
          config,
          "algo-off",
          "AutoTrading đang TẮT trong MT5 → bot KHÔNG đặt được lệnh. Hãy bật nút Algo Trading.",
        );
        return;
      }
      if (this.haltedForDay) {
        console.info("[auto-bot] đã chạm giới hạn lỗ/lệnh trong ngày — dừng vào lệnh.");
        return;
      }
      if (
        this.dayBaselineEquity > 0 &&
        account.equity <=
          this.dayBaselineEquity * (1 - config.autoMaxDailyLossPercent / 100)
      ) {
        this.haltedForDay = true;
        console.warn(
          `[auto-bot] kill-switch: equity ${account.equity} <= ngưỡng lỗ ngày ${config.autoMaxDailyLossPercent}%.`,
        );
        return;
      }

      // 1 lệnh tại 1 thời điểm: đang có lệnh -> để SL/TP lo. Đóng nếu giữ quá hạn (khớp backtest).
      const activeOrders = await orderService.getActiveOrders();
      if (activeOrders.length > 0) {
        await this.closeStaleOrders(orderService, activeOrders, config.autoMaxHoldHours);
        return;
      }

      if (this.tradesToday >= config.autoMaxTradesPerDay) {
        console.info("[auto-bot] đã đạt số lệnh tối đa/ngày.");
        return;
      }
      if (!isInsideTradeScannerWindow()) return; // chỉ vào lệnh trong khung giờ tốt

      // Dữ liệu thị trường (350 nến/khung là đủ cho rules engine H1).
      const marketService = new MarketDataService({
        providerName: config.marketDataProvider,
        apiKey: config.marketDataApiKey,
        baseUrl: config.marketDataBaseUrl,
        mt5BridgeUrl: config.mt5BridgeUrl,
        mt5Symbol: config.mt5Symbol,
        maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
        debug: false,
      });
      const market = await marketService.collectAll(["XAUUSD"]);
      const snapshot = market.snapshots[0];
      if (!snapshot || snapshot.data_quality === "LOW") {
        console.info("[auto-bot] bỏ qua: data_quality LOW hoặc thiếu snapshot.");
        return;
      }

      const h1 = snapshot.candles.H1;
      const h4 = snapshot.candles.H4;
      const m15 = snapshot.candles.M15;
      const strategy = {
        ...defaultRuleStrategyConfig,
        rrTarget: config.autoRrTarget,
      };

      // Tìm setup: ưu tiên H1 (mỗi nến H1 mới); nếu không có thì thử M15 (trong trend H1, bias H4).
      let signal: RuleSignal | null = null;
      let entryCandles = h1;
      let entryTf = "H1";

      const latestH1 = h1.at(-1)?.time ?? "";
      if (latestH1 && latestH1 !== this.lastEvaluatedH1) {
        this.lastEvaluatedH1 = latestH1;
        const s = evaluateRuleSignal(h1, h4, strategy);
        if (s) {
          signal = s;
          entryCandles = h1;
          entryTf = "H1";
        }
      }
      if (!signal && config.autoUseM15) {
        const latestM15 = m15.at(-1)?.time ?? "";
        if (latestM15 && latestM15 !== this.lastEvaluatedM15) {
          this.lastEvaluatedM15 = latestM15;
          const s = evaluateRuleSignal(m15, h4, strategy, h1); // entry M15, bias H4, trung gian H1
          if (s) {
            signal = s;
            entryCandles = m15;
            entryTf = "M15";
          }
        }
      }
      if (!signal) return;

      // 2 mức lot theo độ đẹp tất định (trên khung vào lệnh).
      const conviction = convictionScore(entryCandles, h4, signal, strategy);
      const lot =
        conviction >= config.autoVeryGoodMinConviction
          ? config.autoLotVeryGood
          : config.autoLotGood;

      const indicators = new IndicatorService().calculateMany(market.snapshots);
      const payload = new OpportunityPayloadBuilder().build(
        market,
        indicators,
        emptyNews(),
        config.accountSizeUsd,
      );

      // AI recheck TRƯỚC MỖI lệnh: chỉ vào khi AI đồng thuận (TRADE + cùng hướng).
      // AI từ chối hoặc lỗi -> BỎ QUA lệnh (đúng yêu cầu: phải recheck mới được vào).
      if (config.autoUseAiVetoOnBump) {
        try {
          const aiService = new AiAnalysisService({
            apiKey: config.evolinkApiKey,
            model: config.evolinkModel,
            baseUrl: config.evolinkBaseUrl,
            timeoutMs: config.aiTimeoutMs,
          });
          const recheck = await aiService.analyze(payload);
          if (
            recheck.parsed.decision !== "TRADE" ||
            recheck.parsed.direction !== signal.direction
          ) {
            console.info(
              `[auto-bot] AI recheck từ chối (${recheck.parsed.decision}/${recheck.parsed.direction}) -> bỏ qua lệnh ${entryTf}.`,
            );
            return;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(
            "[auto-bot] AI recheck lỗi -> bỏ qua lệnh (yêu cầu phải recheck trước khi vào):",
            msg,
          );
          await this.notifyError(
            config,
            "ai",
            `Gọi AI recheck thất bại nên BỎ QUA lệnh ${entryTf} ${signal.direction}. Lỗi: ${msg.slice(0, 200)}`,
          );
          return;
        }
      }

      // Đặt lệnh MARKET kèm SL/TP (server-side).
      const placed = await orderService.placeOrder({
        direction: signal.direction,
        orderType: "MARKET",
        volume: lot,
        price: null,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        comment: `auto-${entryTf.toLowerCase()}`,
      });
      this.tradesToday += 1;
      console.info(
        `[auto-bot] ĐẶT ${entryTf} ${signal.direction} ${lot} lot @${placed.price} SL ${signal.stopLoss} TP ${signal.takeProfit} (conviction ${conviction}, ticket ${placed.ticket})`,
      );

      // Ghi lịch sử để tracker/stats đo hiệu quả live.
      try {
        const historyService = new AnalysisHistoryService(
          new SupabaseService({
            url: config.supabaseUrl,
            serviceRoleKey: config.supabaseServiceRoleKey,
          }).getClient(),
        );
        const record = await historyService.create({
          requestPayload: payload,
          aiResponseRaw: "auto-bot rules-engine H1 (no AI decision)",
          parsedResult: buildAutoRecommendation(
            signal,
            lot,
            conviction,
            snapshot.price,
            payload,
            config.autoRrTarget,
          ),
        });
        await historyService.markOrderPlaced(record.id, {
          mt5_ticket: placed.ticket,
          order_type: placed.orderType,
          order_state: "FILLED",
        });
      } catch (error) {
        console.warn(
          "[auto-bot] không ghi được lịch sử:",
          error instanceof Error ? error.message : error,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("[auto-bot] tick lỗi:", msg);
      try {
        const config = useRuntimeConfig();
        await this.notifyError(config, "tick", `Tick lỗi: ${msg.slice(0, 250)}`);
      } catch {
        // useRuntimeConfig lỗi thì bỏ qua thông báo.
      }
    } finally {
      this.running = false;
    }
  }

  private async closeStaleOrders(
    orderService: Mt5OrderService,
    orders: { ticket: number; opened_at: string }[],
    maxHoldHours: number,
  ): Promise<void> {
    const now = Date.now();
    for (const order of orders) {
      const openedMs = new Date(order.opened_at).getTime();
      if (!Number.isFinite(openedMs)) continue;
      const ageHours = (now - openedMs) / 3_600_000;
      if (ageHours >= maxHoldHours) {
        try {
          await orderService.cancelOrder(order.ticket);
          console.info(
            `[auto-bot] đóng lệnh #${order.ticket} do giữ quá ${maxHoldHours}h (time-stop).`,
          );
        } catch (error) {
          console.warn(
            `[auto-bot] không đóng được #${order.ticket}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }

  // Gửi cảnh báo lỗi về Telegram, chống spam: cùng 1 loại lỗi tối đa 1 lần / 30 phút.
  private async notifyError(
    config: { telegramBotToken: string; telegramChatId: string },
    key: string,
    message: string,
  ): Promise<void> {
    if (!config.telegramBotToken || !config.telegramChatId) return;
    const now = Date.now();
    if (this.lastErrorKey === key && now - this.lastErrorNotifyAt < 30 * 60_000) {
      return;
    }
    this.lastErrorKey = key;
    this.lastErrorNotifyAt = now;
    try {
      await new TelegramService({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
      }).sendMessage(`⚠️ Auto-bot: ${message}`);
    } catch (error) {
      console.warn(
        "[auto-bot] gửi cảnh báo Telegram thất bại:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private rollDay(timeZone: string, equity: number): void {
    const key = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(new Date());
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayBaselineEquity = equity;
      this.tradesToday = 0;
      this.haltedForDay = false;
    }
  }
}

function emptyNews(): NewsSnapshot {
  return {
    items: [],
    upcomingEvents: [],
    status: "NO_RELEVANT_DATA",
    provider: "none",
    updatedAt: new Date().toISOString(),
    warnings: [],
  };
}

function buildAutoRecommendation(
  signal: RuleSignal,
  lot: number,
  conviction: number,
  currentPrice: number,
  payload: AnalysisPayload,
  rr: number,
): AiTradeRecommendation {
  const distance = Math.abs(signal.entry - signal.stopLoss);
  const estLoss = Number(
    (lot * distance * tradingRules.xauUsdOuncesPerLot).toFixed(2),
  );
  const confidence = conviction >= 2 ? 82 : 75;
  return {
    decision: "TRADE",
    symbol: "XAUUSD",
    direction: signal.direction,
    order_type: "MARKET",
    confidence,
    estimated_win_probability: confidence,
    entry_zone: { from: signal.entry, to: signal.entry },
    stop_loss: signal.stopLoss,
    stop_loss_reason: "SL ngoài swing gần nhất + đệm ATR(H1) — rules engine.",
    take_profit: signal.takeProfit,
    take_profit_reason: `TP = ${rr}R theo khoảng rủi ro.`,
    risk_reward: `1:${rr}`,
    expected_holding_time: "Theo SL/TP, tối đa vài giờ.",
    cancel_after_minutes: null,
    position_sizing: {
      account_size_usd: payload.accountSizeUsd,
      max_loss_usd: payload.maxLossUsdPerTrade,
      max_loss_percent: payload.maxLossPercentPerTrade,
      suggested_lot: lot,
      estimated_loss_if_sl_hit: estLoss,
      position_sizing_explanation: `Auto-bot fixed lot ${lot} (conviction ${conviction}/3).`,
    },
    current_price: currentPrice,
    market_context: signal.reason,
    trade_reason: signal.reason,
    entry_plan: "Vào MARKET ngay khi nến H1 xác nhận đóng.",
    summary: `Auto-bot Rules Engine H1: ${signal.direction} ${lot} lot.`,
    technical_analysis: {
      trend: "",
      momentum: "",
      support_resistance: "",
      volatility: "",
      timeframe_alignment: "",
    },
    news_analysis: {
      sentiment: "",
      supporting_news: [],
      risk_news: [],
      upcoming_high_impact_events: [],
    },
    main_reasons: [signal.reason],
    risk_factors: [],
    invalid_conditions: [],
    best_case_scenario: "",
    worst_case_scenario: "",
    pre_entry_checklist: [],
    no_trade_reason: "",
    next_check_suggestion: "",
    risky_trade: null,
    disclaimer: "Auto-bot demo — không phải lời khuyên tài chính.",
  };
}
