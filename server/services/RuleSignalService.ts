import type { AiTradeRecommendation, RiskyTradeScenario } from "../../types/ai";
import type {
  AnalysisPayload,
  Candle,
  MarketSnapshot,
} from "../../types/trading";
import {
  convictionScore,
  defaultRuleStrategyConfig,
  defaultXauIctConfig,
  evaluateXauClassicPriceActionSignal,
  evaluateManualReversalScalpSignal,
  evaluateXauIctSignal,
  explainManualReversalScalpRejection,
  explainXauIctRejection,
  type RuleSignal,
} from "../strategy/ruleStrategy";
import {
  evaluateXauMicroScalpSignal,
  explainXauMicroScalpRejection,
  microScalpConfigForSymbol,
} from "../strategy/xauMicroScalpStrategy";
import {
  defaultXauRftpConfig,
  explainXauRftp,
} from "../strategy/xauRftpStrategy";
import { symbolCodeFromMt5Symbol, symbolLabel } from "../utils/symbols";
import { AiAnalysisService } from "./AiAnalysisService";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import {
  buildAutoRecommendation,
  emptyNews,
  getAutoTradeTimeBlockReason,
  highSpreadBlockReason,
  newsBlackoutBlockReason,
  rewardRisk,
  uniqueLots,
  validateAdjustedAutoTrade,
} from "./AutoTradeRunner";
import { IndicatorService } from "./IndicatorService";
import { MarketDataService } from "./MarketDataService";
import { OpportunityPayloadBuilder } from "./OpportunityPayloadBuilder";
import { SupabaseService } from "./SupabaseService";
import { isInsideTradeScannerWindow } from "./TradeScannerService";

/**
 * Luồng manual signal (UI + Telegram scanner): Rule Engine tìm setup đẹp,
 * KHÔNG đặt lệnh. Người dùng tự quản trị vốn/lot trên MT5.
 *
 * Kiểm tra còn giữ: data quality, quote age, RR/SL/TP geometry, spread.
 * Không chặn theo risk-cap/lot (bạn tự size). AI veto chỉ chạy nếu AUTO_AI_VETO=true.
 *
 * Khác scanner nền:
 *   - Bấm tay: không dedupe; ngoài khung giờ chỉ CẢNH BÁO.
 *   - Scanner: cứng trong khung giờ + dedupe trước khi gửi Telegram.
 */
export interface RuleSignalScanInput {
  accountSizeUsd?: number | undefined;
}

