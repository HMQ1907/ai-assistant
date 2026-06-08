import type { TradeDecision, TradeDirection } from './trading'

export interface AiTradeRecommendation {
  decision: TradeDecision
  symbol: string
  direction: TradeDirection
  confidence: number
  entry_zone: {
    from: number
    to: number
  }
  stop_loss: number
  take_profit: number
  risk_reward: string
  expected_holding_time: string
  position_sizing: {
    account_size_usd: number
    risk_percent: number
    max_loss_usd: number
    suggested_lot: string
  }
  summary: string
  technical_analysis: {
    trend: string
    momentum: string
    support_resistance: string
    volatility: string
    timeframe_alignment: string
  }
  news_analysis: {
    sentiment: string
    supporting_news: string[]
    risk_news: string[]
    upcoming_high_impact_events: string[]
  }
  why_this_symbol: string
  why_not_others: string[]
  main_reasons: string[]
  risk_factors: string[]
  invalid_conditions: string[]
  best_case_scenario: string
  worst_case_scenario: string
  pre_entry_checklist: string[]
  no_trade_reason: string
  next_check_suggestion: string
  disclaimer: string
}

export interface AiAnalysisResult {
  raw: string
  parsed: AiTradeRecommendation
}
