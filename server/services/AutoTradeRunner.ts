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
  evaluateRuleSignal,
  evaluateXauTrendPullbackSetup,
  evaluateXauTrendPullbackSignal,
  evaluateXauTrendPullbackTriggerSignal,
  explainXauPendingSetupInvalidation,
  explainBalancedM5Rejection,
  explainRuleSignalRejection,
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
  private lastEvaluatedH1 = "";
  private lastEvaluatedM15 = "";
  private lastEvaluatedM5 = "";
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
      if (
        this.dayBaselineEquity > 0 &&
        account.equity <=
          this.dayBaselineEquity * (1 - config.autoMaxDailyLossPercent / 100)
      ) {
        this.haltedForDay = true;
        console.warn(
          `[auto-bot] kill-switch: equity ${account.equity} <= daily loss threshold ${config.autoMaxDailyLossPercent}%.`,
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
      const timeBlockReason = getAutoTradeTimeBlockReason(config.tradeScannerTimezone);
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
          const nextSignal = evaluateXauTrendPullbackSignal(m5, m15, h1);
          if (nextSignal) {
            this.pendingSetup = null;
            signal = nextSignal;
            entryCandles = m5;
            entryTf = "M5";
          } else {
            const setup = evaluateXauTrendPullbackSetup(m15, h1);
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
              explainXauTrendPullbackRejection(m5, m15, h1) ??
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
    const timeBlockReason = getAutoTradeTimeBlockReason(config.tradeScannerTimezone);
    if (timeBlockReason) {
      console.info(`[auto-bot] pending setup cancelled: ${timeBlockReason}`);
      this.pendingSetup = null;
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

    const riskCheck = checkAutoRisk({
      symbol: input.symbol,
      entry: input.signal.entry,
      stopLoss: input.signal.stopLoss,
      lot,
      accountSizeUsd: config.accountSizeUsd,
      maxLossPercentPerTrade: config.maxLossPercentPerTrade,
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
      const indicators = new IndicatorService().calculateMany(input.market.snapshots);
      const payload = new OpportunityPayloadBuilder().build(
        input.market,
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

function getAutoTradeTimeBlockReason(timeZone: string): string | null {
  const parts = datePartsInTimeZone(timeZone);
  const minutes = parts.hour * 60 + parts.minute;
  const isFriday = parts.weekday === "Fri";
  if (isFriday && minutes >= 21 * 60) {
    return "Friday after 21:00 VN; no new trades.";
  }
  if (minutes < 14 * 60 || minutes >= 23 * 60) {
    return "outside XAUUSD session 14:00-23:00 VN.";
  }
  if (minutes >= 22 * 60 + 30) {
    return "after 22:30 VN; no new trades.";
  }
  return null;
}

function shouldFlatBeforeSessionClose(timeZone: string): boolean {
  const parts = datePartsInTimeZone(timeZone);
  return parts.hour * 60 + parts.minute >= 23 * 60 + 45;
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