export async function runRuleSignalScan(input: RuleSignalScanInput) {
  const config = useRuntimeConfig();
  const symbol = symbolCodeFromMt5Symbol(config.mt5Symbol);
  const activeSymbolLabel = symbolLabel(config.mt5Symbol);
  const accountSizeUsd =
    input.accountSizeUsd && input.accountSizeUsd > 0
      ? input.accountSizeUsd
      : config.accountSizeUsd;

  const historyService = new AnalysisHistoryService(
    new SupabaseService({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
    }).getClient(),
  );

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
    throw new Error(`Không lấy được snapshot thị trường cho ${activeSymbolLabel}.`);
  }

  const indicators = new IndicatorService().calculateMany(market.snapshots);
  const payload = new OpportunityPayloadBuilder().build(
    market,
    indicators,
    emptyNews(),
    accountSizeUsd,
    config.maxLossPercentPerTrade,
  );

  // ===== Chốt chặn dữ liệu (giống bot: LOW quality / quote cũ là dừng) =====
  const dataBlockReasons: string[] = [];
  if (snapshot.data_quality === "LOW") {
    dataBlockReasons.push("data_quality của snapshot là LOW");
  }
  if (snapshot.critical_errors.length > 0) {
    dataBlockReasons.push(
      `critical errors: ${snapshot.critical_errors.join("; ")}`,
    );
  }
  if (
    snapshot.quoteAgeSeconds === null ||
    snapshot.quoteAgeSeconds > config.maxQuoteAgeSeconds
  ) {
    dataBlockReasons.push(
      `quote MT5 quá cũ (${snapshot.quoteAgeSeconds ?? "không rõ"}s > ${config.maxQuoteAgeSeconds}s) — kiểm tra bridge/terminal`,
    );
  }
  if (dataBlockReasons.length > 0) {
    return saveAndReturn(
      historyService,
      payload,
      "manual rule-engine scan: blocked by data quality",
      buildRuleNoTrade(symbol, snapshot, payload, {
        reasons: dataBlockReasons,
        summaryTitle: "Dữ liệu chưa đủ tin cậy để quét setup",
      }),
    );
  }

  // ===== Đánh giá rule engine theo đúng mode của bot =====
  const configuredNewsBlock = await getAutoTradeTimeBlockReason(config.tradeScannerTimezone);
  const evaluation = evaluateByStrategyMode(config, snapshot, !configuredNewsBlock);
  const minRr =
    evaluation.mode === "xau_rftp"
      ? defaultXauRftpConfig.targetR
      : evaluation.mode === "xau_micro_scalp"
      ? microScalpConfigForSymbol(config.mt5Symbol).minRr
      : defaultXauIctConfig.minTargetR;

  if (!evaluation.signal) {
    return saveAndReturn(
      historyService,
      payload,
      `manual rule-engine scan (${evaluation.mode}): no setup`,
      buildRuleNoTrade(symbol, snapshot, payload, {
        reasons: evaluation.rejectReasons,
        summaryTitle: `Rule engine (${evaluation.mode}) chưa thấy setup hợp lệ`,
        pendingNote: evaluation.pendingNote,
      }),
    );
  }

  const signal = evaluation.signal;
  const entryTf = evaluation.entryTf;
  const strategy = {
    ...defaultRuleStrategyConfig,
    rrTarget: minRr,
  };
  const conviction = convictionScore(
    evaluation.entryCandles,
    snapshot.candles.H4,
    signal,
    strategy,
  );
  // Lot chỉ để validate geometry / AI veto schema — UI/Telegram không ép size.
  const displayLot = config.autoLotGood;

  const hardBlockReasons: string[] = [];

  const validationError = validateAdjustedAutoTrade(
    signal.direction,
    {
      order_type: "MARKET",
      lot: displayLot,
      entry: signal.entry,
      stop_loss: signal.stopLoss,
      take_profit: signal.takeProfit,
      risk_reward: rewardRisk(
        signal.direction,
        signal.entry,
        signal.stopLoss,
        signal.takeProfit,
      ),
      reason: signal.reason,
    },
    minRr,
    uniqueLots([config.autoLotGood, config.autoLotVeryGood]),
  );
  if (validationError) hardBlockReasons.push(`validate: ${validationError}`);

  const spreadBlock = highSpreadBlockReason(snapshot);
  if (spreadBlock) hardBlockReasons.push(spreadBlock);

  if (hardBlockReasons.length > 0) {
    return saveAndReturn(
      historyService,
      payload,
      `manual rule-engine scan (${evaluation.mode}): setup found but blocked`,
      buildRuleNoTrade(symbol, snapshot, payload, {
        reasons: hardBlockReasons,
        summaryTitle: `Có setup ${signal.direction} ${entryTf} nhưng bị chặn bởi kiểm tra chất lượng tín hiệu`,
        rejectedSignal: { signal, entryTf },
        riskyTrade: buildRuleRiskyTrade({
          signal,
          entryTf,
          title: `Kèo mạo hiểm: setup ${signal.direction} ${entryTf} bị chặn`,
          winProbability: 50,
          reason:
            "Setup rule engine có tín hiệu nhưng bị lớp kiểm tra chất lượng (RR/spread/geometry) từ chối — xem lý do hủy. Bạn tự quyết nếu vẫn muốn vào.",
          blockReasons: hardBlockReasons,
          lot: displayLot,
          estimatedLossUsd: 0,
          accountSizeUsd,
        }),
      }),
    );
  }

  const warnings: string[] = [];
  let aiConfirmation: string | null = null;
  if (!isInsideTradeScannerWindow()) {
    warnings.push(
      "Ngoài khung giờ quét London–NY — thanh khoản/spread có thể xấu hơn; cân nhắc kỹ trước khi vào.",
    );
  }

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
        lot: displayLot,
        minRiskReward: minRr,
        allowedLots: uniqueLots([config.autoLotGood, config.autoLotVeryGood]),
      });
      if (veto.parsed.decision === "BLOCK") {
        const blockReasons = veto.parsed.blocker_reasons.length
          ? veto.parsed.blocker_reasons
          : [veto.parsed.summary || "AI veto BLOCK không kèm lý do chi tiết"];
        return saveAndReturn(
          historyService,
          payload,
          `manual rule-engine scan (${evaluation.mode}): AI veto BLOCK`,
          buildRuleNoTrade(symbol, snapshot, payload, {
            reasons: blockReasons.map((reason) => `AI veto: ${reason}`),
            summaryTitle: `Setup ${signal.direction} ${entryTf} bị AI veto chặn`,
            rejectedSignal: { signal, entryTf },
            riskyTrade: buildRuleRiskyTrade({
              signal,
              entryTf,
              title: `Kèo mạo hiểm: setup ${signal.direction} ${entryTf} bị AI veto chặn`,
              winProbability: 50,
              reason:
                "Setup đã qua kiểm tra tất định nhưng AI veto từ chối. Nếu không đồng tình với AI, tự cân nhắc.",
              blockReasons: blockReasons.map((reason) => `AI veto: ${reason}`),
              lot: displayLot,
              estimatedLossUsd: 0,
              accountSizeUsd,
            }),
          }),
        );
      }
      aiConfirmation = `AI ALLOW ${veto.parsed.confidence}%: ${veto.parsed.summary}`;
      warnings.push(...veto.parsed.warnings.map((item) => `AI veto: ${item}`));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return saveAndReturn(
        historyService,
        payload,
        `manual rule-engine scan (${evaluation.mode}): AI veto unavailable`,
        buildRuleNoTrade(symbol, snapshot, payload, {
          reasons: [`AI veto không chạy được: ${msg.slice(0, 160)}`],
          summaryTitle: `Setup ${signal.direction} ${entryTf} không được AI xác nhận`,
          rejectedSignal: { signal, entryTf },
        }),
      );
    }
  }

  const recommendation = buildAutoRecommendation(
    signal,
    displayLot,
    conviction,
    snapshot.price,
    payload,
    minRr,
  );
  if (aiConfirmation) {
    recommendation.trade_reason = `${recommendation.trade_reason} ${aiConfirmation}`;
  }
  recommendation.risk_factors = [...recommendation.risk_factors, ...warnings];
  recommendation.summary = `Rule Engine (${evaluation.mode}) ${entryTf}: ${signal.direction} — entry ${signal.entry}, SL ${signal.stopLoss}, TP ${signal.takeProfit}. Bạn tự quản trị lot và vào lệnh.`;
  recommendation.entry_plan =
    "Tự đặt lệnh trên MT5 theo entry/SL/TP nếu đồng ý setup. Lot do bạn quyết định — tool không quản trị vốn.";
  recommendation.position_sizing.suggested_lot = null;
  recommendation.position_sizing.estimated_loss_if_sl_hit = null;
  recommendation.position_sizing.position_sizing_explanation =
    "Bạn tự quản trị vốn/lot. Tool chỉ đưa hướng, entry, SL, TP từ Rule Engine.";

  return saveAndReturn(
    historyService,
    payload,
    `manual rule-engine scan (${evaluation.mode}): signal ${signal.direction} ${entryTf}`,
    recommendation,
  );
}

