import type { AiTradeRecommendation, RiskyTradeScenario } from "../../types/ai";
import type {
  AnalysisPayload,
  Candle,
  MarketSnapshot,
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
  explainBalancedM5Rejection,
  explainManualReversalScalpRejection,
  explainRuleSignalRejection,
  explainXauTrendPullbackRejection,
  type RuleSignal,
} from "../strategy/ruleStrategy";
import { symbolCodeFromMt5Symbol, symbolLabel } from "../utils/symbols";
import { AiAnalysisService } from "./AiAnalysisService";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import {
  buildAutoRecommendation,
  checkAutoRisk,
  emptyNews,
  highSpreadBlockReason,
  rewardRisk,
  riskPercentForSignal,
  uniqueLots,
  validateAdjustedAutoTrade,
} from "./AutoTradeRunner";
import { IndicatorService } from "./IndicatorService";
import { MarketDataService } from "./MarketDataService";
import { OpportunityPayloadBuilder } from "./OpportunityPayloadBuilder";
import { SupabaseService } from "./SupabaseService";
import { isInsideTradeScannerWindow } from "./TradeScannerService";

/**
 * Luồng manual "Quét setup theo Rule Engine": CÙNG rules engine + CÙNG chuỗi
 * kiểm tra an toàn với auto-bot (validate RR, spread, quote-age, risk-cap,
 * AI veto), nhưng chạy theo một lần bấm nút và KHÔNG đặt lệnh — người dùng
 * tự quyết định trên MT5.
 *
 * Khác biệt có chủ đích so với auto-bot:
 *   - Không dedupe theo nến (bấm lúc nào đánh giá nến đóng mới nhất lúc đó).
 *   - Không chặn ngoài khung giờ quét — chỉ CẢNH BÁO, vì người bấm tự chịu
 *     trách nhiệm; bot thì bị chặn cứng.
 *   - AI veto lỗi (timeout/quota) -> vẫn trả tín hiệu kèm cảnh báo đỏ, vì
 *     người dùng chính là lớp phê duyệt cuối; bot thì fail-closed.
 * Kết quả trả về đúng shape AiTradeRecommendation nên UI + SignalOutcomeTracker
 * + vòng tự hiệu chỉnh dùng lại nguyên vẹn.
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
  const evaluation = evaluateByStrategyMode(config, snapshot);

  if (!evaluation.signal) {
    // Kèo mạo hiểm tất định: thử nhánh scalp (vốn bị tắt khỏi luồng chính).
    const scalpRisky = config.manualScalp
      ? null
      : buildScalpRiskyCandidate({
          autoStrategyMode: config.autoStrategyMode,
          autoAllowScalp: config.autoAllowScalp,
          lot: config.autoLotGood,
          maxLossPercentPerTrade: config.maxLossPercentPerTrade,
          snapshot,
          symbol,
          accountSizeUsd,
        });
    return saveAndReturn(
      historyService,
      payload,
      `manual rule-engine scan (${evaluation.mode}): no setup${scalpRisky ? " (scalp risky offered)" : ""}`,
      buildRuleNoTrade(symbol, snapshot, payload, {
        reasons: evaluation.rejectReasons,
        summaryTitle: `Rule engine (${evaluation.mode}) chưa thấy setup hợp lệ`,
        pendingNote: evaluation.pendingNote,
        riskyTrade: scalpRisky,
      }),
    );
  }

  const signal = evaluation.signal;
  const entryTf = evaluation.entryTf;
  const strategy = {
    ...defaultRuleStrategyConfig,
    rrTarget: tradingRules.minRiskReward,
  };
  const conviction = convictionScore(
    evaluation.entryCandles,
    snapshot.candles.H4,
    signal,
    strategy,
  );
  const lot =
    conviction >= config.autoVeryGoodMinConviction
      ? config.autoLotVeryGood
      : config.autoLotGood;

  // ===== Chuỗi kiểm tra an toàn tất định (đúng bộ của auto-bot) =====
  const hardBlockReasons: string[] = [];

  const validationError = validateAdjustedAutoTrade(
    signal.direction,
    {
      order_type: "MARKET",
      lot,
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
    tradingRules.minRiskReward,
    uniqueLots([config.autoLotGood, config.autoLotVeryGood]),
  );
  if (validationError) hardBlockReasons.push(`validate: ${validationError}`);

  const spreadBlock = highSpreadBlockReason(snapshot);
  if (spreadBlock) hardBlockReasons.push(spreadBlock);

  const riskCheck = checkAutoRisk({
    symbol,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    lot,
    accountSizeUsd,
    maxLossPercentPerTrade: riskPercentForSignal(
      signal,
      config.maxLossPercentPerTrade,
    ),
  });
  if (!riskCheck.allowed) {
    hardBlockReasons.push(
      `risk-cap: lỗ ước tính ${riskCheck.estimatedLossUsd} USD vượt mức cho phép ${riskCheck.maxLossUsd} USD (vốn ${accountSizeUsd} USD, lot ${lot})`,
    );
  }

  if (hardBlockReasons.length > 0) {
    return saveAndReturn(
      historyService,
      payload,
      `manual rule-engine scan (${evaluation.mode}): setup found but blocked`,
      buildRuleNoTrade(symbol, snapshot, payload, {
        reasons: hardBlockReasons,
        summaryTitle: `Có setup ${signal.direction} ${entryTf} nhưng bị chặn bởi kiểm tra an toàn`,
        rejectedSignal: { signal, entryTf },
        riskyTrade: buildRuleRiskyTrade({
          signal,
          entryTf,
          title: `Kèo mạo hiểm: setup ${signal.direction} ${entryTf} bị kiểm tra an toàn chặn`,
          winProbability: 50,
          reason:
            "Setup gốc đạt tiêu chí rule engine chính (backtest nhánh chính ~62% win) nhưng bị lớp kiểm tra an toàn từ chối — xem lý do ở điều kiện hủy. Xác suất thắng khi cố tình bỏ qua lớp chặn là KHÔNG được kiểm chứng.",
          blockReasons: hardBlockReasons,
          lot: config.autoLotGood,
          estimatedLossUsd: riskCheck.estimatedLossUsd,
          accountSizeUsd,
        }),
      }),
    );
  }

  // ===== AI veto (lớp chặn cuối, giống bot; lỗi thì cảnh báo chứ không giấu) =====
  const warnings: string[] = [];
  if (!isInsideTradeScannerWindow()) {
    warnings.push(
      "Ngoài khung giờ London–NY (14:00–24:00 VN) mà bot dùng để vào lệnh — thanh khoản/spread có thể xấu hơn thống kê backtest.",
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
        lot,
        minRiskReward: tradingRules.minRiskReward,
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
                "Setup đã qua hết kiểm tra an toàn tất định (RR/spread/risk-cap) nhưng AI veto từ chối — xem lý do ở điều kiện hủy. Nếu bạn không đồng tình với AI, đây là kèo để tự cân nhắc.",
              blockReasons: blockReasons.map((reason) => `AI veto: ${reason}`),
              lot,
              estimatedLossUsd: riskCheck.estimatedLossUsd,
              accountSizeUsd,
            }),
          }),
        );
      }
      warnings.push(...veto.parsed.warnings.map((item) => `AI veto: ${item}`));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Khác bot (fail-closed): luồng manual vẫn trả tín hiệu vì NGƯỜI DÙNG là
      // lớp phê duyệt cuối — nhưng cảnh báo phải nổi bật, không được nuốt lỗi.
      warnings.push(
        `CẢNH BÁO: AI veto không chạy được (${msg.slice(0, 160)}). Tín hiệu này CHƯA qua lớp kiểm tra AI — tự soi tin tức/lịch kinh tế trước khi vào lệnh.`,
      );
    }
  }

  // ===== Kết quả TRADE: format y hệt auto-bot để UI/tracker dùng lại =====
  const recommendation = buildAutoRecommendation(
    signal,
    lot,
    conviction,
    snapshot.price,
    payload,
    tradingRules.minRiskReward,
  );
  recommendation.risk_factors = [...recommendation.risk_factors, ...warnings];
  recommendation.summary = `Rule Engine (${evaluation.mode}) ${entryTf}: ${signal.direction} — entry ${signal.entry}, SL ${signal.stopLoss}, TP ${signal.takeProfit}. Người dùng tự đặt lệnh.`;
  recommendation.entry_plan =
    "Tự đặt lệnh MARKET trên MT5 theo entry/SL/TP ở trên nếu bạn đồng ý với setup. Đây là tín hiệu tất định từ rule engine, không phải AI sáng tác.";
  recommendation.position_sizing.position_sizing_explanation = `Lot cố định ${lot} theo cấu hình bot (conviction ${conviction}/3). Lỗ ước tính nếu dính SL: ${riskCheck.estimatedLossUsd} USD trên vốn ${accountSizeUsd} USD.`;

  return saveAndReturn(
    historyService,
    payload,
    `manual rule-engine scan (${evaluation.mode}): signal ${signal.direction} ${entryTf}`,
    recommendation,
  );
}

export interface StrategyEvaluation {
  mode: "manual_scalp" | "xau_trend_pullback" | "balanced" | "strict";
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
  },
  snapshot: MarketSnapshot,
): StrategyEvaluation {
  const m1 = snapshot.candles.M1 ?? [];
  const h1 = snapshot.candles.H1;
  const h4 = snapshot.candles.H4;
  const m15 = snapshot.candles.M15;
  const m5 = snapshot.candles.M5;
  const strategy = {
    ...defaultRuleStrategyConfig,
    rrTarget: tradingRules.minRiskReward,
  };
  const mode =
    String(config.autoStrategyMode).toLowerCase() === "xau_trend_pullback"
      ? "xau_trend_pullback"
      : String(config.autoStrategyMode).toLowerCase() === "balanced"
        ? "balanced"
        : "strict";

  if (config.manualScalp) {
    const signal = evaluateManualReversalScalpSignal(m1, m5, m15, h1);
    return {
      mode: "manual_scalp",
      signal,
      entryTf: "M1",
      entryCandles: m1.length ? m1 : m5,
      rejectReasons: signal
        ? []
        : [
            explainManualReversalScalpRejection(m1, m5, m15, h1) ??
              "manual scalp diagnostics không trả tín hiệu",
          ],
      pendingNote: signal
        ? null
        : "Manual scalp bắt đỉnh/đáy cần M15 quá đà + M1/M5 sweep xác nhận. Nếu chưa có, quét lại sau 1-5 phút.",
    };
  }

  if (mode === "xau_trend_pullback") {
    const signal = evaluateXauTrendPullbackSignal(m5, m15, h1, {
      allowScalp: config.autoAllowScalp,
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
    const setup = evaluateXauTrendPullbackSetup(m15, h1, m5);
    const reject =
      explainXauTrendPullbackRejection(m5, m15, h1, {
        allowScalp: config.autoAllowScalp,
      }) ?? "rule engine không trả tín hiệu";
    return {
      mode,
      signal: null,
      entryTf: "M5",
      entryCandles: m5,
      rejectReasons: [reject],
      pendingNote: setup
        ? `Có setup ${setup.direction} (${setup.kind}/${setup.mode}) trên M15 đang chờ nến M5 kích hoạt (engulfing/pin/strong close). Quét lại sau mỗi nến M5 đóng, tối đa ~30 phút.`
        : null,
    };
  }

  if (mode === "balanced") {
    const signal = evaluateBalancedM5Signal(m5, m15, h1, h4, strategy);
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
      rejectReasons: [
        explainBalancedM5Rejection(m5, m15, h1, h4, strategy) ??
          "balanced diagnostics không trả tín hiệu",
      ],
      pendingNote: null,
    };
  }

  // strict: H1 trước, M15 sau (nếu bật) — giống bot.
  const h1Signal = evaluateRuleSignal(h1, h4, strategy);
  if (h1Signal) {
    return {
      mode,
      signal: h1Signal,
      entryTf: "H1",
      entryCandles: h1,
      rejectReasons: [],
      pendingNote: null,
    };
  }
  const reasons = [
    `H1: ${explainRuleSignalRejection(h1, h4, strategy) ?? "không trả tín hiệu"}`,
  ];
  if (config.autoUseM15) {
    const m15Signal = evaluateRuleSignal(m15, h4, strategy, h1);
    if (m15Signal) {
      return {
        mode,
        signal: m15Signal,
        entryTf: "M15",
        entryCandles: m15,
        rejectReasons: [],
        pendingNote: null,
      };
    }
    reasons.push(
      `M15: ${explainRuleSignalRejection(m15, h4, strategy, h1) ?? "không trả tín hiệu"}`,
    );
  }
  return {
    mode,
    signal: null,
    entryTf: "H1",
    entryCandles: h1,
    rejectReasons: reasons,
    pendingNote: null,
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
      `Chấp nhận trước mức lỗ ${input.estimatedLossUsd} USD (~${Number(((input.estimatedLossUsd / input.accountSizeUsd) * 100).toFixed(1))}% vốn) nếu dính SL.`,
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

/**
 * Khi luồng chính không có setup: thử nhánh momentum-scalp làm kèo mạo hiểm.
 * Chỉ áp dụng ở mode xau_trend_pullback khi scalp đang TẮT (nếu scalp bật thì
 * nó đã nằm trong tín hiệu chính rồi). Kèo scalp vẫn phải qua đủ kiểm tra
 * tất định (RR/spread/risk-cap) — mạo hiểm ở CHẤT LƯỢNG setup, không phải ở
 * việc bỏ qua an toàn vốn.
 */
