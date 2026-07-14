import type { AiTradeRecommendation } from "../../types/ai";
import type {
  ActiveMt5Order,
  AnalysisPayload,
  Candle,
  MarketSnapshot,
  NewsSnapshot,
  SymbolCode,
} from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import {
  convictionScore,
  defaultRuleStrategyConfig,
  evaluateBalancedM5Signal,
  evaluateManualReversalScalpSignal,
  evaluateRuleSignal,
  evaluateXauTrendPullbackSetup,
  evaluateXauTrendPullbackSignal,
  evaluateXauTrendPullbackTriggerSignal,
  explainBalancedM5Rejection,
  explainManualReversalScalpRejection,
  explainRuleSignalRejection,
  explainXauPendingSetupInvalidation,
  explainXauTrendPullbackRejection,
  type RuleSignal,
  type XauTrendPullbackSetup,
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
interface PendingXauSetup {
  setup: XauTrendPullbackSetup;
  createdAt: number;
  createdM5Time: string;
  seenM5Times: string[];
}

export class AutoTradeRunner {
  private running = false;
  private runningScalp = false;
  private lastEvaluatedH1 = "";
  private lastEvaluatedM15 = "";
  private lastEvaluatedM5 = "";
  private lastM1ScalpTime = "";
  private dayKey = "";
  private dayBaselineEquity = 0;
  private tradesToday = 0;
  private haltedForDay = false;
  private lastErrorKey = "";
  private lastErrorNotifyAt = 0;
  private lastActiveReviewAt = 0;
  private hadActiveOrders = false;
  private lastOrderClosedAt = 0;
  private pendingSetup: PendingXauSetup | null = null;

  /**
   * Scalp auto-bot: chạy mỗi 1 phút khi AUTO_TRADE=true + AUTO_TRADE_SCALP=true.
   * Dùng cùng engine với MANUAL_SCALP (evaluateManualReversalScalpSignal).
   * Lot lấy từ AUTO_LOT_GOOD, không qua AI veto.
   */
  async runScalpOnce(): Promise<void> {
    if (this.runningScalp) return;
    this.runningScalp = true;
    try {
      const config = useRuntimeConfig();
      const symbol = symbolCodeFromMt5Symbol(config.mt5Symbol);
      const activeSymbolLabel = symbolLabel(config.mt5Symbol);
      console.info(`[scalp-bot] scanning ${activeSymbolLabel}`);

      const orderService = new Mt5OrderService({
        bridgeUrl: config.mt5BridgeUrl,
        symbol: config.mt5Symbol,
      });

      // Kiểm tra AutoTrading trên MT5
      const account = await orderService.getAccount();
      this.rollDay(config.tradeScannerTimezone, account.equity);
      if (!account.tradeAllowed) {
        console.warn("[scalp-bot] AutoTrading is OFF in MT5.");
        return;
      }
      const dailyLossLimitUsd = resolveDailyLossLimitUsd(
        this.dayBaselineEquity,
        config.autoMaxDailyLossUsd,
        config.autoMaxDailyLossPercent,
      );
      const dailyLossReached =
        this.dayBaselineEquity > 0 &&
        account.equity <= this.dayBaselineEquity - dailyLossLimitUsd;

      // Nếu đang có lệnh mở thì không scan setup mới
      const activeOrders = await orderService.getActiveOrders();
      if (activeOrders.length > 0) {
        this.hadActiveOrders = true;
        console.info(
          `[scalp-bot] managing ${activeOrders.length}/${config.autoScalpMaxOpenTrades} active ${activeSymbolLabel} order(s) before scanning.`,
        );
        try {
          await this.manageScalpProfitProtection(
            orderService,
            activeOrders,
            config.autoScalpTpR,
          );
        } catch (error) {
          console.warn(
            "[scalp-bot] profit-protection check failed:",
            error instanceof Error ? error.message : error,
          );
        }
        if (shouldFlatBeforeSessionClose(config.tradeScannerTimezone)) {
          const closed = await this.closeOrdersForSessionEnd(orderService, activeOrders);
          if (closed > 0) return;
        } else {
          const closed = await this.closeStaleOrdersByMinutes(
            orderService,
            activeOrders,
            config.autoScalpMaxHoldMinutes,
            "scalp",
          );
          if (closed > 0) return;
        }
        if (activeOrders.length >= config.autoScalpMaxOpenTrades) {
          console.info(
            `[scalp-bot] skipped new scan: max ${config.autoScalpMaxOpenTrades} concurrent orders reached.`,
          );
          return;
        }
      }

      // Daily limits block only new entries. Existing orders above are still
      // managed every minute even when their floating loss crosses the cap.
      if (dailyLossReached) {
        this.haltedForDay = true;
        console.warn(
          `[scalp-bot] kill-switch: daily equity loss reached ${dailyLossLimitUsd.toFixed(2)} USD.`,
        );
        return;
      }
      if (this.haltedForDay) {
        console.info("[scalp-bot] daily trade/loss limit reached, stop opening new trades.");
        return;
      }

      // Reset tracking khi không còn lệnh
      if (activeOrders.length === 0 && this.hadActiveOrders) {
        this.hadActiveOrders = false;
        this.lastOrderClosedAt = Date.now();
        const cooldownMinutes = Number(
          config.autoCooldownM15Candles
            ? config.autoCooldownM15Candles * 15
            : config.autoCooldownMinutes,
        );
        console.info(
          `[scalp-bot] detected ${activeSymbolLabel} order closed; starting ${cooldownMinutes}m cooldown.`,
        );
      }

      // Cooldown sau lệnh vừa đóng
      const cooldownMinutes = Number(
        config.autoCooldownM15Candles
          ? config.autoCooldownM15Candles * 15
          : config.autoCooldownMinutes,
      );
      const cooldownRemainingMs =
        this.lastOrderClosedAt > 0
          ? cooldownMinutes * 60_000 - (Date.now() - this.lastOrderClosedAt)
          : 0;
      if (cooldownRemainingMs > 0) {
        console.info(
          `[scalp-bot] skipped: cooldown active for ${Math.ceil(cooldownRemainingMs / 60_000)} more minute(s).`,
        );
        return;
      }

      if (this.tradesToday >= config.autoMaxTradesPerDay) {
        console.info("[scalp-bot] max trades/day reached.");
        return;
      }

      const timeBlockReason = await getAutoTradeTimeBlockReason(config.tradeScannerTimezone);
      if (timeBlockReason) {
        console.info(`[scalp-bot] skipped: ${timeBlockReason}`);
        return;
      }
      if (!isInsideTradeScannerWindow()) {
        console.info(
          `[scalp-bot] skipped: outside trade window ${config.tradeScannerWindows || `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`} ${config.tradeScannerTimezone}.`,
        );
        return;
      }

      // Fetch market data
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
        console.info("[scalp-bot] skipped: data_quality LOW or missing snapshot.");
        return;
      }

      const m1 = snapshot.candles.M1 ?? [];
      const m5 = snapshot.candles.M5;
      const m15 = snapshot.candles.M15;
      const h1 = snapshot.candles.H1;

      // Dedup: không đặt lệnh 2 lần trên cùng cây nến M1
      const latestM1Time = m1.at(-1)?.time ?? "";
      if (latestM1Time && latestM1Time === this.lastM1ScalpTime) {
        console.info(`[scalp-bot] skipped: already evaluated M1 candle ${latestM1Time}.`);
        return;
      }

      // Evaluate scalp signal
      const signal = evaluateManualReversalScalpSignal(m1, m5, m15, h1, {
        takeProfitR: config.autoScalpTpR,
        frequency: config.autoScalpFrequency === "high" ? "high" : "normal",
      });
      if (!signal) {
        const reason =
          explainManualReversalScalpRejection(m1, m5, m15, h1, {
            takeProfitR: config.autoScalpTpR,
            frequency: config.autoScalpFrequency === "high" ? "high" : "normal",
          }) ??
          "scalp diagnostics returned no reason";
        console.info(`[scalp-bot] no scalp signal for ${activeSymbolLabel}: ${reason}`);
        // Vẫn mark nến này đã xét để tránh spam log
        if (latestM1Time) this.lastM1ScalpTime = latestM1Time;
        return;
      }

      // Cập nhật dedup sau khi tìm được signal
      if (latestM1Time) this.lastM1ScalpTime = latestM1Time;

      const oppositeOrder = activeOrders.find(
        (order) => order.direction !== signal.direction,
      );
      if (oppositeOrder) {
        console.info(
          `[scalp-bot] SKIP: ${signal.direction} signal conflicts with active ${oppositeOrder.direction} #${oppositeOrder.ticket}; hedge/reversal is disabled.`,
        );
        return;
      }

      console.info(
        `[scalp-bot] signal found ${activeSymbolLabel}: M1 ${signal.direction} entry ${signal.entry} SL ${signal.stopLoss} TP ${signal.takeProfit}`,
      );

      // Kiểm tra spread
      const spreadBlock = highSpreadBlockReason(snapshot);
      if (spreadBlock) {
        console.info(`[scalp-bot] ${spreadBlock}`);
        return;
      }

      // Auto-scalp dùng lot cấu hình để đổi symbol/risk linh hoạt hơn.
      const lot = config.autoLotGood;

      // Kiểm tra risk
      const riskCheck = checkAutoRisk({
        symbol,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        lot,
        accountSizeUsd: config.accountSizeUsd,
        maxLossPercentPerTrade: riskPercentForSignal(signal, config.maxLossPercentPerTrade),
      });
      console.info(
        `[scalp-bot] risk check ${activeSymbolLabel}: estimated loss ${riskCheck.estimatedLossUsd} USD, max allowed ${riskCheck.maxLossUsd} USD.`,
      );
      if (!riskCheck.allowed) {
        const message = `SKIP: estimated loss ${riskCheck.estimatedLossUsd} USD exceeds max loss ${riskCheck.maxLossUsd} USD`;
        console.info(`[scalp-bot] ${message}`);
        return;
      }

      // Đặt lệnh
      const latestActiveOrders = await orderService.getActiveOrders();
      if (latestActiveOrders.length >= config.autoScalpMaxOpenTrades) {
        console.info(
          `[scalp-bot] SKIP: active order count changed and max ${config.autoScalpMaxOpenTrades} is now reached.`,
        );
        return;
      }
      const latestOppositeOrder = latestActiveOrders.find(
        (order) => order.direction !== signal.direction,
      );
      if (latestOppositeOrder) {
        console.info(
          `[scalp-bot] SKIP: active order state changed; ${latestOppositeOrder.direction} #${latestOppositeOrder.ticket} conflicts with ${signal.direction}.`,
        );
        return;
      }
      const openRemainingRiskUsd = latestActiveOrders.reduce(
        (total, order) => total + estimateRemainingOrderDownsideUsd(order, symbol),
        0,
      );
      const latestAccount = await orderService.getAccount();
      const dailyRiskCheck = checkAggregateDailyRisk({
        currentEquity: latestAccount.equity,
        dayBaselineEquity: this.dayBaselineEquity,
        dailyLossLimitUsd,
        openRemainingRiskUsd,
        candidateLossUsd: riskCheck.estimatedLossUsd,
      });
      console.info(
        `[scalp-bot] aggregate risk: open remaining ${dailyRiskCheck.openRemainingRiskUsd} USD + candidate ${dailyRiskCheck.candidateLossUsd} USD; projected worst equity ${dailyRiskCheck.projectedWorstEquity} USD, daily floor ${dailyRiskCheck.dailyFloorEquity} USD.`,
      );
      if (!dailyRiskCheck.allowed) {
        console.info(
          `[scalp-bot] SKIP: aggregate risk would exceed daily loss limit ${dailyLossLimitUsd.toFixed(2)} USD.`,
        );
        return;
      }

      const placed = await orderService.placeOrder({
        direction: signal.direction,
        orderType: "MARKET",
        volume: lot,
        price: null,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        comment: `scalp-m1`,
      });
      this.tradesToday += 1;
      this.hadActiveOrders = true;
      console.info(
        `[scalp-bot] PLACED M1 ${signal.direction} ${lot} lot @${placed.price} SL ${signal.stopLoss} TP ${signal.takeProfit} (ticket ${placed.ticket})`,
      );

      // Ghi history
      try {
        const indicators = new IndicatorService().calculateMany(market.snapshots);
        const payload = new OpportunityPayloadBuilder().build(
          market,
          indicators,
          emptyNews(),
          config.accountSizeUsd,
          config.maxLossPercentPerTrade,
        );
        const historyService = new AnalysisHistoryService(
          new SupabaseService({
            url: config.supabaseUrl,
            serviceRoleKey: config.supabaseServiceRoleKey,
          }).getClient(),
        );
        const record = await historyService.create({
          requestPayload: payload,
          aiResponseRaw: "scalp-bot auto reversal scalp (no AI veto)",
          parsedResult: buildAutoRecommendation(
            signal,
            lot,
            1,
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
          "[scalp-bot] failed writing history:",
          error instanceof Error ? error.message : error,
        );
      }

      // Do not send Telegram on successful entry; the user checks MT5 directly.
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("[scalp-bot] tick error:", msg);
    } finally {
      this.runningScalp = false;
    }
  }

  async runManagementOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const config = useRuntimeConfig();
      const activeSymbolLabel = symbolLabel(config.mt5Symbol);
      const orderService = new Mt5OrderService({
        bridgeUrl: config.mt5BridgeUrl,
        symbol: config.mt5Symbol,
      });
      const activeOrders = await orderService.getActiveOrders();
      if (activeOrders.length === 0) {
        await this.managePendingSetup(orderService);
        return;
      }

      this.hadActiveOrders = true;
      this.pendingSetup = null;
      console.info(
        `[auto-bot] 1m management: ${activeOrders.length} active ${activeSymbolLabel} order(s)/position(s).`,
      );
      if (shouldFlatBeforeSessionClose(config.tradeScannerTimezone)) {
        const closed = await this.closeOrdersForSessionEnd(orderService, activeOrders);
        if (closed > 0) return;
      }
      const closedByTimeStop = await this.closeStaleOrders(
        orderService,
        activeOrders,
        config.autoMaxHoldHours,
      );
      if (closedByTimeStop > 0) return;
      await this.manageActiveOrders(orderService, activeOrders);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("[auto-bot] management tick error:", msg);
    } finally {
      this.running = false;
    }
  }

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
        console.warn("[auto-bot] AutoTrading is OFF in MT5.");
        await this.notifyError(
          config,
          "algo-off",
          "AutoTrading is OFF in MT5, bot cannot place orders. Please enable Algo Trading.",
        );
        return;
      }
      if (this.haltedForDay) {
        console.info("[auto-bot] daily trade/loss limit reached, stop opening new trades.");
        return;
      }
      const dailyLossLimitUsd = resolveDailyLossLimitUsd(
        this.dayBaselineEquity,
        config.autoMaxDailyLossUsd,
        config.autoMaxDailyLossPercent,
      );
      if (
        this.dayBaselineEquity > 0 &&
        account.equity <= this.dayBaselineEquity - dailyLossLimitUsd
      ) {
        this.haltedForDay = true;
        console.warn(
          `[auto-bot] kill-switch: daily equity loss reached ${dailyLossLimitUsd.toFixed(2)} USD.`,
        );
        return;
      }

      const activeOrders = await orderService.getActiveOrders();
      if (activeOrders.length > 0) {
        this.hadActiveOrders = true;
        console.info(
          `[auto-bot] skipped new scan: ${activeOrders.length} active ${activeSymbolLabel} order(s)/position(s). Managing current order(s) only.`,
        );
        if (shouldFlatBeforeSessionClose(config.tradeScannerTimezone)) {
          const closed = await this.closeOrdersForSessionEnd(orderService, activeOrders);
          if (closed > 0) return;
        }
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
        const cooldownMinutes = Number(
          config.autoCooldownM15Candles
            ? config.autoCooldownM15Candles * 15
            : config.autoCooldownMinutes,
        );
        console.info(
          `[auto-bot] detected ${activeSymbolLabel} order closed; starting ${cooldownMinutes}m cooldown.`,
        );
      }
      this.lastActiveReviewAt = 0;

      const cooldownMinutes = Number(
        config.autoCooldownM15Candles
          ? config.autoCooldownM15Candles * 15
          : config.autoCooldownMinutes,
      );
      const cooldownRemainingMs =
        this.lastOrderClosedAt > 0
          ? cooldownMinutes * 60_000 - (Date.now() - this.lastOrderClosedAt)
          : 0;
      if (cooldownRemainingMs > 0) {
        console.info(
          `[auto-bot] skipped new scan: cooldown active for ${Math.ceil(cooldownRemainingMs / 60_000)} more minute(s).`,
        );
        return;
      }

      if (this.tradesToday >= config.autoMaxTradesPerDay) {
        console.info("[auto-bot] max trades/day reached.");
        return;
      }
      const timeBlockReason = await getAutoTradeTimeBlockReason(config.tradeScannerTimezone);
      if (timeBlockReason) {
        console.info(`[auto-bot] skipped new scan: ${timeBlockReason}`);
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
        console.info("[auto-bot] skipped: data_quality LOW or missing snapshot.");
        return;
      }

      const h1 = snapshot.candles.H1;
      const h4 = snapshot.candles.H4;
      const m15 = snapshot.candles.M15;
      const m5 = snapshot.candles.M5;
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
      const strategyMode =
        String(config.autoStrategyMode).toLowerCase() === "xau_trend_pullback"
          ? "xau_trend_pullback"
          : String(config.autoStrategyMode).toLowerCase() === "balanced"
            ? "balanced"
            : "strict";

      if (strategyMode === "xau_trend_pullback") {
        h1RejectReason = "XAU rule uses H1 as trend filter";
        const latestM5 = m5.at(-1)?.time ?? "";
        if (latestM5 && latestM5 !== this.lastEvaluatedM5) {
          this.lastEvaluatedM5 = latestM5;
          const nextSignal = evaluateXauTrendPullbackSignal(m5, m15, h1, {
            allowScalp: config.autoAllowScalp,
          });
          if (nextSignal) {
            this.pendingSetup = null;
            signal = nextSignal;
            entryCandles = m5;
            entryTf = "M5";
          } else {
            const setup = evaluateXauTrendPullbackSetup(m15, h1, m5);
            if (setup) {
              this.pendingSetup = {
                setup,
                createdAt: Date.now(),
                createdM5Time: latestM5,
                seenM5Times: [latestM5],
              };
              console.info(
                `[auto-bot] pending setup saved: ${activeSymbolLabel} ${setup.direction}, M15 ${setup.m15CandleTime}; waiting max 6 closed M5 candles for trigger.`,
              );
            }
            m15RejectReason =
              setup
                ? `pending ${setup.direction} setup; waiting for M5 engulfing/pin trigger`
                :
              explainXauTrendPullbackRejection(m5, m15, h1, {
                allowScalp: config.autoAllowScalp,
              }) ??
              "XAU trend-pullback diagnostics returned no signal";
          }
        }
      } else if (strategyMode === "balanced") {
        h1RejectReason = "balanced mode uses H1 as bias, not as entry";
        if (!config.autoUseM15) {
          m15RejectReason = "balanced mode requires AUTO_USE_M15=true";
        }
        const latestM5 = m5.at(-1)?.time ?? "";
        if (latestM5 && latestM5 !== this.lastEvaluatedM5) {
          this.lastEvaluatedM5 = latestM5;
          const nextSignal = evaluateBalancedM5Signal(m5, m15, h1, h4, strategy);
          if (nextSignal) {
            signal = nextSignal;
            entryCandles = m5;
            entryTf = "M5";
          } else {
            m15RejectReason =
              explainBalancedM5Rejection(m5, m15, h1, h4, strategy) ??
              "M5 passed balanced diagnostics but returned no signal";
          }
        }
      } else {
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
      }
      if (!signal) {
        const secondaryLabel = strategyMode === "balanced" ? "Balanced" : "M15";
        console.info(
          `[auto-bot] no setup for ${activeSymbolLabel} (${strategyMode}). H1: ${h1RejectReason}. ${secondaryLabel}: ${m15RejectReason}.`,
        );
        return;
      }
      console.info(
        `[auto-bot] setup found ${activeSymbolLabel} (${strategyMode}): ${entryTf} ${signal.direction} entry ${signal.entry} SL ${signal.stopLoss} TP ${signal.takeProfit}`,
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
              `[auto-bot] AI veto BLOCK -> skip ${entryTf}: ${veto.parsed.blocker_reasons.join(" | ") || veto.parsed.summary}`,
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
          const spreadBlock = highSpreadBlockReason(snapshot);
          if (spreadBlock) {
            console.info(`[auto-bot] ${spreadBlock}`);
            await this.notifyAction(spreadBlock);
            return;
          }
          const riskCheck = checkAutoRisk({
            symbol,
            entry: signal.entry,
            stopLoss: signal.stopLoss,
            lot: finalLot,
            accountSizeUsd: config.accountSizeUsd,
            maxLossPercentPerTrade: riskPercentForSignal(signal, config.maxLossPercentPerTrade),
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
            `[auto-bot] PLACED ${entryTf} ${signal.direction} ${finalLot} lot @${placed.price} SL ${signal.stopLoss} TP ${signal.takeProfit} (conviction ${conviction}, ticket ${placed.ticket})`,
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
              "[auto-bot] failed writing history:",
              error instanceof Error ? error.message : error,
            );
          }
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (config.autoTradeOnAiError) {
            console.warn(
              "[auto-bot] AI auto-veto error, fallback to Rule Engine:",
              msg,
            );
            await this.notifyError(
              config,
              "ai-fallback",
              [
                "AI auto-veto failed but AUTO_TRADE_ON_AI_ERROR=true, so bot will continue with Rule Engine.",
                `Symbol: ${activeSymbolLabel}`,
                `Setup: ${entryTf} ${signal.direction}`,
                `Entry: ${signal.entry}`,
                `SL: ${signal.stopLoss}`,
                `TP: ${signal.takeProfit}`,
                `AI error: ${msg.slice(0, 200)}`,
                "Please check Gemini/Evolink quota or API status.",
              ].join("\n"),
            );
          } else {
          console.warn("[auto-bot] AI auto-veto error -> skip trade:", msg);
          await this.notifyError(
            config,
            "ai",
            `AI auto-veto failed, so SKIP ${entryTf} ${signal.direction}. Error: ${msg.slice(0, 200)}`,
          );
          return;
          }
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
        console.info(`[auto-bot] rules signal invalid -> skip: ${validationError}`);
        return;
      }
      const spreadBlock = highSpreadBlockReason(snapshot);
      if (spreadBlock) {
        console.info(`[auto-bot] ${spreadBlock}`);
        await this.notifyAction(spreadBlock);
        return;
      }
      const riskCheck = checkAutoRisk({
        symbol,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        lot,
        accountSizeUsd: config.accountSizeUsd,
        maxLossPercentPerTrade: riskPercentForSignal(signal, config.maxLossPercentPerTrade),
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
        `[auto-bot] PLACED ${entryTf} ${signal.direction} ${lot} lot @${placed.price} SL ${signal.stopLoss} TP ${signal.takeProfit} (conviction ${conviction}, ticket ${placed.ticket})`,
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
          "[auto-bot] failed writing history:",
          error instanceof Error ? error.message : error,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("[auto-bot] tick error:", msg);
      try {
        const config = useRuntimeConfig();
        await this.notifyError(config, "tick", `Tick error: ${msg.slice(0, 250)}`);
      } catch {
        // Ignore secondary notification failure.
      }
    } finally {
      this.running = false;
    }
  }

  private async managePendingSetup(orderService: Mt5OrderService): Promise<void> {
    if (!this.pendingSetup) return;

    const config = useRuntimeConfig();
    const symbol = symbolCodeFromMt5Symbol(config.mt5Symbol);
    const activeSymbolLabel = symbolLabel(config.mt5Symbol);
    const timeBlockReason = await getAutoTradeTimeBlockReason(config.tradeScannerTimezone);
    if (timeBlockReason) {
      console.info(`[auto-bot] pending setup cancelled: ${timeBlockReason}`);
      this.pendingSetup = null;
      return;
    }
    if (!isInsideTradeScannerWindow()) {
      console.info("[auto-bot] pending setup on hold: outside trade window, will not trigger new entry.");
      return;
    }
    if (this.tradesToday >= config.autoMaxTradesPerDay) {
      console.info("[auto-bot] pending setup cancelled: max trades/day reached.");
      this.pendingSetup = null;
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
      console.info("[auto-bot] pending setup wait: data_quality LOW or missing snapshot.");
      return;
    }

    const h1 = snapshot.candles.H1;
    const h4 = snapshot.candles.H4;
    const m15 = snapshot.candles.M15;
    const m5 = snapshot.candles.M5;
    const latestM5Time = m5.at(-1)?.time ?? "";
    if (latestM5Time && !this.pendingSetup.seenM5Times.includes(latestM5Time)) {
      this.pendingSetup.seenM5Times.push(latestM5Time);
    }

    if (this.pendingSetup.seenM5Times.length > 6) {
      console.info(
        `[auto-bot] pending setup expired: no M5 trigger after 6 closed M5 candles (${activeSymbolLabel} ${this.pendingSetup.setup.direction}).`,
      );
      this.pendingSetup = null;
      return;
    }

    const invalidReason = explainXauPendingSetupInvalidation(
      this.pendingSetup.setup,
      m15,
      h1,
    );
    if (invalidReason) {
      console.info(`[auto-bot] pending setup cancelled: ${invalidReason}`);
      this.pendingSetup = null;
      return;
    }

    const signal = evaluateXauTrendPullbackTriggerSignal(
      m5,
      m15,
      h1,
      this.pendingSetup.setup,
      { allowScalp: config.autoAllowScalp },
    );
    if (!signal) {
      console.info(
        `[auto-bot] pending setup still waiting: ${activeSymbolLabel} ${this.pendingSetup.setup.direction}, ${this.pendingSetup.seenM5Times.length}/6 M5 candles.`,
      );
      return;
    }

    console.info(
      `[auto-bot] pending setup triggered: ${activeSymbolLabel} M5 ${signal.direction} entry ${signal.entry} SL ${signal.stopLoss} TP ${signal.takeProfit}`,
    );
    const placed = await this.placePendingTriggeredSignal({
      orderService,
      market,
      snapshot,
      signal,
      entryCandles: m5,
      biasCandles: h4,
      entryTf: "M5",
      activeSymbolLabel,
      symbol,
    });
    if (placed) this.pendingSetup = null;
  }

  private async placePendingTriggeredSignal(input: {
    orderService: Mt5OrderService;
    market: Awaited<ReturnType<MarketDataService["collectAll"]>>;
    snapshot: MarketSnapshot;
    signal: RuleSignal;
    entryCandles: Candle[];
    biasCandles: Candle[];
    entryTf: string;
    activeSymbolLabel: string;
    symbol: SymbolCode;
  }): Promise<boolean> {
    const config = useRuntimeConfig();
    const strategy = {
      ...defaultRuleStrategyConfig,
      rrTarget: tradingRules.minRiskReward,
    };
    const conviction = convictionScore(
      input.entryCandles,
      input.biasCandles,
      input.signal,
      strategy,
    );
    const lot =
      conviction >= config.autoVeryGoodMinConviction
        ? config.autoLotVeryGood
        : config.autoLotGood;
    const indicators = new IndicatorService().calculateMany(input.market.snapshots);
    const payload = new OpportunityPayloadBuilder().build(
      input.market,
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
          signal: input.signal,
          entryTimeframe: input.entryTf,
          conviction,
          lot,
          minRiskReward: tradingRules.minRiskReward,
          allowedLots: uniqueLots([config.autoLotGood, config.autoLotVeryGood]),
        });
        if (veto.parsed.decision === "BLOCK") {
          console.info(
            `[auto-bot] AI veto BLOCK -> skip pending trigger ${input.entryTf}: ${veto.parsed.blocker_reasons.join(" | ") || veto.parsed.summary}`,
          );
          return false;
        }
        console.info("[auto-bot] AI veto ALLOW for pending trigger; keeping rules-engine entry/SL/TP unchanged.");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!config.autoTradeOnAiError) {
          console.warn("[auto-bot] AI auto-veto error -> skip pending trigger:", msg);
          await this.notifyError(
            config,
            "ai-pending",
            `AI auto-veto failed, so SKIP pending trigger ${input.entryTf} ${input.signal.direction}. Error: ${msg.slice(0, 200)}`,
          );
          return false;
        }
        console.warn("[auto-bot] AI auto-veto error, fallback pending trigger to Rule Engine:", msg);
        await this.notifyError(
          config,
          "ai-pending-fallback",
          [
            "AI auto-veto failed for pending trigger but AUTO_TRADE_ON_AI_ERROR=true, so bot will continue with Rule Engine.",
            `Symbol: ${input.activeSymbolLabel}`,
            `Setup: ${input.entryTf} ${input.signal.direction}`,
            `Entry: ${input.signal.entry}`,
            `SL: ${input.signal.stopLoss}`,
            `TP: ${input.signal.takeProfit}`,
            `AI error: ${msg.slice(0, 200)}`,
          ].join("\n"),
        );
      }
    }

    const validationError = validateAdjustedAutoTrade(
      input.signal.direction,
      {
        order_type: "MARKET",
        lot,
        entry: input.signal.entry,
        stop_loss: input.signal.stopLoss,
        take_profit: input.signal.takeProfit,
        risk_reward: rewardRisk(
          input.signal.direction,
          input.signal.entry,
          input.signal.stopLoss,
          input.signal.takeProfit,
        ),
        reason: input.signal.reason,
      },
      tradingRules.minRiskReward,
      [config.autoLotGood, config.autoLotVeryGood],
    );
    if (validationError) {
      console.info(`[auto-bot] pending trigger invalid -> skip: ${validationError}`);
      return false;
    }

    const spreadBlock = highSpreadBlockReason(input.snapshot);
    if (spreadBlock) {
      console.info(`[auto-bot] ${spreadBlock}`);
      await this.notifyAction(spreadBlock);
      return false;
    }

    const riskCheck = checkAutoRisk({
      symbol: input.symbol,
      entry: input.signal.entry,
      stopLoss: input.signal.stopLoss,
      lot,
      accountSizeUsd: config.accountSizeUsd,
      maxLossPercentPerTrade: riskPercentForSignal(input.signal, config.maxLossPercentPerTrade),
    });
    console.info(
      `[auto-bot] pending trigger risk check ${input.activeSymbolLabel}: estimated loss ${riskCheck.estimatedLossUsd} USD, max allowed ${riskCheck.maxLossUsd} USD.`,
    );
    if (!riskCheck.allowed) {
      const message = `SKIP pending trigger: estimated loss ${riskCheck.estimatedLossUsd} USD exceeds max loss ${riskCheck.maxLossUsd} USD`;
      console.info(`[auto-bot] ${message}`);
      await this.notifyAction(message);
      return false;
    }

    const placed = await input.orderService.placeOrder({
      direction: input.signal.direction,
      orderType: "MARKET",
      volume: lot,
      price: null,
      stopLoss: input.signal.stopLoss,
      takeProfit: input.signal.takeProfit,
      comment: `auto-pending-${input.entryTf.toLowerCase()}`,
    });
    this.tradesToday += 1;
    console.info(
      `[auto-bot] PLACED pending-trigger ${input.entryTf} ${input.signal.direction} ${lot} lot @${placed.price} SL ${input.signal.stopLoss} TP ${input.signal.takeProfit} (conviction ${conviction}, ticket ${placed.ticket})`,
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
        aiResponseRaw: "auto-bot pending setup triggered by M5 rule engine",
        parsedResult: buildAutoRecommendation(
          input.signal,
          lot,
          conviction,
          input.snapshot.price,
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
        "[auto-bot] failed writing pending-trigger history:",
        error instanceof Error ? error.message : error,
      );
    }
    return true;
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
            `[auto-bot] closed #${order.ticket}: held longer than ${maxHoldHours}h (time-stop).`,
          );
        } catch (error) {
          console.warn(
            `[auto-bot] failed closing #${order.ticket}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    return closed;
  }

  private async closeStaleOrdersByMinutes(
    orderService: Mt5OrderService,
    orders: { ticket: number; opened_at: string }[],
    maxHoldMinutes: number,
    label = "auto",
  ): Promise<number> {
    const minutes = Number.isFinite(maxHoldMinutes) && maxHoldMinutes > 0 ? maxHoldMinutes : 30;
    const now = Date.now();
    let closed = 0;
    for (const order of orders) {
      const openedMs = new Date(order.opened_at).getTime();
      if (!Number.isFinite(openedMs)) continue;
      const ageMinutes = (now - openedMs) / 60_000;
      if (ageMinutes >= minutes) {
        try {
          await orderService.cancelOrder(order.ticket);
          this.lastOrderClosedAt = Date.now();
          this.hadActiveOrders = false;
          closed += 1;
          console.info(
            `[${label}-bot] closed #${order.ticket}: held longer than ${minutes}m (time-stop).`,
          );
        } catch (error) {
          console.warn(
            `[${label}-bot] failed closing #${order.ticket}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    return closed;
  }

  private async closeOrdersForSessionEnd(
    orderService: Mt5OrderService,
    orders: { ticket: number }[],
  ): Promise<number> {
    let closed = 0;
    for (const order of orders) {
      try {
        await orderService.cancelOrder(order.ticket);
        this.lastOrderClosedAt = Date.now();
        this.hadActiveOrders = false;
        closed += 1;
        console.info(
          `[auto-bot] close #${order.ticket}: session end rule before 23:45 VN.`,
        );
      } catch (error) {
        console.warn(
          `[auto-bot] failed closing #${order.ticket} for session end:`,
          error instanceof Error ? error.message : error,
        );
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
      console.info("[auto-bot] active-order rule-check OK, no AI review needed.");
      return;
    }

    const now = Date.now();
    if (this.lastActiveReviewAt > 0 && now - this.lastActiveReviewAt < 15 * 60_000) {
      console.info(
        `[auto-bot] active-order warnings found, but AI review cooldown is not over yet: ${escalationReasons.join(" | ")}`,
      );
      return;
    }
    this.lastActiveReviewAt = now;
    console.info(`[auto-bot] calling AI active-order review: ${escalationReasons.join(" | ")}`);

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

  private async manageScalpProfitProtection(
    orderService: Mt5OrderService,
    activeOrders: ActiveMt5Order[],
    takeProfitR: number,
  ): Promise<void> {
    const snapshot = await this.collectActiveOrderSnapshot();
    for (const order of activeOrders) {
      const protection = scalpProfitProtectionStop(order, snapshot, takeProfitR);
      if (protection === null) continue;

      try {
        const result = await orderService.modifyOrder({
          ticket: order.ticket,
          stopLoss: protection.stopLoss,
          takeProfit: null,
          comment: `scalp-lock-${protection.stage}`,
        });
        const message =
          protection.stage === "1.5r"
            ? `Scalp #${order.ticket} reached >= 1.5R; locked about 0.5R at SL ${result.stopLoss}.`
            : `Scalp #${order.ticket} reached >= 1R; moved SL to break-even at ${result.stopLoss}.`;
        console.info(`[scalp-bot] ${message}`);
        await this.notifyAction(message);
      } catch (error) {
        console.warn(
          `[scalp-bot] failed protecting profit for #${order.ticket}:`,
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
      throw new Error(`Cannot collect snapshot ${symbolLabel(config.mt5Symbol)} for active-order rule-check.`);
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
        `Cancelled pending order #${order.ticket}. AI reason: ${review.action_reason}. State: ${result.state}`,
      );
      return;
    }

    if (action === "CLOSE_MANUALLY" && order.state === "FILLED") {
      const result = await orderService.cancelOrder(order.ticket);
      this.lastOrderClosedAt = Date.now();
      this.hadActiveOrders = false;
      await this.notifyAction(
        `Closed order #${order.ticket}. AI reason: ${review.action_reason}. State: ${result.state}`,
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
        `AI suggested ${action} for #${order.ticket}, but suggested SL/TP is invalid or does not reduce risk, so bot did not modify the order.`,
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
        `Modified order #${order.ticket} based on AI review.`,
        `Action: ${action}`,
        `New SL: ${result.stopLoss ?? "unchanged"}`,
        `New TP: ${result.takeProfit ?? "unchanged"}`,
        `Reason: ${review.action_reason}`,
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
        "[auto-bot] failed sending Telegram alert:",
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
      }).sendMessage(`Auto-bot order management:\n${message}`);
    } catch (error) {
      console.warn(
        "[auto-bot] failed sending order-management Telegram message:",
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

export function emptyNews(): NewsSnapshot {
  return {
    items: [],
    upcomingEvents: [],
    status: "NO_RELEVANT_DATA",
    provider: "none",
    updatedAt: new Date().toISOString(),
    warnings: [],
  };
}

interface CalendarEvent {
  timeMs: number;
  label: string;
  impact: string;
  currency: string;
}

let cachedCalendarEvents: CalendarEvent[] = [];
let cachedCalendarFetchedAt = 0;
let cachedCalendarKey = "";
const MAX_STALE_CALENDAR_AGE_MS = 6 * 60 * 60_000;

async function getAutoTradeTimeBlockReason(timeZone: string): Promise<string | null> {
  const config = useRuntimeConfig();
  const manualBlock = newsBlackoutBlockReason({
    now: new Date(),
    enabled: config.autoNewsBlackoutEnabled,
    events: config.autoNewsBlackoutEvents,
    minutes: config.autoNewsBlackoutMinutes,
    timeZone,
  });
  if (manualBlock) return manualBlock;

  const autoEvents = await fetchAutoNewsCalendarEvents({
    enabled: config.autoNewsBlackoutEnabled,
    url: config.autoNewsCalendarUrl,
    currencies: config.autoNewsCalendarCurrencies,
    impacts: config.autoNewsCalendarImpacts,
    cacheMinutes: config.autoNewsCalendarCacheMinutes,
  });
  if (autoEvents === null) {
    return "news blackout: economic calendar unavailable, skip new entries for safety";
  }
  return newsBlackoutBlockReason({
    now: new Date(),
    enabled: config.autoNewsBlackoutEnabled,
    events: autoEvents
      .map((event) => `${new Date(event.timeMs).toISOString()}|${event.currency} ${event.impact} ${event.label}`)
      .join(";"),
    minutes: config.autoNewsBlackoutMinutes,
    timeZone,
  });
}

async function fetchAutoNewsCalendarEvents(input: {
  enabled: boolean;
  url: string;
  currencies: string;
  impacts: string;
  cacheMinutes: number;
}): Promise<CalendarEvent[] | null> {
  if (!input.enabled || !input.url) return [];
  const cacheMinutes =
    Number.isFinite(input.cacheMinutes) && input.cacheMinutes > 0 ? input.cacheMinutes : 30;
  const cacheKey = [
    input.url,
    input.currencies.toUpperCase(),
    input.impacts.toUpperCase(),
  ].join("|");
  const now = Date.now();
  if (
    cachedCalendarKey === cacheKey &&
    cachedCalendarFetchedAt > 0 &&
    now - cachedCalendarFetchedAt < cacheMinutes * 60_000
  ) {
    return cachedCalendarEvents;
  }

  try {
    const response = await fetch(input.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("invalid calendar payload: expected an array");
    }
    const events = parseEconomicCalendarEvents(payload, input);
    cachedCalendarKey = cacheKey;
    cachedCalendarFetchedAt = now;
    cachedCalendarEvents = events;
    console.info(
      `[auto-bot] economic calendar refreshed: ${events.length} matching high-impact event(s).`,
    );
    return events;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[auto-bot] economic calendar fetch failed: ${message}`);
    const cacheIsFreshEnough =
      cachedCalendarFetchedAt > 0 &&
      now - cachedCalendarFetchedAt <= MAX_STALE_CALENDAR_AGE_MS;
    return cacheIsFreshEnough ? cachedCalendarEvents : null;
  }
}

function parseEconomicCalendarEvents(
  payload: unknown,
  input: { currencies: string; impacts: string },
): CalendarEvent[] {
  if (!Array.isArray(payload)) return [];
  const currencies = splitUpperSet(input.currencies || "USD,EUR");
  const impacts = splitUpperSet(input.impacts || "High");
  return payload
    .flatMap((raw): CalendarEvent[] => {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as Record<string, unknown>;
      const timeRaw = String(item.date ?? item.time ?? item.datetime ?? "");
      const timeMs = Date.parse(timeRaw);
      const currency = String(item.country ?? item.currency ?? item.ccy ?? "").toUpperCase();
      const impact = String(item.impact ?? item.importance ?? "").trim();
      const label = String(item.title ?? item.event ?? item.name ?? "high-impact news").trim();
      if (!Number.isFinite(timeMs)) return [];
      if (currencies.size > 0 && !currencies.has(currency)) return [];
      if (!isHighImpactCalendarEvent(label, impact, impacts)) return [];
      return [{ timeMs, label, impact: impact || "High", currency }];
    })
    .sort((a, b) => a.timeMs - b.timeMs);
}

function splitUpperSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function isHighImpactCalendarEvent(
  label: string,
  impact: string,
  impacts: Set<string>,
): boolean {
  const normalizedImpact = impact.trim().toUpperCase();
  if (impacts.has(normalizedImpact)) return true;
  const title = label.toUpperCase();
  return [
    "CPI",
    "PPI",
    "FOMC",
    "NON-FARM",
    "NONFARM",
    "NFP",
    "EMPLOYMENT SITUATION",
    "EMPLOYMENT CHANGE",
    "UNEMPLOYMENT RATE",
    "CORE PCE",
    "PCE PRICE INDEX",
    "GROSS DOMESTIC PRODUCT",
    "GDP",
    "RETAIL SALES",
    "JOLTS",
    "ISM MANUFACTURING PMI",
    "ISM SERVICES PMI",
    "FED CHAIR",
    "POWELL",
    "INTEREST RATE",
    "RATE STATEMENT",
  ].some((keyword) => title.includes(keyword));
}

export function newsBlackoutBlockReason(input: {
  now: Date;
  enabled: boolean;
  events: string;
  minutes: number;
  timeZone: string;
}): string | null {
  if (!input.enabled) return null;
  const minutes = Number.isFinite(input.minutes) && input.minutes > 0 ? input.minutes : 60;
  const windowMs = minutes * 60_000;
  const nowMs = input.now.getTime();
  const events = parseNewsBlackoutEvents(input.events);
  for (const event of events) {
    const diffMs = nowMs - event.timeMs;
    if (Math.abs(diffMs) <= windowMs) {
      const side =
        diffMs < 0
          ? `${Math.ceil(Math.abs(diffMs) / 60_000)}m before`
          : `${Math.ceil(diffMs / 60_000)}m after`;
      return `news blackout: ${side} ${event.label} (${formatInTimeZone(new Date(event.timeMs), input.timeZone)})`;
    }
  }
  return null;
}

function parseNewsBlackoutEvents(value: string): Array<{ timeMs: number; label: string }> {
  return value
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [timeRaw, labelRaw] = item.split("|");
      const timeMs = Date.parse((timeRaw ?? "").trim());
      return {
        timeMs,
        label: (labelRaw ?? "high-impact news").trim() || "high-impact news",
      };
    })
    .filter((event) => Number.isFinite(event.timeMs));
}

function formatInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
}

function shouldFlatBeforeSessionClose(timeZone: string): boolean {
  void timeZone;
  return false;
}

function datePartsInTimeZone(timeZone: string): {
  weekday: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export interface AdjustedAutoTrade {
  order_type: "MARKET";
  lot: number;
  entry: number;
  stop_loss: number;
  take_profit: number;
  risk_reward: number;
  reason: string;
}

export function uniqueLots(lots: number[]): number[] {
  return [...new Set(lots.filter((lot) => Number.isFinite(lot) && lot > 0))]
    .sort((left, right) => left - right);
}

export function validateAdjustedAutoTrade(
  direction: RuleSignal["direction"],
  trade: AdjustedAutoTrade,
  minRiskReward: number,
  allowedLots: number[],
): string | null {
  const lots = uniqueLots(allowedLots);
  if (!lots.some((lot) => Math.abs(lot - trade.lot) < 0.000001)) {
    return `lot ${trade.lot} is not in allowed lots ${lots.join(", ")}`;
  }

  if (
    !Number.isFinite(trade.entry) ||
    !Number.isFinite(trade.stop_loss) ||
    !Number.isFinite(trade.take_profit)
  ) {
    return "entry/SL/TP are not valid numbers";
  }

  const actualRr = rewardRisk(
    direction,
    trade.entry,
    trade.stop_loss,
    trade.take_profit,
  );
  if (!Number.isFinite(actualRr) || actualRr < minRiskReward) {
    return `actual RR ${actualRr.toFixed(2)} is below minimum 1:${minRiskReward}`;
  }

  if (Math.abs(actualRr - trade.risk_reward) > 0.35) {
    return `reported RR ${trade.risk_reward} differs too much from actual RR ${actualRr.toFixed(2)}`;
  }

  if (direction === "BUY") {
    if (trade.stop_loss >= trade.entry) return "BUY SL is not below entry";
    if (trade.take_profit <= trade.entry) return "BUY TP is not above entry";
  } else {
    if (trade.stop_loss <= trade.entry) return "SELL SL is not above entry";
    if (trade.take_profit >= trade.entry) return "SELL TP is not below entry";
  }

  return null;
}

export function rewardRisk(
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

export function riskPercentForSignal(
  signal: RuleSignal,
  defaultMaxLossPercent: number,
): number {
  if (signal.strategyKind === "REVERSAL_SCALP") {
    return Math.min(defaultMaxLossPercent, 10);
  }
  return signal.strategyKind === "MOMENTUM_SCALP"
    ? Math.min(defaultMaxLossPercent, 15)
    : defaultMaxLossPercent;
}

export function highSpreadBlockReason(snapshot: MarketSnapshot): string | null {
  if (snapshot.spread === null || !Number.isFinite(snapshot.spread)) return null;
  // Vàng M5: spread > 0.5 USD ăn mòn quá nhiều expectancy của lệnh scalp/pullback.
  const maxSpread = snapshot.symbol === "XAUUSD" ? 0.5 : 0.0003;
  return snapshot.spread > maxSpread
    ? `SKIP: spread ${snapshot.spread} exceeds max allowed ${maxSpread}`
    : null;
}

export interface AutoRiskCheckInput {
  symbol: SymbolCode;
  entry: number;
  stopLoss: number;
  lot: number;
  accountSizeUsd: number;
  maxLossPercentPerTrade: number;
}

export interface AutoRiskCheck {
  allowed: boolean;
  estimatedLossUsd: number;
  maxLossUsd: number;
}

export interface AggregateDailyRiskCheck {
  allowed: boolean;
  openRemainingRiskUsd: number;
  candidateLossUsd: number;
  projectedWorstEquity: number;
  dailyFloorEquity: number;
}

export function resolveDailyLossLimitUsd(
  baselineEquity: number,
  fixedUsd: number,
  percent: number,
): number {
  if (Number.isFinite(fixedUsd) && fixedUsd > 0) return fixedUsd;
  const safePercent = Number.isFinite(percent) && percent > 0 ? percent : 25;
  return Math.max(0, baselineEquity) * safePercent / 100;
}

export function checkAutoRisk(input: AutoRiskCheckInput): AutoRiskCheck {
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

export function checkAggregateDailyRisk(input: {
  currentEquity: number;
  dayBaselineEquity: number;
  dailyLossLimitUsd: number;
  openRemainingRiskUsd: number;
  candidateLossUsd: number;
}): AggregateDailyRiskCheck {
  const openRemainingRiskUsd = Number(Math.max(0, input.openRemainingRiskUsd).toFixed(2));
  const candidateLossUsd = Number(Math.max(0, input.candidateLossUsd).toFixed(2));
  const projectedWorstEquity = Number(
    (input.currentEquity - openRemainingRiskUsd - candidateLossUsd).toFixed(2),
  );
  const dailyFloorEquity = Number(
    (input.dayBaselineEquity - Math.max(0, input.dailyLossLimitUsd)).toFixed(2),
  );
  return {
    allowed:
      Number.isFinite(projectedWorstEquity) &&
      projectedWorstEquity >= dailyFloorEquity,
    openRemainingRiskUsd,
    candidateLossUsd,
    projectedWorstEquity,
    dailyFloorEquity,
  };
}

export function estimateRemainingOrderDownsideUsd(
  order: ActiveMt5Order,
  symbol: SymbolCode,
): number {
  if (order.stop_loss === null || !Number.isFinite(order.stop_loss)) {
    return Number.POSITIVE_INFINITY;
  }
  const unitsPerPrice =
    symbol === "EURUSD"
      ? (10 / 0.0001) * order.volume
      : tradingRules.xauUsdOuncesPerLot * order.volume;
  const pnlAtStop =
    order.direction === "BUY"
      ? (order.stop_loss - order.price_open) * unitsPerPrice
      : (order.price_open - order.stop_loss) * unitsPerPrice;
  const currentProfit = Number.isFinite(order.profit) ? Number(order.profit) : 0;
  return Number(Math.max(0, currentProfit - pnlAtStop).toFixed(2));
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

export function scalpProfitProtectionStop(
  order: ActiveMt5Order,
  snapshot: MarketSnapshot,
  takeProfitR: number,
): { stopLoss: number; stage: "1r" | "1.5r" } | null {
  if (
    order.state !== "FILLED" ||
    order.stop_loss === null ||
    order.take_profit === null ||
    !Number.isFinite(takeProfitR) ||
    takeProfitR <= 0
  ) {
    return null;
  }

  // TP is created as a configured R multiple, so it preserves the original
  // risk distance even after SL has already been moved to break-even.
  const originalRisk = Math.abs(order.take_profit - order.price_open) / takeProfitR;
  if (!Number.isFinite(originalRisk) || originalRisk <= 0) return null;

  const favorableMove = order.direction === "BUY"
    ? snapshot.price - order.price_open
    : order.price_open - snapshot.price;
  const reachedR = favorableMove / originalRisk;
  const thresholdTolerance = 1e-9;
  if (!Number.isFinite(reachedR) || reachedR + thresholdTolerance < 1) return null;

  const buffer = spreadBuffer(snapshot);
  const stage = reachedR + thresholdTolerance >= 1.5 ? "1.5r" : "1r";
  const lockedDistance = stage === "1.5r" ? originalRisk * 0.5 : 0;
  const desired = order.direction === "BUY"
    ? order.price_open + lockedDistance + buffer
    : order.price_open - lockedDistance - buffer;
  const rounded = roundPrice(desired, snapshot.price);

  // Modify only when the new SL is strictly safer. This also prevents the
  // one-minute management loop from repeatedly sending the same request.
  if (order.direction === "BUY") {
    if (rounded >= snapshot.price || rounded <= order.stop_loss) return null;
  } else if (rounded <= snapshot.price || rounded >= order.stop_loss) {
    return null;
  }

  return { stopLoss: rounded, stage };
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
    return roundPrice(order.price_open + spreadBuffer(snapshot), snapshot.price);
  }

  if (order.stop_loss <= order.price_open) return null;
  if (snapshot.price > order.price_open - riskDistance) return null;
  return roundPrice(order.price_open - spreadBuffer(snapshot), snapshot.price);
}

function spreadBuffer(snapshot: MarketSnapshot): number {
  return snapshot.spread !== null && Number.isFinite(snapshot.spread) && snapshot.spread > 0
    ? snapshot.spread
    : 0;
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
    reasons.push("data quality LOW or critical error");
  }
  if (
    snapshot.quoteAgeSeconds === null ||
    snapshot.quoteAgeSeconds > maxQuoteAgeSeconds
  ) {
    reasons.push("quote MT5 stale");
  }
  if (order.stop_loss === null || order.take_profit === null) {
    reasons.push("active order is missing SL or TP");
  }
  if (hasVolatilitySpike(snapshot)) {
    reasons.push("volatility spike on latest candle");
  }

  if (order.state === "PENDING") {
    const ageMinutes = orderAgeMinutes(order);
    if (ageMinutes !== null && ageMinutes >= 60) {
      reasons.push(`pending order age ${Math.round(ageMinutes)} minutes`);
    }
    if (risk !== null && risk > 0) {
      const driftFromEntry = Math.abs(currentPrice - order.price_open) / risk;
      if (driftFromEntry >= 1.2) {
        reasons.push(`price drifted ${driftFromEntry.toFixed(1)}R away from entry`);
      }
    }
    return { shouldEscalate: reasons.length > 0, reasons };
  }

  if (risk !== null && risk > 0) {
    const openR = unrealizedR(order, currentPrice, risk);
    if (openR >= 1) {
      reasons.push(`order is up ${openR.toFixed(1)}R, consider locking profit/moving SL`);
    }
    if (openR <= -0.6) {
      reasons.push(`order is down ${openR.toFixed(1)}R, thesis needs review`);
    }

    const slDistanceRatio = distanceToStopRatio(order, currentPrice, risk);
    if (slDistanceRatio !== null && slDistanceRatio <= 0.25) {
      reasons.push(`price is about ${slDistanceRatio.toFixed(2)}R from SL`);
    }

    const tpDistanceRatio = distanceToTakeProfitRatio(order, currentPrice, risk);
    if (tpDistanceRatio !== null && tpDistanceRatio <= 0.25) {
      reasons.push(`price is about ${tpDistanceRatio.toFixed(2)}R from TP`);
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

export function buildAutoRecommendation(
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
    stop_loss_reason: "SL beyond nearest swing plus ATR buffer by rules engine.",
    take_profit: signal.takeProfit,
    take_profit_reason: `TP based on structure/liquidity zone; minimum required RR is 1:${rr}.`,
    risk_reward: `>=1:${rr}`,
    expected_holding_time: "Until SL/TP, max a few hours.",
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
    entry_plan: "Enter MARKET after confirmation candle closes.",
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
      "Auto-bot demo. This is not financial advice. User is fully responsible for trading decisions.",
  };
}
