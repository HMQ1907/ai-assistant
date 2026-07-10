export const SYMBOLS = ["XAUUSD", "EURUSD"] as const;

export const TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4"] as const;

export type SymbolCode = (typeof SYMBOLS)[number];
export type Timeframe = (typeof TIMEFRAMES)[number];
export type TradeDecision = "TRADE" | "NO_TRADE";
export type TradeDirection = "BUY" | "SELL" | "NONE";
export type ResultStatus = "PENDING" | "WIN" | "LOSS" | "BREAKEVEN" | "SKIPPED";
export type OrderState =
  | "NONE"
  | "PENDING"
  | "FILLED"
  | "CANCELLED"
  | "CLOSED";
export type DataQuality = "HIGH" | "MEDIUM" | "LOW";
export type NewsDataStatus =
  | "AVAILABLE"
  | "NO_RELEVANT_DATA"
  | "STALE"
  | "UNAVAILABLE";
export type BidAskStatus = "AVAILABLE" | "UNAVAILABLE" | "INVALID";
export type IndicatorTrend =
  | "UPTREND"
  | "DOWNTREND"
  | "SIDEWAY_OR_MIXED"
  | "INSUFFICIENT_DATA";
export type CandleFilterReason =
  | "INVALID_SHAPE"
  | "INVALID_NUMBER"
  | "INVALID_TIMESTAMP"
  | "DUPLICATE_TIMESTAMP"
  | "REPEATED_OHLC"
  | "ZERO_RANGE"
  | "LOW_RANGE"
  | "FROZEN_SEQUENCE"
  | "INCOMPLETE_CANDLE"
  | "EXPECTED_MARKET_CLOSED";

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  symbol: SymbolCode;
  price: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  bidAskStatus: BidAskStatus;
  data_quality: DataQuality;
  data_warnings: string[];
  informational_diagnostics: string[];
  critical_errors: string[];
  updated_at: string;
  provider: string;
  providerFetchedAt: string;
  providerQuoteTime: string | null;
  quoteAgeSeconds: number | null;
  quoteTimestampReliable: boolean;
  candles: Record<Timeframe, Candle[]>;
  filtered_candles?: Partial<Record<Timeframe, number>>;
  candle_diagnostics: Record<Timeframe, CandleDiagnostics>;
  timeframe_quality: Record<Timeframe, TimeframeQuality>;
}

export interface CandleDiagnostics {
  requestedCount: number;
  receivedCount: number;
  validCount: number;
  filteredCount: number;
  reasons: Partial<Record<CandleFilterReason, number>>;
  firstRawCandleTime: string | null;
  lastRawCandleTime: string | null;
  firstValidCandleTime: string | null;
  lastValidCandleTime: string | null;
  indicatorDataSufficient: boolean;
}

export interface IndicatorReadiness {
  ema20: boolean;
  ema50: boolean;
  ema200: boolean;
  rsi14: boolean;
  atr14: boolean;
  macd: boolean;
}

export interface TimeframeQuality {
  timeframe: Timeframe;
  quality: DataQuality;
  validCandleCount: number;
  requiredCandleCount: number;
  invalidRatio: number;
  indicatorReadiness: IndicatorReadiness;
  reasons: string[];
}

export interface TimeframeCandleSummary {
  timeframe: Timeframe;
  candleCount: number;
  firstCandleTime: string;
  lastCandleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  averageRange: number;
  averageBody: number;
  filteredOutCandles: number;
}

export type CandlePatternName =
  | "DOJI"
  | "HAMMER"
  | "SHOOTING_STAR"
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "STRONG_BULLISH_BODY"
  | "STRONG_BEARISH_BODY"
  | "BULLISH_REJECTION"
  | "BEARISH_REJECTION";

export interface CandlePatternSignal {
  timeframe: Timeframe;
  pattern: CandlePatternName;
  candleTime: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  strength: "WEAK" | "MEDIUM" | "STRONG";
  explanation: string;
}

export interface MarketPayloadSnapshot {
  symbol: SymbolCode;
  price: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  bidAskStatus: BidAskStatus;
  data_quality: DataQuality;
  data_warnings: string[];
  informational_diagnostics: string[];
  critical_errors: string[];
  updated_at: string;
  provider: string;
  providerFetchedAt: string;
  providerQuoteTime: string | null;
  quoteAgeSeconds: number | null;
  quoteTimestampReliable: boolean;
  candle_summary: Record<Timeframe, TimeframeCandleSummary>;
  recent_candles: Record<Timeframe, Candle[]>;
  candle_patterns: Record<Timeframe, CandlePatternSignal[]>;
  candle_diagnostics: Record<Timeframe, CandleDiagnostics>;
  timeframe_quality: Record<Timeframe, TimeframeQuality>;
}

export interface SupportResistanceLevel {
  price: number;
  touches: number;
  strength: "WEAK" | "MEDIUM" | "STRONG";
}

export interface SupportResistanceSnapshot {
  nearestSupport: number | null;
  nearestResistance: number | null;
  swingHigh: number;
  swingLow: number;
  supportLevels: SupportResistanceLevel[];
  resistanceLevels: SupportResistanceLevel[];
}

export interface TimeframeIndicatorSnapshot {
  timeframe: Timeframe;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: {
    macd: number | null;
    signal: number | null;
    histogram: number | null;
  };
  atr14: number | null;
  readiness: IndicatorReadiness;
  trend: IndicatorTrend;
  structureTrend: IndicatorTrend;
  momentumScore: number | null;
  volatilityScore: number | null;
  marketStructure: SupportResistanceSnapshot;
}