export interface StrategyEvaluation {
  mode:
    | "manual_scalp"
    | "xau_micro_scalp"
    | "xau_rftp"
    | "manual_scalp"
    | "xau_ict"
    | "xau_price_action";
  signal: RuleSignal | null;
  entryTf: string;
  entryCandles: Candle[];
  rejectReasons: string[];
  pendingNote: string | null;
}

// Chọn engine đúng theo AUTO_STRATEGY_MODE — cùng logic nhánh với
// AutoTradeRunner.runOnce, nhưng không dedupe theo nến vì đây là bấm tay.
// Export để unit-test được (hàm thuần: config con + snapshot -> kết quả).
export function evaluateByStrategyMode(
  config: {
    manualScalp?: boolean;
    autoStrategyMode: string;
    autoUseM15: boolean;
    autoAllowScalp: boolean;
    autoAllowBuy?: boolean;
    autoAllowSell?: boolean;
    autoScalpTpR?: number;
    autoScalpFrequency?: string;
    mt5Symbol?: string;
    autoNewsBlackoutEnabled?: boolean;
    autoNewsBlackoutEvents?: string;
    autoNewsBlackoutMinutes?: number;
    tradeScannerTimezone?: string;
  },
  snapshot: MarketSnapshot,
  newsWindowClearOverride?: boolean,
): StrategyEvaluation {
  const m1 = snapshot.candles.M1 ?? [];
  const h1 = snapshot.candles.H1;
  const h4 = snapshot.candles.H4;
  const m15 = snapshot.candles.M15;
  const m5 = snapshot.candles.M5;
  const rawMode = String(config.autoStrategyMode).toLowerCase();
  const mode: StrategyEvaluation["mode"] =
    rawMode === "xau_rftp" ? "xau_rftp" : rawMode === "xau_micro_scalp" ? "xau_micro_scalp" : rawMode === "xau_price_action" ? "xau_price_action" : "xau_ict";

  if (mode === "xau_rftp") {
    const now = new Date();
    const evaluation = explainXauRftp(m5, m15, h1, {
      now,
      newsWindowClear: newsWindowClearOverride ?? !newsBlackoutBlockReason({
        now,
        enabled: config.autoNewsBlackoutEnabled ?? false,
        events: config.autoNewsBlackoutEvents ?? "",
        minutes: config.autoNewsBlackoutMinutes ?? 60,
        timeZone: config.tradeScannerTimezone ?? "Asia/Saigon",
      }),
      bid: snapshot.bid,
      ask: snapshot.ask,
      spreadPrice: snapshot.spread,
    }, {
      ...defaultXauRftpConfig,
      allowBuy: config.autoAllowBuy !== false,
      allowSell: config.autoAllowSell !== false,
    });
    return {
      mode,
      signal: evaluation.signal,
      entryTf: "M5",
      entryCandles: m5,
      rejectReasons: evaluation.signal ? [] : [evaluation.reason],
      pendingNote: evaluation.signal ? null : "RFTP chờ M15 regime + M5 pullback/rejection và breakout trong tối đa 3 nến.",
    };
  }

  if (mode === "xau_micro_scalp") {
    const scalpConfig = microScalpConfigForSymbol(config.mt5Symbol, {
      allowBuy: config.autoAllowBuy !== false,
      allowSell: config.autoAllowSell !== false,
    });
    const micro = evaluateXauMicroScalpSignal(m1, m15, h1, scalpConfig, m5, h4);
    const signal = micro as RuleSignal | null;
    return {
      mode,
      signal,
      entryTf: "M1",
      entryCandles: m1.length ? m1 : m5,
      rejectReasons: signal
        ? []
        : [explainXauMicroScalpRejection(m1, m15, h1, scalpConfig, m5, h4)],
      pendingNote: signal
        ? null
        : `Micro-scalp ${scalpConfig.symbolLabel} M1: cần trend-day (H4 + Asia break/stretch) + H1+M15 EMA50 + nến M1 xác nhận. Quét lại sau ~1 phút.`,
    };
  }

  if (config.manualScalp) {
    const signal = evaluateManualReversalScalpSignal(m1, m5, m15, h1, {
      takeProfitR: config.autoScalpTpR ?? 1.5,
      frequency: config.autoScalpFrequency === "high" ? "high" : "normal",
    });
    return {
      mode: "manual_scalp",
      signal,
      entryTf: "M1",
      entryCandles: m1.length ? m1 : m5,
      rejectReasons: signal
        ? []
        : [
            explainManualReversalScalpRejection(m1, m5, m15, h1, {
              takeProfitR: config.autoScalpTpR ?? 1.5,
              frequency: config.autoScalpFrequency === "high" ? "high" : "normal",
            }) ??
              "manual scalp diagnostics không trả tín hiệu",
          ],
      pendingNote: signal
        ? null
        : "Manual scalp bắt đỉnh/đáy cần M15 quá đà + M1/M5 sweep xác nhận. Nếu chưa có, quét lại sau 1-5 phút.",
    };
  }

  if (mode === "xau_price_action") {
    const now = new Date();
    const options = {
      now,
      newsWindowClear: newsWindowClearOverride ?? !newsBlackoutBlockReason({
        now,
        enabled: config.autoNewsBlackoutEnabled ?? false,
        events: config.autoNewsBlackoutEvents ?? "",
        minutes: config.autoNewsBlackoutMinutes ?? 60,
        timeZone: config.tradeScannerTimezone ?? "Asia/Saigon",
      }),
      spreadPrice: snapshot.spread ?? undefined,
    };
    const signal = evaluateXauClassicPriceActionSignal(m5, m15, h1, options);
    return {
      mode,
      signal,
      entryTf: "M5",
      entryCandles: m5,
      rejectReasons: signal ? [] : ["Price Action reversal: chờ M15 quét thanh khoản rồi M5 từ chối/engulfing xác nhận."],
      pendingNote: signal ? null : "PA reversal quét lại sau mỗi nến M5 đóng.",
    };
  }

  // xau_ict: H1 bias (chính) + H4 context -> Setup A (sweep reversal) hoặc
  // Setup B (BOS continuation) -> M15 BOS -> retest zone -> M5 trigger.
  // newsWindowClear đánh giá ngay tại đây (thời điểm gọi = thời điểm quét/bấm tay),
  // không cache từ trước — khớp nguyên tắc "final-time gate" của rulebook.
  const newsWindowClear = newsWindowClearOverride ?? !newsBlackoutBlockReason({
    now: new Date(),
    enabled: config.autoNewsBlackoutEnabled ?? false,
    events: config.autoNewsBlackoutEvents ?? "",
    minutes: config.autoNewsBlackoutMinutes ?? 60,
    timeZone: config.tradeScannerTimezone ?? "Asia/Saigon",
  });
  const signal = evaluateXauIctSignal(m5, m15, h1, h4, defaultXauIctConfig, {
    newsWindowClear,
    spreadPrice: snapshot.spread ?? undefined,
  });
  if (signal) {
    return {
      mode,
      signal,
      entryTf: "M5",
      entryCandles: m5,
      rejectReasons: [],
      pendingNote: null,
    };
  }
  return {
    mode,
    signal: null,
    entryTf: "M5",
    entryCandles: m5,
    rejectReasons: [explainXauIctRejection(m5, m15, h1, h4, defaultXauIctConfig, {
      newsWindowClear,
      spreadPrice: snapshot.spread ?? undefined,
    })],
    pendingNote: "PA v0.2: cần H1 bias + Setup A (sweep+displacement+BOS) hoặc Setup B (BOS continuation) + retest zone + M5 trigger trong khung giờ cho phép. Quét lại sau mỗi nến M5 đóng.",
  };
}

