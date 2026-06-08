export const SYMBOLS = [
  'XAUUSD',
  'BTCUSD',
  'ETHUSD',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'USDCAD',
  'AUDUSD',
  'NAS100',
  'US30'
] as const

export const TIMEFRAMES = ['M5', 'M15', 'H1', 'H4'] as const

export type SymbolCode = (typeof SYMBOLS)[number]
export type Timeframe = (typeof TIMEFRAMES)[number]
export type TradeDecision = 'TRADE' | 'NO_TRADE'
export type TradeDirection = 'BUY' | 'SELL' | 'NONE'
export type ResultStatus = 'PENDING' | 'WIN' | 'LOSS' | 'SKIPPED'

export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketSnapshot {
  symbol: SymbolCode
  price: number
  bid?: number
  ask?: number
  spread: number
  candles: Record<Timeframe, Candle[]>
}

export interface IndicatorSnapshot {
  symbol: SymbolCode
  ema20: number
  ema50: number
  ema200: number
  rsi14: number
  macd: {
    macd: number
    signal: number
    histogram: number
  }
  atr14: number
  nearestSupport: number
  nearestResistance: number
  swingHigh: number
  swingLow: number
  trendM15: string
  trendH1: string
  momentumScore: number
  volatilityScore: number
}

export interface NewsItem {
  title: string
  source: string
  publishedAt: string
  category: 'USD' | 'GOLD' | 'CRYPTO' | 'FED' | 'CPI' | 'NFP' | 'PPI' | 'PMI' | 'RATES' | 'GEOPOLITICAL'
  impact: 'LOW' | 'MEDIUM' | 'HIGH'
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  symbols: SymbolCode[]
}

export interface EconomicEvent {
  title: string
  scheduledAt: string
  currency: string
  impact: 'LOW' | 'MEDIUM' | 'HIGH'
}

export interface NewsSnapshot {
  items: NewsItem[]
  upcomingEvents: EconomicEvent[]
}

export interface NormalizedSymbolPayload {
  market: MarketSnapshot
  indicators: IndicatorSnapshot
}

export interface AnalysisPayload {
  generatedAt: string
  accountSizeUsd: number
  symbols: NormalizedSymbolPayload[]
  news: NewsSnapshot
  rules: string[]
}

export interface AnalysisHistoryRecord {
  id: number
  created_at: string
  request_payload: string
  ai_response_raw: string
  parsed_result: string
  decision: TradeDecision
  symbol: string
  direction: TradeDirection
  confidence: number
  entry: string
  stop_loss: number
  take_profit: number
  result_status: ResultStatus
  user_note: string
}
