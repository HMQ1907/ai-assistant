import type { TradeDecision, TradeDirection } from "./trading";

export interface AiTradeRecommendation {
  decision: TradeDecision;
  symbol: "XAUUSD";
  direction: TradeDirection;
  confidence: number;
  entry_zone: {
    from: number;
    to: number;
  } | null;
  stop_loss: number | null;
  stop_loss_reason: string;
  take_profit: number | null;
  take_profit_reason: string;
  risk_reward: string | null;
  expected_holding_time: string | null;
  position_sizing: {
    account_size_usd: number;
    max_loss_usd: number;
    max_loss_percent: number;
    suggested_lot: number | null;
    estimated_loss_if_sl_hit: number | null;
    position_sizing_explanation: string;
  };
  current_price: number;
  market_context: string;
  trade_reason: string;
  entry_plan: string;
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
  no_trade_reasons?: string[] | undefined;
  conditions_to_recheck?: string[] | undefined;
  trade_validation_failures?: string[] | undefined;
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
