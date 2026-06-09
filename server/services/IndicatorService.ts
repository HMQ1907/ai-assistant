import { TIMEFRAMES } from "../../types/trading";
import type {
  Candle,
  IndicatorSnapshot,
  MarketSnapshot,
  Timeframe,
  TimeframeIndicatorSnapshot,
} from "../../types/trading";
import {
  atr,
  ema,
  macd,
  rsi,
  supportResistance,
  trend,
  indicatorReadiness,
} from "../utils/indicators";

export class IndicatorService {
  calculate(snapshot: MarketSnapshot): IndicatorSnapshot {
    const timeframes = {} as Record<Timeframe, TimeframeIndicatorSnapshot>;

    for (const timeframe of TIMEFRAMES) {
      timeframes[timeframe] = this.calculateTimeframe(
        timeframe,
        snapshot.candles[timeframe],
        snapshot.price,
      );
    }

    const primary = timeframes.M15;
    const h1 = timeframes.H1;

    return {
      symbol: snapshot.symbol,
      ema20: primary.ema20,
      ema50: primary.ema50,
      ema200: primary.ema200,
      rsi14: primary.rsi14,
      macd: primary.macd,
      atr14: primary.atr14,
      nearestSupport: primary.marketStructure.nearestSupport,
      nearestResistance: primary.marketStructure.nearestResistance,
      swingHigh: primary.marketStructure.swingHigh,
      swingLow: primary.marketStructure.swingLow,
      trendM15: primary.trend,
      trendH1: h1.trend,
      momentumScore: primary.momentumScore,
      volatilityScore: primary.volatilityScore,
      timeframes,
      timeframeAlignment: this.alignTimeframes(timeframes),
    };
  }

  calculateMany(snapshots: MarketSnapshot[]): IndicatorSnapshot[] {
    return snapshots.map((snapshot) => this.calculate(snapshot));
  }

  private calculateTimeframe(
    timeframe: Timeframe,
    candles: Candle[],
    fallbackPrice: number,
  ): TimeframeIndicatorSnapshot {
    const closes = candles.map((candle) => candle.close);
    const atr14 = atr(candles);
    const current = closes.at(-1) ?? fallbackPrice;
    const readiness = indicatorReadiness(closes, candles);

    return {
      timeframe,
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
      rsi14: rsi(closes),
      macd: macd(closes),
      atr14,
      readiness,
      trend: trend(closes),
      momentumScore: this.scoreMomentum(candles, atr14),
      volatilityScore: Math.min(
        100,
        Math.round(((atr14 ?? 0) / Math.max(current, 0.00001)) * 10000),
      ),
      marketStructure: supportResistance(candles),
    };
  }

  private scoreMomentum(candles: Candle[], atr14: number | null): number {
    const recent = candles.slice(-12);
    if (recent.length < 2) return 50;
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last) return 50;

    const priceMove = last.close - first.open;
    const averageRange =
      recent.reduce((sum, candle) => sum + (candle.high - candle.low), 0) /
      recent.length;
    const normalizer = Math.max(atr14 ?? 0, averageRange, 0.00001);
    const normalizedMove = priceMove / normalizer;
    return Math.max(0, Math.min(100, Math.round(50 + normalizedMove * 12)));
  }

  private alignTimeframes(
    timeframes: Record<Timeframe, TimeframeIndicatorSnapshot>,
  ): string {
    const trends = TIMEFRAMES.map((timeframe) => timeframes[timeframe].trend);
    const up = trends.filter((item) => item === "UPTREND").length;
    const down = trends.filter((item) => item === "DOWNTREND").length;

    if (up >= 3) return "BULLISH_ALIGNMENT";
    if (down >= 3) return "BEARISH_ALIGNMENT";
    if (trends.some((item) => item === "INSUFFICIENT_DATA")) {
      return "INSUFFICIENT_DATA";
    }
    return "MIXED_ALIGNMENT";
  }
}