function buildScalpRiskyCandidate(input: {
  autoStrategyMode: string;
  autoAllowScalp: boolean;
  lot: number;
  maxLossPercentPerTrade: number;
  snapshot: MarketSnapshot;
  symbol: AnalysisPayload["symbols"][number]["market"]["symbol"];
  accountSizeUsd: number;
}): RiskyTradeScenario | null {
  const mode = String(input.autoStrategyMode).toLowerCase();
  if (mode !== "xau_trend_pullback" || input.autoAllowScalp) return null;

  const { M5: m5, M15: m15, H1: h1 } = input.snapshot.candles;
  // Luồng chính đã trả null nên tín hiệu duy nhất có thể đến từ nhánh scalp.
  const signal = evaluateXauTrendPullbackSignal(m5, m15, h1, { allowScalp: true });
  if (!signal || signal.strategyKind !== "MOMENTUM_SCALP") return null;

  const validationError = validateAdjustedAutoTrade(
    signal.direction,
    {
      order_type: "MARKET",
      lot: input.lot,
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
    tradingRules.minRiskReward,
    [input.lot],
  );
  if (validationError) return null;
  if (highSpreadBlockReason(input.snapshot)) return null;

  const riskCheck = checkAutoRisk({
    symbol: input.symbol,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    lot: input.lot,
    accountSizeUsd: input.accountSizeUsd,
    maxLossPercentPerTrade: riskPercentForSignal(
      signal,
      input.maxLossPercentPerTrade,
    ),
  });
  if (!riskCheck.allowed) return null;

  return buildRuleRiskyTrade({
    signal,
    entryTf: "M5",
    title: "Kèo scalp mạo hiểm (nhánh dự phòng đã tắt khỏi luồng chính)",
    winProbability: 46,
    reason: `Không có setup trend-pullback chính, nhưng nhánh momentum-scalp phát tín hiệu ${signal.direction}. Backtest 30 ngày của nhánh này: win ~46%, expectancy +0.11R, drawdown sâu hơn hẳn nhánh chính — vì vậy nó bị tắt khỏi luồng chính và chỉ hiện ở đây như kèo mạo hiểm.`,
    blockReasons: [],
    lot: input.lot,
    estimatedLossUsd: riskCheck.estimatedLossUsd,
    accountSizeUsd: input.accountSizeUsd,
  });
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
  const history = await historyService.create({
    requestPayload: payload,
    aiResponseRaw: rawLabel,
    parsedResult: recommendation,
  });
  return { result: recommendation, history };
}
