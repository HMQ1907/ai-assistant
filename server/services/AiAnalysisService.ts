import { z } from "zod";
import type { AiAnalysisResult, AiTradeRecommendation } from "../../types/ai";
import type { AnalysisPayload } from "../../types/trading";
import { buildTradingAnalysisPrompt } from "../prompts/trading-analysis.prompt";
import { extractJsonObject } from "../utils/jsonParser";
import { TradeValidationService } from "./TradeValidationService";

const recommendationSchema = z.object({
  decision: z.enum(["TRADE", "NO_TRADE"]),
  symbol: z.enum(["XAUUSD", "BTCUSD"]),
  direction: z.enum(["BUY", "SELL", "NONE"]),
  confidence: z.number().min(0).max(100),
  entry_zone: z.object({ from: z.number(), to: z.number() }).nullable(),
  stop_loss: z.number().nullable(),
  stop_loss_reason: z.string(),
  take_profit: z.number().nullable(),
  take_profit_reason: z.string(),
  risk_reward: z.string().nullable(),
  expected_holding_time: z.string().nullable(),
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
      risk_reward: z.string(),
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
                "Return strict JSON only. Analyze only the symbol supplied in the payload. All user-facing content must be written in Vietnamese. Only enum values and symbols may remain in English.",
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
      const expectedSymbol = payload.symbols[0]?.market.symbol;
      if (!expectedSymbol || parsed.symbol !== expectedSymbol) {
        throw new Error(`AI trả symbol ${parsed.symbol}, mong đợi ${expectedSymbol}.`);
      }
      return parsed;
    } catch (error) {
      const reason =
        error instanceof Error
          ? `AI trả JSON không hợp lệ: ${error.message}`
          : "AI trả JSON không hợp lệ.";
      return buildNoTradeRecommendation(payload, reason);
    }
  }
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
  return {
    decision: "NO_TRADE",
    symbol: payload.symbols[0]?.market.symbol ?? "XAUUSD",
    direction: "NONE",
    confidence: 0,
    entry_zone: null,
    stop_loss: null,
    stop_loss_reason: "Không có stop loss vì phản hồi AI không hợp lệ.",
    take_profit: null,
    take_profit_reason: "Không có take profit vì phản hồi AI không hợp lệ.",
    risk_reward: null,
    expected_holding_time: null,
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
