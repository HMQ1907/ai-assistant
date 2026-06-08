import { z } from "zod";
import type { AiAnalysisResult, AiTradeRecommendation } from "../../types/ai";
import type { AnalysisPayload } from "../../types/trading";
import { buildTradingAnalysisPrompt } from "../prompts/trading-analysis.prompt";
import { extractJsonObject } from "../utils/jsonParser";
import { TradeValidationService } from "./TradeValidationService";

const recommendationSchema = z.object({
  decision: z.enum(["TRADE", "NO_TRADE"]),
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL", "NONE"]),
  confidence: z.number().min(0).max(100),
  symbol_scores: z.array(
    z.object({
      symbol: z.string(),
      score: z.number().min(0).max(100),
      bias: z.enum(["BUY", "SELL", "NONE"]),
      reason: z.string(),
    }),
  ),
  entry_zone: z.object({ from: z.number(), to: z.number() }),
  stop_loss: z.number(),
  take_profit: z.number(),
  risk_reward: z.string(),
  expected_holding_time: z.string(),
  position_sizing: z.object({
    account_size_usd: z.number(),
    risk_percent: z.number(),
    max_loss_usd: z.number(),
    suggested_lot: z.string(),
  }),
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
  why_this_symbol: z.string(),
  why_not_others: z.array(z.string()),
  main_reasons: z.array(z.string()),
  risk_factors: z.array(z.string()),
  invalid_conditions: z.array(z.string()),
  best_case_scenario: z.string(),
  worst_case_scenario: z.string(),
  pre_entry_checklist: z.array(z.string()),
  no_trade_reason: z.string(),
  next_check_suggestion: z.string(),
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

    const prompt = buildTradingAnalysisPrompt(payload);
    const raw = await this.callWithRetry(prompt);
    const parsed = this.parseAndValidate(raw);
    return { raw, parsed: this.validationService.validate(parsed, payload) };
  }

  private async callWithRetry(prompt: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.callEvolink(prompt);
      } catch (error) {
        lastError = error;
        if (attempt < 2)
          await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("AI request failed");
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
          model: this.options.model,
          messages: [
            {
              role: "system",
              content:
                "Return strict JSON only. You are conservative and safety-first.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`AI request failed with status ${response.status}`);
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        output_text?: string;
      };
      const content = json.choices?.[0]?.message?.content ?? json.output_text;
      if (!content) throw new Error("AI response did not include content");
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseAndValidate(raw: string): AiTradeRecommendation {
    const extracted = extractJsonObject(raw);
    return recommendationSchema.parse(extracted);
  }
}