export interface IndicatorSnapshot {
  symbol: SymbolCode;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: {
    macd: number | null;
    signal: number | null;
    histogram: number | null;
  };
  atr14: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  swingHigh: number;
  swingLow: number;
  trendM15: IndicatorTrend;
  trendH1: IndicatorTrend;
  structureTrendM15: IndicatorTrend;
  structureTrendH1: IndicatorTrend;
  momentumScore: number | null;
  volatilityScore: number | null;
  timeframes: Record<Timeframe, TimeframeIndicatorSnapshot>;
  timeframeAlignment: string;
}

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: string;
  category:
    | "USD"
    | "GOLD"
    | "FED"
    | "CPI"
    | "NFP"
    | "PPI"
    | "PMI"
    | "RATES"
    | "GEOPOLITICAL";
  impact: "LOW" | "MEDIUM" | "HIGH";
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  symbols: SymbolCode[];
}

export interface EconomicEvent {
  title: string;
  scheduledAt: string;
  currency: string;
  impact: "LOW" | "MEDIUM" | "HIGH";
}

export interface NewsSnapshot {
  items: NewsItem[];
  upcomingEvents: EconomicEvent[];
  status: NewsDataStatus;
  provider: string;
  updatedAt: string;
  warnings: string[];
}

export interface NormalizedSymbolPayload {
  market: MarketPayloadSnapshot;
  indicators: IndicatorSnapshot;
}

export interface AnalysisPayload {
  generatedAt: string;
  accountSizeUsd: number;
  maxLossUsdPerTrade: number;
  maxLossPercentPerTrade: number;
  marketDataProvider: string;
  newsProvider: string;
  dataQuality: DataQuality;
  dataWarnings: string[];
  marketDataTimestamp: string;
  newsDataTimestamp: string;
  newsDataStatus: NewsDataStatus;
  symbols: NormalizedSymbolPayload[];
  news: NewsSnapshot;
  rules: string[];
}

export interface AnalysisHistoryRecord {
  id: string;
  created_at: string;
  request_payload: AnalysisPayload;
  ai_response_raw: string;
  parsed_result: unknown;
  decision: TradeDecision;
  symbol: string;
  direction: TradeDirection;
  confidence: number;
  entry_from: number;
  entry_to: number;
  stop_loss: number;
  take_profit: number;
  result_status: ResultStatus;
  actual_entry: number | null;
  actual_exit: number | null;
  actual_profit_loss: number | null;
  actual_order_placed_at: string | null;
  user_note: string;
  market_data_provider: string;
  news_provider: string;
  data_quality: DataQuality;
  data_warnings: string[];
  market_data_timestamp: string;
  news_data_timestamp: string;
  mt5_ticket: number | null;
  order_type: string | null;
  order_state: OrderState;
  placed_at: string | null;
  auto_outcome: SignalAutoOutcome;
  auto_filled: boolean;
  auto_filled_at: string | null;
  auto_first_hit: SignalFirstHit;
  auto_mae: number | null;
  auto_mfe: number | null;
  auto_swept_then_reversed: boolean;
  auto_resolved_at: string | null;
  auto_evaluated_at: string | null;
}

// PENDING = chua khop va con trong cua so cho khop; NOT_FILLED = het han ma khong khop;
// WIN/LOSS = da khop va TP/SL toi truoc; OPEN = da khop, chua cham SL/TP; EXPIRED = khop nhung
// het cua so giu lenh ma khong cham SL/TP.
export type SignalAutoOutcome =
  | "PENDING"
  | "NOT_FILLED"
  | "WIN"
  | "LOSS"
  | "OPEN"
  | "EXPIRED";

export type SignalFirstHit = "SL" | "TP" | null;

export interface SignalOutcomeEvaluation {
  outcome: SignalAutoOutcome;
  filled: boolean;
  filledAt: string | null;
  firstHit: SignalFirstHit;
  mae: number | null;
  mfe: number | null;
  sweptThenReversed: boolean;
  resolvedAt: string | null;
}

export interface ExecutionStats {
  tracked: number;
  filled: number;
  notFilled: number;
  fillRate: number;
  wins: number;
  losses: number;
  open: number;
  expired: number;
  winRate: number;
  sweptThenReversed: number;
  sweptThenReversedRate: number;
  avgMae: number;
  avgMfe: number;
  avgMaeToStopRatio: number;
}

export type ActiveMt5OrderState = "PENDING" | "FILLED";
export type ActiveMt5OrderDirection = "BUY" | "SELL";

export interface ActiveMt5Order {
  ticket: number;
  state: ActiveMt5OrderState;
  symbol: string;
  type: string;
  direction: ActiveMt5OrderDirection;
  volume: number;
  price_open: number;
  stop_loss: number | null;
  take_profit: number | null;
  profit: number | null;
  opened_at: string;
  comment: string;
}

export interface SymbolPerformance {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  totalProfitLoss: number;
}

export interface PerformanceStatsSummary {
  totalAnalysis: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  skipped: number;
  winRate: number;
  avgConfidence: number;
  avgConfidenceOfWinners: number;
  avgConfidenceOfLosers: number;
}

export interface PerformanceStats extends PerformanceStatsSummary {
  allAnalyses: PerformanceStatsSummary;
  tradeAnalyses: PerformanceStatsSummary;
  bestSymbols: SymbolPerformance[];
  worstSymbols: SymbolPerformance[];
  execution: ExecutionStats;
}
