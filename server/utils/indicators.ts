import type {
  Candle,
  SupportResistanceLevel,
  SupportResistanceSnapshot,
} from "../../types/trading";

export function ema(values: number[], period: number): number {
  return round(lastOrZero(emaSeries(values, period)));
}

export function emaSeries(values: number[], period: number): number[] {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return [];
  if (clean.length < period) return [clean.at(-1) ?? 0];

  const seed = average(clean.slice(0, period));
  const series: number[] = [seed];
  const k = 2 / (period + 1);

  for (const value of clean.slice(period)) {
    const previous = series.at(-1) ?? seed;
    series.push(value * k + previous * (1 - k));
  }

  return series;
}

export function rsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;

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
  macd: number;
  signal: number;
  histogram: number;
} {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 35) return { macd: 0, signal: 0, histogram: 0 };

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

export function atr(candles: Candle[], period = 14): number {
  const recent = candles.slice(-period - 1);
  if (recent.length < 2) return 0;
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
      nearestSupport: 0,
      nearestResistance: 0,
      swingHigh: 0,
      swingLow: 0,
      supportLevels: [],
      resistanceLevels: [],
    };
  }

  const current = recent.at(-1)?.close ?? 0;
  const atrValue = atr(recent, 14);
  const clusterSize = Math.max(atrValue * 0.25, current * 0.00035, 0.5);
  const swingWindow = recent.slice(-12);
  const swingHigh = Math.max(...swingWindow.map((candle) => candle.high));
  const swingLow = Math.min(...swingWindow.map((candle) => candle.low));
  const supportLevels = clusterLevels(
    recent.map((candle) => candle.low),
    clusterSize,
    "support",
  );
  const resistanceLevels = clusterLevels(
    recent.map((candle) => candle.high),
    clusterSize,
    "resistance",
  );

  return {
    nearestSupport:
      supportLevels.find((level) => level.price <= current)?.price ??
      round(Math.min(...recent.map((candle) => candle.low))),
    nearestResistance:
      resistanceLevels.find((level) => level.price >= current)?.price ??
      round(Math.max(...recent.map((candle) => candle.high))),
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
    supportLevels,
    resistanceLevels,
  };
}

export function trend(values: number[]): string {
  const short = ema(values, 20);
  const medium = ema(values, 50);
  const long = ema(values, 200);
  if (short > medium && medium > long) return "UPTREND";
  if (short < medium && medium < long) return "DOWNTREND";
  return "SIDEWAY_OR_MIXED";
}

export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function clusterLevels(
  prices: number[],
  clusterSize: number,
  mode: "support" | "resistance",
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

function lastOrZero(values: number[]): number {
  return values.at(-1) ?? 0;
}
