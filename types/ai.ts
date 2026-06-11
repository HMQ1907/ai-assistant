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
  risky_trade: RiskyTradeScenario | null;
  disclaimer: string;
}

export interface AiAnalysisResult {
  raw: string;
  parsed: AiTradeRecommendation;
}

export type OrderReviewAction =
  | "KEEP_ORDER"
  | "CANCEL_ORDER"
  | "MOVE_SL"
  | "MOVE_TP"
  | "MOVE_SL_TP"
  | "WAIT"
  | "CLOSE_MANUALLY"
  | "TRADE_COMPLETED";

export type OrderReviewStatus =
  | "LIKELY_NOT_FILLED"
  | "LIKELY_FILLED"
  | "ALREADY_INVALIDATED"
  | "UNCLEAR";

export interface AiOrderReview {
  symbol: "XAUUSD";
  reviewed_history_id: string;
  current_price: number;
  order_status_assessment: OrderReviewStatus;
  recommended_action: OrderReviewAction;
  confidence: number;
  summary: string;
  fill_assessment: string;
  action_reason: string;
  stop_loss_plan: {
    keep_current: boolean;
    suggested_stop_loss: number | null;
    reason: string;
  };
  take_profit_plan: {
    keep_current: boolean;
    suggested_take_profit: number | null;
    reason: string;
  };
  cancellation_conditions: string[];
  risk_warnings: string[];
  next_check_minutes: number;
  checklist: string[];
  disclaimer: string;
}

export interface AiOrderReviewResult {
  raw: string;
  parsed: AiOrderReview;
}

export interface RiskyTradeScenario {
  enabled: boolean;
  title: string;
  direction: Exclude<TradeDirection, "NONE">;
  order_type: "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP";
  estimated_win_probability: number;
  entry_zone: {
    from: number;
    to: number;
  };
  stop_loss: number;
  take_profit: number;
  risk_reward: string;
  suggested_lot: number | null;
  estimated_loss_if_sl_hit: number | null;
  reason: string;
  entry_conditions: string[];
  cancel_conditions: string[];
  warning: string;
}
