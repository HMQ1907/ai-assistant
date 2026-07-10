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
  structureTrend,
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

    // Khung quyet dinh la H1 (intraday-swing). Cac field tom tat cap cao phan anh H1;
    // M15 chi dung de canh diem vao, M5 chi de xac nhan khoanh khac bam lenh.
    const primary = timeframes.H1;
    const m15 = timeframes.M15;
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
      trendM15: m15.trend,
      trendH1: h1.trend,
      structureTrendM15: m15.structureTrend,
      structureTrendH1: h1.structureTrend,
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
      structureTrend: structureTrend(candles),
      momentumScore: this.scoreMomentum(candles, atr14),
      volatilityScore: this.scoreVolatility(atr14, current),
      marketStructure: supportResistance(candles, fallbackPrice),
    };
  }

  // Trả null khi không đủ data thay vì bịa 50 (trung tính) — để AI phân biệt
  // "momentum trung tính thật" với "không tính được".
  private scoreMomentum(candles: Candle[], atr14: number | null): number | null {
    const recent = candles.slice(-12);
    if (recent.length < 2) return null;
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last) return null;

    const range =
      recent.reduce((sum, candle) => sum + (candle.high - candle.low), 0) /
      recent.length;
    const normalizer = Math.max(atr14 ?? 0, range, 0);
    if (normalizer <= 0) return null;

    const normalizedMove = (last.close - first.open) / normalizer;
    return Math.max(0, Math.min(100, Math.round(50 + normalizedMove * 12)));
  }

  // Trả null khi atr/giá không hợp lệ thay vì né chia-0 bằng 0.00001 (tạo số giả).
  private scoreVolatility(
    atr14: number | null,
    current: number,
  ): number | null {
    if (atr14 === null || !Number.isFinite(current) || current <= 0) {
      return null;
    }
    return Math.min(100, Math.round((atr14 / current) * 10000));
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

    // Khi EMA trend (lagging) không đồng thuận, kiểm tra structure trend để
    // phát hiện chuyển pha sớm mà EMA chưa kịp phản ánh.
    const structure = TIMEFRAMES.map(
      (timeframe) => timeframes[timeframe].structureTrend,
    );
    const structureUp = structure.filter((item) => item === "UPTREND").length;
    const structureDown = structure.filter(
      (item) => item === "DOWNTREND",
    ).length;
    if (structureUp >= 3 && down === 0) return "BULLISH_STRUCTURE_SHIFT";
    if (structureDown >= 3 && up === 0) return "BEARISH_STRUCTURE_SHIFT";

    return "MIXED_ALIGNMENT";
  }
}
