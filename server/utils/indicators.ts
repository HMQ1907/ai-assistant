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
  let gains = 0;
  let losses = 0;
  const slice = values.slice(-period - 1);
  for (let i = 1; i < slice.length; i += 1) {
    const diff = (slice[i] ?? 0) - (slice[i - 1] ?? 0);
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  return round(100 - 100 / (1 + gains / losses), 2);
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
  const lows = recent.map((candle) => candle.low);
  const highs = recent.map((candle) => candle.high);
  return {
    support: round(Math.min(...lows)),
    resistance: round(Math.max(...highs)),
    swingHigh: round(Math.max(...highs.slice(-12))),
    swingLow: round(Math.min(...lows.slice(-12))),
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
