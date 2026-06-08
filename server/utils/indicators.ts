import type { Candle } from "../../types/trading";

export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let current = values[0] ?? 0;
  for (const value of values.slice(1)) current = value * k + current * (1 - k);
  return round(current);
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
  const diffs: number[] = [];
  for (let i = 35; i <= values.length; i += 1) {
    const subset = values.slice(0, i);
    diffs.push(ema(subset, 12) - ema(subset, 26));
  }
  const line = diffs.at(-1) ?? 0;
  const signal = ema(diffs, 9);
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
  return round(
    trs.reduce((sum, value) => sum + value, 0) / Math.max(trs.length, 1),
  );
}

export function supportResistance(candles: Candle[]): {
  support: number;
  resistance: number;
  swingHigh: number;
  swingLow: number;
} {
  const recent = candles.slice(-40);
  if (recent.length === 0) {
    return {
      support: 0,
      resistance: 0,
      swingHigh: 0,
      swingLow: 0,
    };
  }
  const lows = recent.map((candle) => candle.low);
  const highs = recent.map((candle) => candle.high);
  const swingWindow = recent.slice(-12);
  const swingLows = swingWindow.map((candle) => candle.low);
  const swingHighs = swingWindow.map((candle) => candle.high);
  return {
    support: round(Math.min(...lows)),
    resistance: round(Math.max(...highs)),
    swingHigh: round(Math.max(...swingHighs)),
    swingLow: round(Math.min(...swingLows)),
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
  return Number(value.toFixed(digits));
}
