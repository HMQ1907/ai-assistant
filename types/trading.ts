export const SYMBOLS = ["XAUUSD"] as const;

export const TIMEFRAMES = ["M5", "M15", "H1", "H4"] as const;

export type SymbolCode = (typeof SYMBOLS)[number];
export type Timeframe = (typeof TIMEFRAMES)[number];
export type TradeDecision = "TRADE" | "NO_TRADE";
export type TradeDirection = "BUY" | "SELL" | "NONE";
export type ResultStatus = "PENDING" | "WIN" | "LOSS" | "BREAKEVEN" | "SKIPPED";
export type DataQuality = "HIGH" | "MEDIUM" | "LOW";
export type NewsDataStatus = "AVAILABLE" | "UNAVAILABLE";

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
  bid?: number;
  ask?: number;
  spread: number;
  data_quality: DataQuality;
  data_warnings: string[];
  updated_at: string;
  provider: string;
  candles: Record<Timeframe, Candle[]>;
}

export interface IndicatorSnapshot {
  symbol: SymbolCode;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  };
  atr14: number;
  nearestSupport: number;
  nearestResistance: number;
  swingHigh: number;
  swingLow: number;
  trendM15: string;
  trendH1: string;
  momentumScore: number;
  volatilityScore: number;
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
  market: MarketSnapshot;
  indicators: IndicatorSnapshot;
}

export interface AnalysisPayload {
  generatedAt: string;
  accountSizeUsd: number;
  maxLossUsdPerTrade: number;
  marketDataProvider: string;
  newsProvider: string;
  dataQuality: DataQuality;
  dataWarnings: string[];
  skippedSymbols: Array<{ symbol: string; reason: string }>;
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
  user_note: string;
  market_data_provider: string;
  news_provider: string;
  data_quality: DataQuality;
  data_warnings: string[];
  skipped_symbols: Array<{ symbol: string; reason: string }>;
  market_data_timestamp: string;
  news_data_timestamp: string;
}

export interface SymbolPerformance {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  totalProfitLoss: number;
}

export interface PerformanceStats {
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
  bestSymbols: SymbolPerformance[];
  worstSymbols: SymbolPerformance[];
}
