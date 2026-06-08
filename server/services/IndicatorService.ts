import type { IndicatorSnapshot, MarketSnapshot } from '../../types/trading'
import { atr, ema, macd, rsi, supportResistance, trend } from '../utils/indicators'

export class IndicatorService {
  calculate(snapshot: MarketSnapshot): IndicatorSnapshot {
    const m15 = snapshot.candles.M15
    const h1 = snapshot.candles.H1
    const closes = m15.map((candle) => candle.close)
    const h1Closes = h1.map((candle) => candle.close)
    const levels = supportResistance(m15)
    const atr14 = atr(m15)
    const current = closes.at(-1) ?? snapshot.price
    const momentumScore = this.scoreMomentum(closes)
    const volatilityScore = Math.min(100, Math.round((atr14 / Math.max(current, 0.00001)) * 10000))

    return {
      symbol: snapshot.symbol,
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
      rsi14: rsi(closes),
      macd: macd(closes),
      atr14,
      nearestSupport: levels.support,
      nearestResistance: levels.resistance,
      swingHigh: levels.swingHigh,
      swingLow: levels.swingLow,
      trendM15: trend(closes),
      trendH1: trend(h1Closes),
      momentumScore,
      volatilityScore
    }
  }

  calculateMany(snapshots: MarketSnapshot[]): IndicatorSnapshot[] {
    return snapshots.map((snapshot) => this.calculate(snapshot))
  }

  private scoreMomentum(values: number[]): number {
    const recent = values.slice(-12)
    if (recent.length < 2) return 50
    const first = recent[0] ?? 0
    const last = recent.at(-1) ?? first
    const change = ((last - first) / Math.max(Math.abs(first), 0.00001)) * 100
    return Math.max(0, Math.min(100, Math.round(50 + change * 180)))
  }
}
