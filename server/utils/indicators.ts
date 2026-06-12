import type {
  Candle,
  IndicatorReadiness,
  IndicatorTrend,
  SupportResistanceLevel,
  SupportResistanceSnapshot,
} from "../../types/trading";

export function ema(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series.length ? round(series.at(-1) ?? 0) : null;
}

export function emaSeries(values: number[], period: number): number[] {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return [];
  if (clean.length < period) return [];

  const seed = average(clean.slice(0, period));
  const series: number[] = [seed];
  const k = 2 / (period + 1);

  for (const value of clean.slice(period)) {
    const previous = series.at(-1) ?? seed;
    series.push(value * k + previous * (1 - k));
  }

  return series;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;

  const changes: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i];
    const prev = values[i - 1];
    if (current !== undefined && prev !== undefined) {
      changes.push(current - prev);
    }
  }

  let gains = 0;
  let losses = 0;
  for (let i = 0; i < period; i += 1) {
    const change = changes[i] ?? 0;
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < changes.length; i += 1) {
    const change = changes[i] ?? 0;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs), 2);
}

export function macd(values: number[]): {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
} {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 35) return { macd: null, signal: null, histogram: null };

  const ema12 = emaSeries(clean, 12);
  const ema26 = emaSeries(clean, 26);
  const offset = ema12.length - ema26.length;
  const lineSeries = ema26.map(
    (value, index) => (ema12[index + offset] ?? value) - value,
  );
  const signalSeries = emaSeries(lineSeries, 9);
  const line = lineSeries.at(-1) ?? 0;
  const signal = signalSeries.at(-1) ?? 0;

  return {
    macd: round(line),
    signal: round(signal),
    histogram: round(line - signal),
  };
}

export function atr(candles: Candle[], period = 14): number | null {
  const recent = candles.slice(-period - 1);
  if (recent.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const current = recent[i];
    const previous = recent[i - 1];
    if (!current || !previous) continue;
    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  return round(average(trs));
}

export function supportResistance(candles: Candle[]): SupportResistanceSnapshot {
  const recent = candles.slice(-80);
  if (recent.length === 0) {
    return {
      nearestSupport: null,
      nearestResistance: null,
      swingHigh: 0,
      swingLow: 0,
      supportLevels: [],
      resistanceLevels: [],
    };
  }

  const current = recent.at(-1)?.close ?? 0;
  const atrValue = atr(recent, 14);
  const baseClusterSize =
    atrValue === null ? current * 0.00035 : atrValue * 0.25;
  const clusterSize = Math.min(Math.max(baseClusterSize, 0.5), 12);
  const swingWindow = recent.slice(-12);
  const swingHigh = Math.max(...swingWindow.map((candle) => candle.high));
  const swingLow = Math.min(...swingWindow.map((candle) => candle.low));
  const supportLevels = clusterLevels(
    recent.map((candle) => candle.low),
    clusterSize,
    "support",
    current,
  );
  const resistanceLevels = clusterLevels(
    recent.map((candle) => candle.high),
    clusterSize,
    "resistance",
    current,
  );

  return {
    nearestSupport: supportLevels[0]?.price ?? null,
    nearestResistance: resistanceLevels[0]?.price ?? null,
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
    supportLevels,
    resistanceLevels,
  };
}

export function trend(values: number[]): IndicatorTrend {
  const short = ema(values, 20);
  const medium = ema(values, 50);
  const long = ema(values, 200);
  if (short === null || medium === null || long === null) {
    return "INSUFFICIENT_DATA";
  }
  if (short > medium && medium > long) return "UPTREND";
  if (short < medium && medium < long) return "DOWNTREND";
  return "SIDEWAY_OR_MIXED";
}

export function structureTrend(
  candles: Candle[],
  window = 20,
): IndicatorTrend {
  const recent = candles.slice(-window);
  if (recent.length < 8) return "INSUFFICIENT_DATA";

  const half = Math.floor(recent.length / 2);
  const older = recent.slice(0, half);
  const newer = recent.slice(half);
  if (older.length === 0 || newer.length === 0) return "INSUFFICIENT_DATA";

  const olderHigh = Math.max(...older.map((candle) => candle.high));
  const olderLow = Math.min(...older.map((candle) => candle.low));
  const newerHigh = Math.max(...newer.map((candle) => candle.high));
  const newerLow = Math.min(...newer.map((candle) => candle.low));

  const higherHigh = newerHigh > olderHigh;
  const higherLow = newerLow > olderLow;
  const lowerHigh = newerHigh < olderHigh;
  const lowerLow = newerLow < olderLow;

  if (higherHigh && higherLow) return "UPTREND";
  if (lowerHigh && lowerLow) return "DOWNTREND";
  return "SIDEWAY_OR_MIXED";
}

export function indicatorReadiness(values: number[], candles: Candle[]): IndicatorReadiness {
  const clean = values.filter(Number.isFinite);
  return {
    ema20: clean.length >= 20,
    ema50: clean.length >= 50,
    ema200: clean.length >= 200,
    rsi14: clean.length > 14,
    atr14: candles.length >= 15,
    macd: clean.length >= 35,
  };
}

export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function clusterLevels(
  prices: number[],
  clusterSize: number,
  mode: "support" | "resistance",
  current: number,
): SupportResistanceLevel[] {
  const sorted = prices.filter(Number.isFinite).sort((a, b) => a - b);
  const clusters: number[][] = [];

  for (const price of sorted) {
    const cluster = clusters.at(-1);
    const center = cluster ? average(cluster) : price;
    if (cluster && Math.abs(price - center) <= clusterSize) {
      cluster.push(price);
    } else {
      clusters.push([price]);
    }
  }

  return clusters
    .map((cluster) => ({
      price: round(average(cluster)),
      touches: cluster.length,
      strength: strengthLabel(cluster.length),
    }))
    .filter((level) => level.touches >= 2)
    .filter((level) =>
      mode === "support" ? level.price <= current : level.price >= current,
    )
    .sort((left, right) =>
      mode === "support" ? right.price - left.price : left.price - right.price,
    )
    .slice(0, 5);
}

function strengthLabel(touches: number): SupportResistanceLevel["strength"] {
  if (touches >= 6) return "STRONG";
  if (touches >= 3) return "MEDIUM";
  return "WEAK";
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
