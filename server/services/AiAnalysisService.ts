import { z } from "zod";
import type {
  AiAutoTradeVeto,
  AiAutoTradeVetoResult,
  AiAnalysisResult,
  AiOrderReview,
  AiOrderReviewResult,
  AiTradeRecommendation,
} from "../../types/ai";
import type {
  ActiveMt5Order,
  AnalysisHistoryRecord,
  AnalysisPayload,
} from "../../types/trading";
import { buildActiveOrderReviewPrompt } from "../prompts/active-order-review.prompt";
import {
  buildAutoTradeVetoPrompt,
  type AutoTradeVetoPromptInput,
} from "../prompts/auto-trade-veto.prompt";
import { buildOrderReviewPrompt } from "../prompts/order-review.prompt";
import { buildTradingAnalysisPrompt } from "../prompts/trading-analysis.prompt";
import { extractJsonObject } from "../utils/jsonParser";
import { TradeValidationService } from "./TradeValidationService";

const entryZoneSchema = z.preprocess(
  normalizeEntryZone,
  z.object({ from: z.number(), to: z.number() }).nullable(),
);

const riskRewardSchema = z.preprocess(
  normalizeRiskReward,
  z.string().nullable(),
);

const orderTypeSchema = z.preprocess(
  normalizeOrderType,
  z
    .enum(["MARKET", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"])
    .default("MARKET"),
);

const recommendationSchema = z.object({
  decision: z.enum(["TRADE", "NO_TRADE"]),
  symbol: z.enum(["XAUUSD", "EURUSD"]),
  direction: z.enum(["BUY", "SELL", "NONE"]),
  order_type: orderTypeSchema,
  confidence: z.number().min(0).max(100),
  estimated_win_probability: z.number().min(0).max(100).optional(),
  entry_zone: entryZoneSchema,
  stop_loss: z.number().nullable(),
  stop_loss_reason: z.preprocess(normalizeNullableString, z.string()),
  take_profit: z.number().nullable(),
  take_profit_reason: z.preprocess(normalizeNullableString, z.string()),
  risk_reward: riskRewardSchema,
  expected_holding_time: z.string().nullable(),
  cancel_after_minutes: z.number().int().min(1).max(240).nullable().default(null),
  position_sizing: z.object({
    account_size_usd: z.number(),
    max_loss_usd: z.number(),
    max_loss_percent: z.number(),
    suggested_lot: z.number().nullable(),
    estimated_loss_if_sl_hit: z.number().nullable(),
    position_sizing_explanation: z.string(),
  }),
  current_price: z.number().default(0),
  market_context: z.string().default("Chưa có bối cảnh thị trường chi tiết."),
  trade_reason: z.string().default("Chưa có lý do vào lệnh hợp lệ."),
  entry_plan: z.string().default("Chưa có kế hoạch entry hợp lệ."),
  summary: z.string(),
  technical_analysis: z.object({
    trend: z.string(),
    momentum: z.string(),
    support_resistance: z.string(),
    volatility: z.string(),
    timeframe_alignment: z.string(),
  }),
  news_analysis: z.object({
    sentiment: z.string(),
    supporting_news: z.array(z.string()),
    risk_news: z.array(z.string()),
    upcoming_high_impact_events: z.array(z.string()),
  }),
  main_reasons: z.array(z.string()),
  risk_factors: z.array(z.string()),
  invalid_conditions: z.array(z.string()),
  no_trade_reasons: z.array(z.string()).optional(),
  conditions_to_recheck: z.array(z.string()).optional(),
  trade_validation_failures: z.array(z.string()).optional(),
  best_case_scenario: z.string(),
  worst_case_scenario: z.string(),
  pre_entry_checklist: z.array(z.string()),
  no_trade_reason: z.string(),
  next_check_suggestion: z.string(),
  risky_trade: z
    .object({
      enabled: z.boolean(),
      title: z.string(),
      direction: z.enum(["BUY", "SELL"]),
      order_type: z.enum(["BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"]),
      estimated_win_probability: z.number().min(0).max(100),
      entry_zone: z.object({ from: z.number(), to: z.number() }),
      stop_loss: z.number(),
      take_profit: z.number(),
      risk_reward: z.preprocess(normalizeRiskReward, z.string()),
      cancel_after_minutes: z.number().int().min(1).max(240).default(30),
      suggested_lot: z.number().nullable(),
      estimated_loss_if_sl_hit: z.number().nullable(),
      reason: z.string(),
      entry_conditions: z.array(z.string()),
      cancel_conditions: z.array(z.string()),
      warning: z.string(),
    })
    .nullable()
    .default(null),
  disclaimer: z.string(),
});

const orderReviewSchema = z.object({
  symbol: z.enum(["XAUUSD", "EURUSD"]),
  reviewed_history_id: z.string(),
  current_price: z.number(),
  order_status_assessment: z.enum([
    "LIKELY_NOT_FILLED",
    "LIKELY_FILLED",
    "ALREADY_INVALIDATED",
    "UNCLEAR",
  ]),
  recommended_action: z.enum([
    "KEEP_ORDER",
    "CANCEL_ORDER",
    "MOVE_SL",
    "MOVE_TP",
    "MOVE_SL_TP",
    "WAIT",
    "CLOSE_MANUALLY",
    "TRADE_COMPLETED",
  ]),
  confidence: z.number().min(0).max(100),
  summary: z.string(),
  fill_assessment: z.string(),
  action_reason: z.string(),
  stop_loss_plan: z.object({
    keep_current: z.boolean(),
    suggested_stop_loss: z.number().nullable(),
    reason: z.string(),
  }),
  take_profit_plan: z.object({
    keep_current: z.boolean(),
    suggested_take_profit: z.number().nullable(),
    reason: z.string(),
  }),
  cancellation_conditions: z.array(z.string()),
  risk_warnings: z.array(z.string()),
  next_check_minutes: z.number().min(1).max(240),
  checklist: z.array(z.string()),
  scenario_reviews: z
    .array(
      z.object({
        scenario: z.enum(["MAIN_RECOMMENDATION", "RISKY_TRADE"]),
        title: z.string(),
        available: z.boolean(),
        order_status_assessment: z.enum([
          "LIKELY_NOT_FILLED",
          "LIKELY_FILLED",
          "ALREADY_INVALIDATED",
          "UNCLEAR",
        ]),
        recommended_action: z.enum([
          "KEEP_ORDER",
          "CANCEL_ORDER",
          "MOVE_SL",
          "MOVE_TP",
          "MOVE_SL_TP",
          "WAIT",
          "CLOSE_MANUALLY",
          "TRADE_COMPLETED",
        ]),
        confidence: z.number().min(0).max(100),
        summary: z.string(),
        fill_assessment: z.string(),
        action_reason: z.string(),
        entry_zone: entryZoneSchema,
        stop_loss: z.number().nullable(),
        take_profit: z.number().nullable(),
        cancellation_conditions: z.array(z.string()),
        risk_warnings: z.array(z.string()),
        checklist: z.array(z.string()),
      }),
    )
    .optional()
    .default([]),
  disclaimer: z.string(),
});

const autoTradeVetoSchema = z.object({
  decision: z.enum(["ALLOW", "BLOCK"]),
  confidence: z.number().min(0).max(100),
  direction_assessment: z.enum(["ALIGNED", "CONFLICTING", "UNCLEAR"]),
  data_status: z.enum(["OK", "STALE", "LOW_QUALITY", "EXECUTION_BLOCKED"]),
  adjusted_trade: z
    .object({
      order_type: z.enum(["MARKET"]),
      lot: z.number().positive(),
      entry: z.number().positive(),
      stop_loss: z.number().positive(),
      take_profit: z.number().positive(),
      risk_reward: z.number().positive(),
      reason: z.preprocess(normalizeNullableString, z.string()),
    })
    .nullable()
    .default(null),
  summary: z.preprocess(normalizeNullableString, z.string()),
  blocker_reasons: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  checklist: z.array(z.string()).default([]),
  disclaimer: z.preprocess(normalizeNullableString, z.string()),
});

function normalizeEntryZone(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const matches = value.match(/-?\d+(?:[.,]\d+)?/g);
  if (!matches || matches.length !== 2) return value;

  const [fromText, toText] = matches;
  const from = Number(fromText?.replace(",", "."));
  const to = Number(toText?.replace(",", "."));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return value;

  return { from, to };
}

function normalizeRiskReward(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return `1:${value}`;
}

function normalizeNullableString(value: unknown): unknown {
  return value === null ? "" : value;
}

function normalizeOrderType(value: unknown): unknown {
  return value === null || value === undefined || value === "" || value === "NONE"
    ? "MARKET"
    : value;
}

export class AiAnalysisService {
  private readonly validationService = new TradeValidationService();

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      baseUrl: string;
      timeoutMs: number;
    },
  ) {}

  async analyze(payload: AnalysisPayload): Promise<AiAnalysisResult> {
    if (!this.options.apiKey) {
      throw new Error("Chưa cấu hình Evolink API key.");
    }

    console.info("[ai:payload]", JSON.stringify(payload, null, 2));
    const prompt = buildTradingAnalysisPrompt(payload);
    const raw = await this.callWithRetry(prompt);
    const parsed = this.parseOrNoTrade(raw, payload);
    return { raw, parsed: this.validationService.validate(parsed, payload) };
  }

  async reviewAutoTradeVeto(
    input: AutoTradeVetoPromptInput,
  ): Promise<AiAutoTradeVetoResult> {
    if (!this.options.apiKey) {
      throw new Error("Chưa cấu hình Evolink API key.");
    }

    const prompt = buildAutoTradeVetoPrompt(input);
    const raw = await this.callWithRetry(prompt);
    return { raw, parsed: this.parseAutoTradeVeto(raw) };
  }

  async reviewOrder(input: {
    history: AnalysisHistoryRecord;
    latestPayload: AnalysisPayload;
    actualEntry: number | null;
    actualExit: number | null;
    actualProfitLoss: number | null;
    actualOrderPlacedAt: string | null;
    userNote: string;
    resultStatus: string;
  }): Promise<AiOrderReviewResult> {
    if (!this.options.apiKey) {
      throw new Error("Chưa cấu hình Evolink API key.");
    }

    const prompt = buildOrderReviewPrompt(input);
    const raw = await this.callWithRetry(prompt);
    return { raw, parsed: this.parseOrderReview(raw, input) };
  }

  async reviewActiveOrder(input: {
    order: ActiveMt5Order;
    latestPayload: AnalysisPayload;
    matchingHistory: AnalysisHistoryRecord | null;
  }): Promise<AiOrderReviewResult> {
    if (!this.options.apiKey) {
      throw new Error("Chưa cấu hình Evolink API key.");
    }

    const prompt = buildActiveOrderReviewPrompt(input);
    const raw = await this.callWithRetry(prompt);
    return { raw, parsed: this.parseActiveOrderReview(raw, input) };
  }

  private async callWithRetry(prompt: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.callEvolink(prompt);
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Không gửi được yêu cầu phân tích AI.");
  }

  private async callEvolink(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs,
    );

    try {
      const response = await fetch(this.options.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: normalizeModel(this.options.model),
          messages: [
            {
              role: "system",
              content:
                "Return strict JSON only. Analyze only the requested symbol in the payload. All user-facing content must be written in Vietnamese. Only enum values and symbols may remain in English.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const message = sanitizeErrorBody(errorBody);
        console.warn(
          `[ai:evolink] HTTP ${response.status}${message ? `: ${message}` : ""}`,
        );
        throw new Error(
          message
            ? `AI trả HTTP ${response.status}: ${message}`
            : `AI trả HTTP ${response.status}.`,
        );
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        output_text?: string;
      };
      const content = json.choices?.[0]?.message?.content ?? json.output_text;
      if (!content) {
        throw new Error("AI không trả nội dung phân tích.");
      }
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseOrNoTrade(
    raw: string,
    payload: AnalysisPayload,
  ): AiTradeRecommendation {
    try {
      const extracted = extractJsonObject(raw);
      const parsed = recommendationSchema.parse(extracted);
      return {
        ...parsed,
        estimated_win_probability:
          parsed.estimated_win_probability ?? parsed.confidence,
      };
    } catch (error) {
      const reason =
        error instanceof Error
          ? `AI trả JSON không hợp lệ: ${error.message}`
          : "AI trả JSON không hợp lệ.";
      return buildNoTradeRecommendation(payload, reason);
    }
  }

  private parseOrderReview(
    raw: string,
    input: {
      history: AnalysisHistoryRecord;
      latestPayload: AnalysisPayload;
    },
  ): AiOrderReview {
    try {
      const extracted = extractJsonObject(raw);
      return orderReviewSchema.parse(extracted);
    } catch (error) {
      const reason =
        error instanceof Error
          ? `AI trả JSON không hợp lệ: ${error.message}`
          : "AI trả JSON không hợp lệ.";
      return buildFallbackOrderReview(input.history, input.latestPayload, reason);
    }
  }

  private parseActiveOrderReview(
    raw: string,
    input: {
      order: ActiveMt5Order;
      latestPayload: AnalysisPayload;
    },
  ): AiOrderReview {
    try {
      const extracted = extractJsonObject(raw);
      return orderReviewSchema.parse(extracted);
    } catch (error) {
      const reason =
        error instanceof Error
          ? `AI trả JSON không hợp lệ: ${error.message}`
          : "AI trả JSON không hợp lệ.";
      return buildFallbackActiveOrderReview(
        input.order,
        input.latestPayload,
        reason,
      );
    }
  }

  private parseAutoTradeVeto(raw: string): AiAutoTradeVeto {
    const extracted = extractJsonObject(raw);
    return autoTradeVetoSchema.parse(extracted);
  }
}

function buildFallbackActiveOrderReview(
  order: ActiveMt5Order,
  payload: AnalysisPayload,
  reason: string,
): AiOrderReview {
  const symbol = payload.symbols[0]?.market.symbol ?? "XAUUSD";
  return {
    symbol,
    reviewed_history_id: String(order.ticket),
    current_price: payload.symbols[0]?.market.price ?? 0,
    order_status_assessment:
      order.state === "FILLED" ? "LIKELY_FILLED" : "LIKELY_NOT_FILLED",
    recommended_action: "WAIT",
    confidence: 0,
    summary: "Không xác thực được phản hồi AI khi check lệnh đang active.",
    fill_assessment:
      order.state === "FILLED"
        ? "Lệnh đang là vị thế mở trên MT5."
        : "Lệnh đang là lệnh chờ trên MT5.",
    action_reason: reason,
    stop_loss_plan: {
      keep_current: true,
      suggested_stop_loss: null,
      reason: "Không dời SL khi phản hồi AI không hợp lệ.",
    },
    take_profit_plan: {
      keep_current: true,
      suggested_take_profit: null,
      reason: "Không dời TP khi phản hồi AI không hợp lệ.",
    },
    cancellation_conditions: ["Chạy lại check lệnh khi AI trả JSON hợp lệ."],
    risk_warnings: [reason],
    next_check_minutes: 15,
    checklist: ["Kiểm tra trực tiếp trạng thái lệnh trên Exness/MT5."],
    disclaimer:
      "Đây là gợi ý phân tích từ AI, không phải lời khuyên tài chính. Người dùng tự chịu trách nhiệm với quyết định giao dịch.",
  };
}

function buildFallbackOrderReview(
  history: AnalysisHistoryRecord,
  payload: AnalysisPayload,
  reason: string,
): AiOrderReview {
  const symbol = payload.symbols[0]?.market.symbol ?? history.symbol;
  return {
    symbol: symbol === "EURUSD" ? "EURUSD" : "XAUUSD",
    reviewed_history_id: history.id,
    current_price: payload.symbols[0]?.market.price ?? 0,
    order_status_assessment: "UNCLEAR",
    recommended_action: "WAIT",
    confidence: 0,
    summary: "Không xác thực được phản hồi AI khi check lại lệnh.",
    fill_assessment: "Không thể kết luận lệnh đã khớp hay chưa.",
    action_reason: reason,
    stop_loss_plan: {
      keep_current: true,
      suggested_stop_loss: null,
      reason: "Không dời SL khi phản hồi AI không hợp lệ.",
    },
    take_profit_plan: {
      keep_current: true,
      suggested_take_profit: null,
      reason: "Không dời TP khi phản hồi AI không hợp lệ.",
    },
    cancellation_conditions: ["Chạy lại check lệnh khi AI trả JSON hợp lệ."],
    risk_warnings: [reason],
    next_check_minutes: 15,
    checklist: ["Kiểm tra trực tiếp trạng thái lệnh trên Exness."],
    disclaimer:
      "Đây là gợi ý phân tích từ AI, không phải lời khuyên tài chính. Người dùng tự chịu trách nhiệm với quyết định giao dịch.",
  };
}

function sanitizeErrorBody(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeModel(value: string): string {
  if (value === "gemini-3-5-flash") return "gemini-3.5-flash";
  if (value === "claude-opus-4.8") return "claude-opus-4-8";
  return value;
}

function buildNoTradeRecommendation(
  payload: AnalysisPayload,
  reason: string,
): AiTradeRecommendation {
  const symbol = payload.symbols[0]?.market.symbol ?? "XAUUSD";
  return {
    decision: "NO_TRADE",
    symbol,
    direction: "NONE",
    order_type: "MARKET",
    confidence: 0,
    estimated_win_probability: 0,
    entry_zone: null,
    stop_loss: null,
    stop_loss_reason: "Không có stop loss vì phản hồi AI không hợp lệ.",
    take_profit: null,
    take_profit_reason: "Không có take profit vì phản hồi AI không hợp lệ.",
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
        "Không vào lệnh vì hệ thống không xác thực được phản hồi AI.",
    },
    current_price: payload.symbols[0]?.market.price ?? 0,
    market_context:
      "Không xác thực được phản hồi AI nên không thể kết luận bối cảnh thị trường.",
    trade_reason: "Không có lý do vào lệnh hợp lệ.",
    entry_plan:
      "Không đặt entry. Chỉ chạy lại phân tích sau khi kiểm tra cấu hình AI và dữ liệu provider.",
    summary:
      "Không nên giao dịch vì hệ thống không xác thực được phản hồi AI.",
    technical_analysis: {
      trend: "Không xác thực được phản hồi AI.",
      momentum: "Không xác thực được phản hồi AI.",
      support_resistance: "Không xác thực được phản hồi AI.",
      volatility: "Không xác thực được phản hồi AI.",
      timeframe_alignment: "Không xác thực được phản hồi AI.",
    },
    news_analysis: {
      sentiment: "Không xác thực được phản hồi AI.",
      supporting_news: [],
      risk_news: [reason],
      upcoming_high_impact_events: [],
    },
    main_reasons: [reason],
    risk_factors: ["Không thể kiểm chứng cấu trúc phân tích AI."],
    invalid_conditions: [],
    no_trade_reasons: [reason],
    conditions_to_recheck: [
      "Phân tích lại khi dữ liệu thị trường, quote và phản hồi AI hợp lệ.",
    ],
    trade_validation_failures: [],
    best_case_scenario: "Chờ phân tích mới với phản hồi AI hợp lệ.",
    worst_case_scenario:
      "Vào lệnh khi dữ liệu phân tích không hợp lệ có thể dẫn đến quyết định sai.",
    pre_entry_checklist: [
      "Không vào lệnh.",
      "Chạy lại phân tích sau khi kiểm tra cấu hình AI.",
    ],
    no_trade_reason: reason,
    next_check_suggestion:
      "Kiểm tra Evolink model/base URL/API key và chạy lại phân tích.",
    risky_trade: null,
    disclaimer:
      "Đây là gợi ý phân tích từ AI, không phải lời khuyên tài chính. Người dùng tự chịu trách nhiệm với quyết định giao dịch.",
  };
}
