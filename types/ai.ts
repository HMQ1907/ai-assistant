import type { TradeDecision, TradeDirection } from "./trading";

export interface AiTradeRecommendation {
  decision: TradeDecision;
  symbol: "XAUUSD";
  direction: TradeDirection;
  confidence: number;
  entry_zone: {
    from: number;
    to: number;
  };
  stop_loss: number;
  stop_loss_reason: string;
  take_profit: number;
  take_profit_reason: string;
  risk_reward: string;
  expected_holding_time: string;
  position_sizing: {
    account_size_usd: number;
    max_loss_usd: number;
    estimated_loss_if_sl_hit: number;
    position_sizing_explanation: string;
  };
  summary: string;
  technical_analysis: {
    trend: string;
    momentum: string;
    support_resistance: string;
    volatility: string;
    timeframe_alignment: string;
  };
  news_analysis: {
    sentiment: string;
    supporting_news: string[];
    risk_news: string[];
    upcoming_high_impact_events: string[];
  };
  main_reasons: string[];
  risk_factors: string[];
  invalid_conditions: string[];
  best_case_scenario: string;
  worst_case_scenario: string;
  pre_entry_checklist: string[];
  no_trade_reason: string;
  next_check_suggestion: string;
  disclaimer: string;
}

export interface AiAnalysisResult {
  raw: string;
  parsed: AiTradeRecommendation;
}