/**
 * Kèo "trade mạo hiểm" TẤT ĐỊNH cho các trường hợp NO_TRADE — không bịa số:
 *   - Setup thật bị chặn bởi kiểm tra an toàn/AI veto -> đưa chính setup đó ra,
 *     kèm đầy đủ lý do vì sao hệ thống từ chối.
 *   - Không có setup chính -> thử nhánh momentum-scalp (đã tắt khỏi luồng chính
 *     vì chất lượng thấp hơn; backtest 30 ngày: win ~46%, drawdown sâu).
 * Win probability lấy từ backtest gần nhất, ghi rõ nguồn trong reason.
 */
function buildRuleRiskyTrade(input: {
  signal: RuleSignal;
  entryTf: string;
  title: string;
  winProbability: number;
  reason: string;
  blockReasons: string[];
  lot: number;
  estimatedLossUsd: number;
  accountSizeUsd: number;
}): RiskyTradeScenario {
  const { signal } = input;
  return {
    enabled: true,
    title: input.title,
    direction: signal.direction,
    order_type: "MARKET",
    estimated_win_probability: input.winProbability,
    entry_zone: { from: signal.entry, to: signal.entry },
    stop_loss: signal.stopLoss,
    take_profit: signal.takeProfit,
    risk_reward: `1:${Number(
      rewardRisk(
        signal.direction,
        signal.entry,
        signal.stopLoss,
        signal.takeProfit,
      ).toFixed(2),
    )}`,
    // Setup M5/M15 nguội rất nhanh — quá 30 phút chưa vào thì bỏ kèo.
    cancel_after_minutes: 30,
    suggested_lot: input.lot,
    estimated_loss_if_sl_hit: input.estimatedLossUsd,
    reason: input.reason,
    entry_conditions: [
      "Chỉ vào MARKET khi giá còn quanh vùng entry (chưa chạy quá xa SL/TP đã tính).",
      "Kiểm tra spread thực tế trên sàn trước khi đặt lệnh.",
      "Bạn tự chọn lot và quản trị rủi ro — tool không ép size.",
    ],
    cancel_conditions: [
      "Hủy kèo nếu chưa vào lệnh sau 30 phút (setup nguội).",
      "Hủy kèo nếu xuất hiện nến đóng ngược hướng phá cấu trúc M15.",
      ...input.blockReasons.map((reason) => `Lý do hệ thống từ chối kèo chính: ${reason}`),
    ],
    warning:
      "KÈO MẠO HIỂM: bị hệ thống từ chối làm khuyến nghị chính hoặc đến từ nhánh scalp chất lượng thấp hơn. Vào lệnh là quyết định hoàn toàn của bạn.",
  };
}

