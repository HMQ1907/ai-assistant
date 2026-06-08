import { z } from 'zod'
import type { AiAnalysisResult, AiTradeRecommendation } from '../../types/ai'
import type { AnalysisPayload } from '../../types/trading'
import { buildTradingAnalysisPrompt } from '../prompts/trading-analysis.prompt'
import { extractJsonObject } from '../utils/jsonParser'
import { parseRiskReward } from '../utils/risk'

const recommendationSchema = z.object({
  decision: z.enum(['TRADE', 'NO_TRADE']),
  symbol: z.string(),
  direction: z.enum(['BUY', 'SELL', 'NONE']),
  confidence: z.number().min(0).max(100),
  entry_zone: z.object({ from: z.number(), to: z.number() }),
  stop_loss: z.number(),
  take_profit: z.number(),
  risk_reward: z.string(),
  expected_holding_time: z.string(),
  position_sizing: z.object({
    account_size_usd: z.number(),
    risk_percent: z.number(),
    max_loss_usd: z.number(),
    suggested_lot: z.string()
  }),
  summary: z.string(),
  technical_analysis: z.object({
    trend: z.string(),
    momentum: z.string(),
    support_resistance: z.string(),
    volatility: z.string(),
    timeframe_alignment: z.string()
  }),
  news_analysis: z.object({
    sentiment: z.string(),
    supporting_news: z.array(z.string()),
    risk_news: z.array(z.string()),
    upcoming_high_impact_events: z.array(z.string())
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
  disclaimer: z.string()
})

export class AiAnalysisService {
  constructor(
    private readonly options: {
      apiKey: string
      model: string
      baseUrl: string
      timeoutMs: number
    }
  ) {}

  async analyze(payload: AnalysisPayload): Promise<AiAnalysisResult> {
    if (!this.options.apiKey) {
      const parsed = this.applyLocalSafetyRules(this.mockRecommendation(payload))
      return { raw: JSON.stringify(parsed), parsed }
    }

    const prompt = buildTradingAnalysisPrompt(payload)
    const raw = await this.callWithRetry(prompt)
    const parsed = this.parseAndValidate(raw)
    return { raw, parsed: this.applyLocalSafetyRules(parsed) }
  }

  private async callWithRetry(prompt: string): Promise<string> {
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.callEvolink(prompt)
      } catch (error) {
        lastError = error
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800))
      }
    }
    throw lastError instanceof Error ? lastError : new Error('AI request failed')
  }

  private async callEvolink(prompt: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const response = await fetch(this.options.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: 'Return strict JSON only. You are conservative and safety-first.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        }),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`AI request failed with status ${response.status}`)
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; output_text?: string }
      const content = json.choices?.[0]?.message?.content ?? json.output_text
      if (!content) throw new Error('AI response did not include content')
      return content
    } finally {
      clearTimeout(timeout)
    }
  }

  private parseAndValidate(raw: string): AiTradeRecommendation {
    const extracted = extractJsonObject(raw)
    return recommendationSchema.parse(extracted)
  }

  private applyLocalSafetyRules(recommendation: AiTradeRecommendation): AiTradeRecommendation {
    const riskReward = parseRiskReward(recommendation.risk_reward)
    if (recommendation.confidence < 70 || riskReward < 1.5) {
      return {
        ...recommendation,
        decision: 'NO_TRADE',
        direction: 'NONE',
        no_trade_reason: recommendation.no_trade_reason || 'Local safety rule blocked the trade because confidence or risk reward did not meet minimum requirements.'
      }
    }
    return recommendation
  }

  private mockRecommendation(payload: AnalysisPayload): AiTradeRecommendation {
    const nearest = payload.symbols[0]
    const symbol = nearest?.market.symbol ?? 'XAUUSD'

    return {
      decision: 'NO_TRADE',
      symbol,
      direction: 'NONE',
      confidence: 62,
      entry_zone: { from: 0, to: 0 },
      stop_loss: 0,
      take_profit: 0,
      risk_reward: '1:1.2',
      expected_holding_time: '15-60 minutes',
      position_sizing: {
        account_size_usd: 100,
        risk_percent: 1,
        max_loss_usd: 1,
        suggested_lot: 'No lot suggested because the mock analysis returns NO_TRADE.'
      },
      summary: 'Mock analysis finds no clean setup strong enough for a manual trade.',
      technical_analysis: {
        trend: `Closest symbol ${symbol} has ${nearest?.indicators.trendM15 ?? 'mixed'} M15 structure and ${nearest?.indicators.trendH1 ?? 'mixed'} H1 structure.`,
        momentum: 'Momentum is not strong enough to justify forcing a trade.',
        support_resistance: 'Price is near a range area, so entry quality is not clear.',
        volatility: 'Volatility is acceptable but not directional enough.',
        timeframe_alignment: 'M15 and H1 are not aligned strongly enough.'
      },
      news_analysis: {
        sentiment: 'Neutral to cautious.',
        supporting_news: [],
        risk_news: payload.news.items.map((item) => item.title),
        upcoming_high_impact_events: payload.news.upcomingEvents.filter((event) => event.impact === 'HIGH').map((event) => `${event.title} at ${event.scheduledAt}`)
      },
      why_this_symbol: `${symbol} is the nearest candidate in the scan but still does not meet safety rules.`,
      why_not_others: payload.symbols.slice(1).map((item) => `${item.market.symbol}: lower clarity or mixed alignment in mock data.`),
      main_reasons: ['Confidence below 70', 'Risk reward below 1:1.5', 'No strong multi-timeframe alignment'],
      risk_factors: ['Mock data only', 'Market may be sideway', 'Upcoming USD event risk'],
      invalid_conditions: ['Do not enter if spread widens', 'Do not enter before high-impact news', 'Do not enter without manual confirmation'],
      best_case_scenario: 'Wait for a cleaner breakout or pullback with aligned M15/H1 trend.',
      worst_case_scenario: 'Entering a mixed range creates fast stop-out risk.',
      pre_entry_checklist: ['Confirm spread on Exness', 'Check upcoming red news', 'Confirm SL/TP before clicking Buy/Sell manually', 'Risk no more than 1 USD on a 100 USD test account'],
      no_trade_reason: 'No setup meets the minimum confidence and risk-reward requirements.',
      next_check_suggestion: 'Check again in 30-60 minutes or after the next high-impact event passes.',
      disclaimer: 'This is an AI-generated trading suggestion, not financial advice. User must make the final decision.'
    }
  }
}
