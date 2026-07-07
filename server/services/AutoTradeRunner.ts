import type { AiTradeRecommendation } from "../../types/ai";
import type {
  ActiveMt5Order,
  AnalysisPayload,
  MarketSnapshot,
  NewsSnapshot,
  SymbolCode,
} from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import {
  convictionScore,
  defaultRuleStrategyConfig,
  evaluateRuleSignal,
  explainRuleSignalRejection,
  type RuleSignal,
} from "../strategy/ruleStrategy";
import { AiAnalysisService } from "./AiAnalysisService";
import {
  runActiveSymbolOrderReviews,
  type ActiveOrderReviewItem,
} from "./ActiveOrderReviewRunner";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import { IndicatorService } from "./IndicatorService";
import { MarketDataService } from "./MarketDataService";
import { Mt5OrderService } from "./Mt5OrderService";
import { OpportunityPayloadBuilder } from "./OpportunityPayloadBuilder";
import { SupabaseService } from "./SupabaseService";
import { TelegramService } from "./TelegramService";
import { isInsideTradeScannerWindow, isScannerSlot } from "./TradeScannerService";
import { symbolCodeFromMt5Symbol, symbolLabel } from "../utils/symbols";

/**
 * Auto-bot Rules Engine H1.
 * Rules engine decides the setup. AI is only a final blocker/veto check.
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
  private lastActiveReviewAt = 0;
  private hadActiveOrders = false;
  private lastOrderClosedAt = 0;

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const config = useRuntimeConfig();
      const symbol = symbolCodeFromMt5Symbol(config.mt5Symbol);
      const activeSymbolLabel = symbolLabel(config.mt5Symbol);
      console.info(`[auto-bot] scanning ${activeSymbolLabel}`);
      const orderService = new Mt5OrderService({
        bridgeUrl: config.mt5BridgeUrl,
        symbol: config.mt5Symbol,
      });

      const account = await orderService.getAccount();
      this.rollDay(config.tradeScannerTimezone, account.equity);
      if (!account.tradeAllowed) {
        console.warn("[auto-bot] AutoTrading đang TẮT trong MT5.");
        await this.notifyError(
          config,
          "algo-off",
          "AutoTrading đang TẮT trong MT5, bot không đặt được lệnh. Hãy bật nút Algo Trading.",
        );
        return;
      }
      if (this.haltedForDay) {
        console.info("[auto-bot] đã chạm giới hạn lỗ/lệnh trong ngày, dừng vào lệnh.");
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

      const activeOrders = await orderService.getActiveOrders();
      if (activeOrders.length > 0) {
        this.hadActiveOrders = true;
        console.info(
          `[auto-bot] skipped new scan: ${activeOrders.length} active ${activeSymbolLabel} order(s)/position(s). Managing current order(s) only.`,
        );
        const closedByTimeStop = await this.closeStaleOrders(
          orderService,
          activeOrders,
          config.autoMaxHoldHours,
        );
        if (closedByTimeStop > 0) return;
        await this.manageActiveOrders(orderService, activeOrders);
        return;
      }
      if (this.hadActiveOrders) {
        this.hadActiveOrders = false;
        this.lastOrderClosedAt = Date.now();
        console.info(
          `[auto-bot] detected ${activeSymbolLabel} order closed; starting ${config.autoCooldownMinutes}m cooldown.`,
        );
      }
      this.lastActiveReviewAt = 0;

      const cooldownRemainingMs =
        this.lastOrderClosedAt > 0
          ? config.autoCooldownMinutes * 60_000 - (Date.now() - this.lastOrderClosedAt)
          : 0;
      if (cooldownRemainingMs > 0) {
        console.info(
          `[auto-bot] skipped new scan: cooldown active for ${Math.ceil(cooldownRemainingMs / 60_000)} more minute(s).`,
        );
        return;
      }

      if (this.tradesToday >= config.autoMaxTradesPerDay) {
        console.info("[auto-bot] đã đạt số lệnh tối đa/ngày.");
        return;
      }
      if (!isInsideTradeScannerWindow()) return;
      if (!isScannerSlot()) {
        console.info(
          `[auto-bot] skipped new setup scan: waiting for ${config.tradeScannerIntervalMinutes}m scan slot. Active-order management still runs every 5m.`,
        );
        return;
      }

      const marketService = new MarketDataService({
        providerName: config.marketDataProvider,
        apiKey: config.marketDataApiKey,
        baseUrl: config.marketDataBaseUrl,
        mt5BridgeUrl: config.mt5BridgeUrl,
        mt5Symbol: config.mt5Symbol,
        maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
        debug: false,
      });
      const market = await marketService.collectAll([symbol]);
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
        rrTarget: tradingRules.minRiskReward,
      };

      let signal: RuleSignal | null = null;
      let entryCandles = h1;
      let entryTf = "H1";
      let h1RejectReason = "H1 candle not evaluated yet";
      let m15RejectReason = config.autoUseM15
        ? "M15 candle not evaluated yet"
        : "M15 disabled";

      const latestH1 = h1.at(-1)?.time ?? "";
      if (latestH1 && latestH1 !== this.lastEvaluatedH1) {
        this.lastEvaluatedH1 = latestH1;
        const nextSignal = evaluateRuleSignal(h1, h4, strategy);
        if (nextSignal) {
          signal = nextSignal;
          entryCandles = h1;
          entryTf = "H1";
        } else {
          h1RejectReason =
            explainRuleSignalRejection(h1, h4, strategy) ?? "H1 passed diagnostics but returned no signal";
        }
      }

      if (!signal && config.autoUseM15) {
        const latestM15 = m15.at(-1)?.time ?? "";
        if (latestM15 && latestM15 !== this.lastEvaluatedM15) {
          this.lastEvaluatedM15 = latestM15;
          const nextSignal = evaluateRuleSignal(m15, h4, strategy, h1);
          if (nextSignal) {
            signal = nextSignal;
            entryCandles = m15;
            entryTf = "M15";
          } else {
            m15RejectReason =
              explainRuleSignalRejection(m15, h4, strategy, h1) ??
              "M15 passed diagnostics but returned no signal";
          }
        }
      }
      if (!signal) {
        console.info(
          `[auto-bot] no setup for ${activeSymbolLabel}. H1: ${h1RejectReason}. M15: ${m15RejectReason}.`,
        );
        return;
      }
      console.info(
        `[auto-bot] setup found ${activeSymbolLabel}: ${entryTf} ${signal.direction} entry ${signal.entry} SL ${signal.stopLoss} TP ${signal.takeProfit}`,
      );

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
        config.maxLossPercentPerTrade,
      );

      if (config.autoUseAiVetoOnBump) {
        try {
          const aiService = new AiAnalysisService({
            apiKey: config.evolinkApiKey,
            model: config.evolinkModel,
            baseUrl: config.evolinkBaseUrl,
            timeoutMs: config.aiTimeoutMs,
          });
          const veto = await aiService.reviewAutoTradeVeto({
            payload,
            signal,
            entryTimeframe: entryTf,
            conviction,
            lot,
            minRiskReward: tradingRules.minRiskReward,
            allowedLots: uniqueLots([config.autoLotGood, config.autoLotVeryGood]),
          });

          if (veto.parsed.decision === "BLOCK") {
            console.info(
              `[auto-bot] AI veto BLOCK -> bỏ qua lệnh ${entryTf}: ${veto.parsed.blocker_reasons.join(" | ") || veto.parsed.summary}`,
            );
            return;
          }
          const finalLot = lot;
          console.info(`[auto-bot] AI veto ALLOW for ${activeSymbolLabel}; keeping rules-engine entry/SL/TP unchanged.`);
          const adjusted = {
            order_type: "MARKET" as const,
            lot: finalLot,
            entry: signal.entry,
            stop_loss: signal.stopLoss,
            take_profit: signal.takeProfit,
            risk_reward: rewardRisk(signal.direction, signal.entry, signal.stopLoss, signal.takeProfit),
            reason: signal.reason,
          };
          const validationError = validateAdjustedAutoTrade(
            signal.direction,
            adjusted,
            tradingRules.minRiskReward,
            [config.autoLotGood, config.autoLotVeryGood],
          );
          if (validationError) {
            console.info(`[auto-bot] rules-engine trade invalid after AI ALLOW -> skip: ${validationError}`);
            return;
          }
          if (veto.parsed.warnings.length > 0) {
            console.info(
              `[auto-bot] AI veto ALLOW with warnings: ${veto.parsed.warnings.join(" | ")}`,
            );
          }
          const riskCheck = checkAutoRisk({
            symbol,
            entry: signal.entry,
            stopLoss: signal.stopLoss,
            lot: finalLot,
            accountSizeUsd: config.accountSizeUsd,
            maxLossPercentPerTrade: config.maxLossPercentPerTrade,
          });
          console.info(
            `[auto-bot] risk check ${activeSymbolLabel}: estimated loss ${riskCheck.estimatedLossUsd} USD, max allowed ${riskCheck.maxLossUsd} USD.`,
          );
          if (!riskCheck.allowed) {
            const message = `SKIP: estimated loss ${riskCheck.estimatedLossUsd} USD exceeds max loss ${riskCheck.maxLossUsd} USD`;
            console.info(`[auto-bot] ${message}`);
            await this.notifyAction(message);
            return;
          }
          const placed = await orderService.placeOrder({
            direction: signal.direction,
            orderType: "MARKET",
            volume: finalLot,
            price: null,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            comment: `auto-${entryTf.toLowerCase()}`,
          });
          this.tradesToday += 1;
          console.info(
            `[auto-bot] ĐẶT ${entryTf} ${signal.direction} ${finalLot} lot @${placed.price} SL ${signal.stopLoss} TP ${signal.takeProfit} (conviction ${conviction}, ticket ${placed.ticket})`,
          );

          try {
            const historyService = new AnalysisHistoryService(
              new SupabaseService({
                url: config.supabaseUrl,
                serviceRoleKey: config.supabaseServiceRoleKey,
              }).getClient(),
            );
            const record = await historyService.create({
              requestPayload: payload,
              aiResponseRaw: "auto-bot rules-engine with AI final trade check",
              parsedResult: buildAutoRecommendation(
                signal,
                finalLot,
                conviction,
                snapshot.price,
                payload,
                tradingRules.minRiskReward,
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
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn("[auto-bot] AI auto-veto lỗi -> bỏ qua lệnh:", msg);
          await this.notifyError(
            config,
            "ai",
            `Gọi AI auto-veto thất bại nên BỎ QUA lệnh ${entryTf} ${signal.direction}. Lỗi: ${msg.slice(0, 200)}`,
          );
          return;
        }
      }

      const validationError = validateAdjustedAutoTrade(
        signal.direction,
        {
          order_type: "MARKET",
          lot,
          entry: signal.entry,
          stop_loss: signal.stopLoss,
          take_profit: signal.takeProfit,
          risk_reward: rewardRisk(signal.direction, signal.entry, signal.stopLoss, signal.takeProfit),
          reason: signal.reason,
        },
        tradingRules.minRiskReward,
        [config.autoLotGood, config.autoLotVeryGood],
      );
      if (validationError) {
        console.info(`[auto-bot] rules signal không hợp lệ -> bỏ qua lệnh: ${validationError}`);
        return;
      }
      const riskCheck = checkAutoRisk({
        symbol,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        lot,
        accountSizeUsd: config.accountSizeUsd,
        maxLossPercentPerTrade: config.maxLossPercentPerTrade,
      });
      console.info(
        `[auto-bot] risk check ${activeSymbolLabel}: estimated loss ${riskCheck.estimatedLossUsd} USD, max allowed ${riskCheck.maxLossUsd} USD.`,
      );
      if (!riskCheck.allowed) {
        const message = `SKIP: estimated loss ${riskCheck.estimatedLossUsd} USD exceeds max loss ${riskCheck.maxLossUsd} USD`;
        console.info(`[auto-bot] ${message}`);
        await this.notifyAction(message);
        return;
      }
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

      try {
        const historyService = new AnalysisHistoryService(
          new SupabaseService({
            url: config.supabaseUrl,
            serviceRoleKey: config.supabaseServiceRoleKey,
          }).getClient(),
        );
        const record = await historyService.create({
          requestPayload: payload,
          aiResponseRaw: "auto-bot rules-engine with AI auto-veto",
          parsedResult: buildAutoRecommendation(
            signal,
            lot,
            conviction,
            snapshot.price,
            payload,
            tradingRules.minRiskReward,
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
        // Ignore secondary notification failure.
      }
    } finally {
      this.running = false;
    }
  }

  private async closeStaleOrders(
    orderService: Mt5OrderService,
    orders: { ticket: number; opened_at: string }[],
    maxHoldHours: number,
  ): Promise<number> {
    const now = Date.now();
    let closed = 0;
    for (const order of orders) {
      const openedMs = new Date(order.opened_at).getTime();
      if (!Number.isFinite(openedMs)) continue;
      const ageHours = (now - openedMs) / 3_600_000;
      if (ageHours >= maxHoldHours) {
        try {
          await orderService.cancelOrder(order.ticket);
          this.lastOrderClosedAt = Date.now();
          this.hadActiveOrders = false;
          closed += 1;
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
    return closed;
  }

  private async manageActiveOrders(
    orderService: Mt5OrderService,
    activeOrders: ActiveMt5Order[],
  ): Promise<void> {
    const snapshot = await this.collectActiveOrderSnapshot();
    await this.moveEligibleOrdersToBreakEven(orderService, activeOrders, snapshot);
    const config = useRuntimeConfig();
    const checks = activeOrders.map((order) =>
      ruleCheckActiveOrder(order, snapshot, config.maxQuoteAgeSeconds),
    );
    const escalationReasons = checks.flatMap((check) => check.reasons);
    if (escalationReasons.length === 0) {
      console.info("[auto-bot] active-order rule-check OK, chưa cần gọi AI.");
      return;
    }

    const now = Date.now();
    if (this.lastActiveReviewAt > 0 && now - this.lastActiveReviewAt < 15 * 60_000) {
      console.info(
        `[auto-bot] active-order rule-check có cảnh báo nhưng chưa đủ 15 phút gọi lại AI: ${escalationReasons.join(" | ")}`,
      );
      return;
    }
    this.lastActiveReviewAt = now;
    console.info(`[auto-bot] gọi AI review active order: ${escalationReasons.join(" | ")}`);

    const { reviews } = await runActiveSymbolOrderReviews();
    for (const item of reviews) {
      await this.applyActiveOrderReview(orderService, item);
    }
  }

  private async moveEligibleOrdersToBreakEven(
    orderService: Mt5OrderService,
    activeOrders: ActiveMt5Order[],
    snapshot: MarketSnapshot,
  ): Promise<void> {
    for (const order of activeOrders) {
      const breakEvenStop = breakEvenStopLoss(order, snapshot);
      if (breakEvenStop === null) continue;
      try {
        const result = await orderService.modifyOrder({
          ticket: order.ticket,
          stopLoss: breakEvenStop,
          takeProfit: null,
          comment: "auto-break-even-1r",
        });
        const message = `Moved SL to break-even for #${order.ticket}: SL ${result.stopLoss} after reaching >= 1R.`;
        console.info(`[auto-bot] ${message}`);
        await this.notifyAction(message);
      } catch (error) {
        console.warn(
          `[auto-bot] failed moving #${order.ticket} SL to break-even:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async collectActiveOrderSnapshot(): Promise<MarketSnapshot> {
    const config = useRuntimeConfig();
    const symbol = symbolCodeFromMt5Symbol(config.mt5Symbol);
    const marketService = new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
      mt5BridgeUrl: config.mt5BridgeUrl,
      mt5Symbol: config.mt5Symbol,
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
      debug: false,
    });
    const market = await marketService.collectAll([symbol]);
    const snapshot = market.snapshots[0];
    if (!snapshot) {
      throw new Error(`Không lấy được snapshot ${symbolLabel(config.mt5Symbol)} để rule-check lệnh active.`);
    }
    return snapshot;
  }

  private async applyActiveOrderReview(
    orderService: Mt5OrderService,
    item: ActiveOrderReviewItem,
  ): Promise<void> {
    const { order, review } = item;
    const action = review.recommended_action;

    if (action === "CANCEL_ORDER" && order.state === "PENDING") {
      const result = await orderService.cancelOrder(order.ticket);
      this.lastOrderClosedAt = Date.now();
      this.hadActiveOrders = false;
      await this.notifyAction(
        `Đã hủy lệnh chờ #${order.ticket}. Lý do AI: ${review.action_reason}. State: ${result.state}`,
      );
      return;
    }

    if (action === "CLOSE_MANUALLY" && order.state === "FILLED") {
      const result = await orderService.cancelOrder(order.ticket);
      this.lastOrderClosedAt = Date.now();
      this.hadActiveOrders = false;
      await this.notifyAction(
        `Đã đóng lệnh #${order.ticket}. Lý do AI: ${review.action_reason}. State: ${result.state}`,
      );
      return;
    }

    if (action !== "MOVE_SL" && action !== "MOVE_TP" && action !== "MOVE_SL_TP") {
      return;
    }

    const nextStopLoss =
      (action === "MOVE_SL" || action === "MOVE_SL_TP") &&
      isSaferStopLoss(order, review.current_price, review.stop_loss_plan.suggested_stop_loss)
        ? review.stop_loss_plan.suggested_stop_loss
        : null;
    const nextTakeProfit =
      (action === "MOVE_TP" || action === "MOVE_SL_TP") &&
      isValidTakeProfit(order, review.current_price, review.take_profit_plan.suggested_take_profit)
        ? review.take_profit_plan.suggested_take_profit
        : null;

    if (nextStopLoss === null && nextTakeProfit === null) {
      await this.notifyAction(
        `AI đề xuất ${action} cho #${order.ticket}, nhưng giá SL/TP đề xuất không hợp lệ hoặc không giảm rủi ro nên bot không sửa lệnh.`,
      );
      return;
    }

    const result = await orderService.modifyOrder({
      ticket: order.ticket,
      stopLoss: nextStopLoss,
      takeProfit: nextTakeProfit,
      comment: "auto-review-modify",
    });
    await this.notifyAction(
      [
        `Đã sửa lệnh #${order.ticket} theo AI review.`,
        `Action: ${action}`,
        `SL mới: ${result.stopLoss ?? "giữ nguyên"}`,
        `TP mới: ${result.takeProfit ?? "giữ nguyên"}`,
        `Lý do: ${review.action_reason}`,
      ].join("\n"),
    );
  }

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
      }).sendMessage(`Auto-bot: ${message}`);
    } catch (error) {
      console.warn(
        "[auto-bot] gửi cảnh báo Telegram thất bại:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async notifyAction(message: string): Promise<void> {
    const config = useRuntimeConfig();
    if (!config.telegramBotToken || !config.telegramChatId) return;
    try {
      await new TelegramService({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
      }).sendMessage(`Auto-bot quản lý lệnh:\n${message}`);
    } catch (error) {
      console.warn(
        "[auto-bot] gửi thông báo quản lý lệnh thất bại:",
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

interface AdjustedAutoTrade {
  order_type: "MARKET";
  lot: number;
  entry: number;
  stop_loss: number;
  take_profit: number;
  risk_reward: number;
  reason: string;
}

function uniqueLots(lots: number[]): number[] {
  return [...new Set(lots.filter((lot) => Number.isFinite(lot) && lot > 0))]
    .sort((left, right) => left - right);
}

function validateAdjustedAutoTrade(
  direction: RuleSignal["direction"],
  trade: AdjustedAutoTrade,
  minRiskReward: number,
  allowedLots: number[],
): string | null {
  const lots = uniqueLots(allowedLots);
  if (!lots.some((lot) => Math.abs(lot - trade.lot) < 0.000001)) {
    return `lot ${trade.lot} không nằm trong danh sách cho phép ${lots.join(", ")}`;
  }

  if (
    !Number.isFinite(trade.entry) ||
    !Number.isFinite(trade.stop_loss) ||
    !Number.isFinite(trade.take_profit)
  ) {
    return "entry/SL/TP không phải số hợp lệ";
  }

  const actualRr = rewardRisk(
    direction,
    trade.entry,
    trade.stop_loss,
    trade.take_profit,
  );
  if (!Number.isFinite(actualRr) || actualRr < minRiskReward) {
    return `RR thực tế ${actualRr.toFixed(2)} thấp hơn tối thiểu 1:${minRiskReward}`;
  }

  if (Math.abs(actualRr - trade.risk_reward) > 0.35) {
    return `RR AI khai báo ${trade.risk_reward} lệch nhiều so với RR thực tế ${actualRr.toFixed(2)}`;
  }

  if (direction === "BUY") {
    if (trade.stop_loss >= trade.entry) return "BUY có SL không nằm dưới entry";
    if (trade.take_profit <= trade.entry) return "BUY có TP không nằm trên entry";
  } else {
    if (trade.stop_loss <= trade.entry) return "SELL có SL không nằm trên entry";
    if (trade.take_profit >= trade.entry) return "SELL có TP không nằm dưới entry";
  }

  return null;
}

function rewardRisk(
  direction: RuleSignal["direction"],
  entry: number,
  stopLoss: number,
  takeProfit: number,
): number {
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  const reward = direction === "BUY"
    ? takeProfit - entry
    : entry - takeProfit;
  return reward / risk;
}

interface AutoRiskCheckInput {
  symbol: SymbolCode;
  entry: number;
  stopLoss: number;
  lot: number;
  accountSizeUsd: number;
  maxLossPercentPerTrade: number;
}

interface AutoRiskCheck {
  allowed: boolean;
  estimatedLossUsd: number;
  maxLossUsd: number;
}

function checkAutoRisk(input: AutoRiskCheckInput): AutoRiskCheck {
  const estimatedLossUsd = estimateLossUsd(input);
  const maxLossUsd = Number(
    (input.accountSizeUsd * (input.maxLossPercentPerTrade / 100)).toFixed(2),
  );
  return {
    allowed:
      Number.isFinite(estimatedLossUsd) &&
      estimatedLossUsd > 0 &&
      estimatedLossUsd <= maxLossUsd,
    estimatedLossUsd,
    maxLossUsd,
  };
}

function estimateLossUsd(input: {
  symbol: SymbolCode;
  entry: number;
  stopLoss: number;
  lot: number;
}): number {
  const distance = Math.abs(input.entry - input.stopLoss);
  if (!Number.isFinite(distance) || distance <= 0 || input.lot <= 0) return 0;

  if (input.symbol === "EURUSD") {
    const pipSize = 0.0001;
    const pipValuePerLot = 10;
    const slPips = distance / pipSize;
    return Number((slPips * pipValuePerLot * input.lot).toFixed(2));
  }

  // XAUUSD fallback: most MT5 gold contracts use 1.00 lot = 100 oz.
  return Number((input.lot * distance * tradingRules.xauUsdOuncesPerLot).toFixed(2));
}

function roundPrice(price: number, referencePrice: number): number {
  const digits = Math.abs(referencePrice) >= 100 ? 3 : 5;
  return Number(price.toFixed(digits));
}

function isSaferStopLoss(
  order: ActiveMt5Order,
  currentPrice: number,
  suggested: number | null,
): suggested is number {
  if (suggested === null || !Number.isFinite(suggested)) return false;

  if (order.state === "PENDING") {
    if (order.direction === "BUY") {
      return suggested < order.price_open && (order.stop_loss === null || suggested > order.stop_loss);
    }
    return suggested > order.price_open && (order.stop_loss === null || suggested < order.stop_loss);
  }

  if (order.direction === "BUY") {
    return suggested < currentPrice && (order.stop_loss === null || suggested > order.stop_loss);
  }
  return suggested > currentPrice && (order.stop_loss === null || suggested < order.stop_loss);
}

function isValidTakeProfit(
  order: ActiveMt5Order,
  currentPrice: number,
  suggested: number | null,
): suggested is number {
  if (suggested === null || !Number.isFinite(suggested)) return false;
  const referencePrice = order.state === "PENDING" ? order.price_open : currentPrice;
  return order.direction === "BUY"
    ? suggested > referencePrice
    : suggested < referencePrice;
}

function breakEvenStopLoss(
  order: ActiveMt5Order,
  snapshot: MarketSnapshot,
): number | null {
  if (order.state !== "FILLED" || order.stop_loss === null) return null;
  const riskDistance = Math.abs(order.price_open - order.stop_loss);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) return null;

  if (order.direction === "BUY") {
    if (order.stop_loss >= order.price_open) return null;
    if (snapshot.price < order.price_open + riskDistance) return null;
    return roundPrice(order.price_open, snapshot.price);
  }

  if (order.stop_loss <= order.price_open) return null;
  if (snapshot.price > order.price_open - riskDistance) return null;
  return roundPrice(order.price_open, snapshot.price);
}

interface ActiveOrderRuleCheck {
  shouldEscalate: boolean;
  reasons: string[];
}

function ruleCheckActiveOrder(
  order: ActiveMt5Order,
  snapshot: MarketSnapshot,
  maxQuoteAgeSeconds: number,
): ActiveOrderRuleCheck {
  const reasons: string[] = [];
  const currentPrice = snapshot.price;
  const risk = order.stop_loss !== null
    ? Math.abs(order.price_open - order.stop_loss)
    : null;

  if (snapshot.data_quality === "LOW" || snapshot.critical_errors.length > 0) {
    reasons.push("data quality thấp hoặc có critical error");
  }
  if (
    snapshot.quoteAgeSeconds === null ||
    snapshot.quoteAgeSeconds > maxQuoteAgeSeconds
  ) {
    reasons.push("quote MT5 stale");
  }
  if (order.stop_loss === null || order.take_profit === null) {
    reasons.push("lệnh active thiếu SL hoặc TP");
  }
  if (hasVolatilitySpike(snapshot)) {
    reasons.push("volatility spike trên candle gần nhất");
  }

  if (order.state === "PENDING") {
    const ageMinutes = orderAgeMinutes(order);
    if (ageMinutes !== null && ageMinutes >= 60) {
      reasons.push(`lệnh chờ đã ${Math.round(ageMinutes)} phút`);
    }
    if (risk !== null && risk > 0) {
      const driftFromEntry = Math.abs(currentPrice - order.price_open) / risk;
      if (driftFromEntry >= 1.2) {
        reasons.push(`giá đã lệch xa entry ${driftFromEntry.toFixed(1)}R`);
      }
    }
    return { shouldEscalate: reasons.length > 0, reasons };
  }

  if (risk !== null && risk > 0) {
    const openR = unrealizedR(order, currentPrice, risk);
    if (openR >= 1) {
      reasons.push(`lệnh đang lời ${openR.toFixed(1)}R, cân nhắc khóa lời/dời SL`);
    }
    if (openR <= -0.6) {
      reasons.push(`lệnh đang âm ${openR.toFixed(1)}R, cần kiểm tra thesis`);
    }

    const slDistanceRatio = distanceToStopRatio(order, currentPrice, risk);
    if (slDistanceRatio !== null && slDistanceRatio <= 0.25) {
      reasons.push(`giá còn cách SL khoảng ${slDistanceRatio.toFixed(2)}R`);
    }

    const tpDistanceRatio = distanceToTakeProfitRatio(order, currentPrice, risk);
    if (tpDistanceRatio !== null && tpDistanceRatio <= 0.25) {
      reasons.push(`giá còn cách TP khoảng ${tpDistanceRatio.toFixed(2)}R`);
    }
  }

  return { shouldEscalate: reasons.length > 0, reasons };
}

function orderAgeMinutes(order: ActiveMt5Order): number | null {
  const openedAt = new Date(order.opened_at).getTime();
  if (!Number.isFinite(openedAt)) return null;
  return (Date.now() - openedAt) / 60_000;
}

function unrealizedR(
  order: ActiveMt5Order,
  currentPrice: number,
  risk: number,
): number {
  const move = order.direction === "BUY"
    ? currentPrice - order.price_open
    : order.price_open - currentPrice;
  return move / risk;
}

function distanceToStopRatio(
  order: ActiveMt5Order,
  currentPrice: number,
  risk: number,
): number | null {
  if (order.stop_loss === null) return null;
  const distance = order.direction === "BUY"
    ? currentPrice - order.stop_loss
    : order.stop_loss - currentPrice;
  return distance / risk;
}

function distanceToTakeProfitRatio(
  order: ActiveMt5Order,
  currentPrice: number,
  risk: number,
): number | null {
  if (order.take_profit === null) return null;
  const distance = order.direction === "BUY"
    ? order.take_profit - currentPrice
    : currentPrice - order.take_profit;
  return distance / risk;
}

function hasVolatilitySpike(snapshot: MarketSnapshot): boolean {
  return hasTimeframeVolatilitySpike(snapshot, "M5") ||
    hasTimeframeVolatilitySpike(snapshot, "M15");
}

function hasTimeframeVolatilitySpike(
  snapshot: MarketSnapshot,
  timeframe: "M5" | "M15",
): boolean {
  const candles = snapshot.candles[timeframe];
  if (candles.length < 25) return false;
  const latest = candles.at(-1);
  if (!latest) return false;
  const recent = candles.slice(-21, -1);
  const averageRange =
    recent.reduce((sum, candle) => sum + Math.abs(candle.high - candle.low), 0) /
    recent.length;
  const latestRange = Math.abs(latest.high - latest.low);
  return averageRange > 0 && latestRange >= averageRange * 2.2;
}

function buildAutoRecommendation(
  signal: RuleSignal,
  lot: number,
  conviction: number,
  currentPrice: number,
  payload: AnalysisPayload,
  rr: number,
): AiTradeRecommendation {
  const symbol = payload.symbols[0]?.market.symbol ?? "EURUSD";
  const estLoss = estimateLossUsd({
    symbol,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    lot,
  });
  const confidence = conviction >= 2 ? 82 : 75;
  return {
    decision: "TRADE",
    symbol,
    direction: signal.direction,
    order_type: "MARKET",
    confidence,
    estimated_win_probability: confidence,
    entry_zone: { from: signal.entry, to: signal.entry },
    stop_loss: signal.stopLoss,
    stop_loss_reason: "SL ngoài swing gần nhất + đệm ATR(H1) theo rules engine.",
    take_profit: signal.takeProfit,
    take_profit_reason: `TP theo cấu trúc nến/vùng thanh khoản; RR tối thiểu yêu cầu là 1:${rr}.`,
    risk_reward: `>=1:${rr}`,
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
    entry_plan: "Vào MARKET ngay khi nến xác nhận đã đóng.",
    summary: `Auto-bot Rules Engine: ${signal.direction} ${lot} lot.`,
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
    disclaimer:
      "Auto-bot demo, đây không phải lời khuyên tài chính. Người dùng tự chịu trách nhiệm với quyết định giao dịch.",
  };
}