function buildRuleNoTrade(
  symbol: AnalysisPayload["symbols"][number]["market"]["symbol"],
  snapshot: MarketSnapshot,
  payload: AnalysisPayload,
  input: {
    reasons: string[];
    summaryTitle: string;
    pendingNote?: string | null;
    rejectedSignal?: { signal: RuleSignal; entryTf: string };
    riskyTrade?: RiskyTradeScenario | null;
  },
): AiTradeRecommendation {
  const rejectedText = input.rejectedSignal
    ? `Setup bị từ chối: ${input.rejectedSignal.signal.direction} ${input.rejectedSignal.entryTf} — entry ${input.rejectedSignal.signal.entry}, SL ${input.rejectedSignal.signal.stopLoss}, TP ${input.rejectedSignal.signal.takeProfit}.`
    : "";
  const nextCheck =
    input.pendingNote ??
    "Quét lại sau khi có nến đóng mới (M5/M15) hoặc khi cấu trúc thị trường thay đổi.";
  return {
    decision: "NO_TRADE",
    symbol,
    direction: "NONE",
    order_type: "MARKET",
    confidence: 0,
    estimated_win_probability: 0,
    entry_zone: null,
    stop_loss: null,
    stop_loss_reason: "",
    take_profit: null,
    take_profit_reason: "",
    risk_reward: null,
    expected_holding_time: null,
    cancel_after_minutes: null,
    position_sizing: {
      account_size_usd: payload.accountSizeUsd,
      max_loss_usd: payload.maxLossUsdPerTrade,
      max_loss_percent: payload.maxLossPercentPerTrade,
      suggested_lot: null,
      estimated_loss_if_sl_hit: null,
      position_sizing_explanation:
        "Không có lệnh nên không tính khối lượng.",
    },
    current_price: snapshot.price,
    market_context: `${input.summaryTitle}. Giá hiện tại ${snapshot.price}. ${rejectedText}`.trim(),
    trade_reason: "",
    entry_plan: "",
    summary: input.summaryTitle,
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
    main_reasons: [],
    risk_factors: [],
    invalid_conditions: [],
    no_trade_reasons: [
      ...input.reasons,
      ...(input.pendingNote ? [input.pendingNote] : []),
    ],
    conditions_to_recheck: [nextCheck],
    trade_validation_failures: input.rejectedSignal ? input.reasons : [],
    best_case_scenario: "",
    worst_case_scenario: "",
    pre_entry_checklist: [],
    no_trade_reason: input.reasons.join("; "),
    next_check_suggestion: nextCheck,
    risky_trade: input.riskyTrade ?? null,
    disclaimer:
      "Tín hiệu tất định từ rule engine (không phải AI sáng tác). Đây không phải lời khuyên tài chính; người dùng tự chịu trách nhiệm quyết định giao dịch.",
  };
}

async function saveAndReturn(
  historyService: AnalysisHistoryService,
  payload: AnalysisPayload,
  rawLabel: string,
  recommendation: AiTradeRecommendation,
) {
  try {
    const history = await historyService.create({
      requestPayload: payload,
      aiResponseRaw: rawLabel,
      parsedResult: recommendation,
    });
    return { result: recommendation, history: { id: history.id } };
  } catch (error) {
    // History must not become a single point of failure for the manual alert
    // path. The recommendation is still based on fresh MT5 data and (when
    // enabled) AI veto; only the remote audit record is unavailable.
    console.warn(
      "[rule-signal] Supabase history unavailable; returning unsaved signal:",
      error instanceof Error ? error.message : error,
    );
    return { result: recommendation, history: { id: `local-${Date.now()}` } };
  }
}
