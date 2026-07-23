import type { Candle } from "../../types/trading";
import { adx, atr, rsi } from "../utils/indicators";

/**
 * EURUSD session scalp: mean-reversion M5 trong phiên Á + giữa phiên Mỹ.
 *
 * Logic:
 *  1. H1 bias: EMA50 — chỉ xác định thị trường không trend quá mạnh (ADX < 30).
 *  2. M15 RSI + Bollinger bandwidth — xác nhận range/mean-revert.
 *  3. M5 trigger: RSI extreme + nến đảo chiều + giá chạm band ngoài.
 *  4. SL: swing M5 gần nhất + buffer ATR. TP: 1.5R hoặc kênh giữa (EMA20).
 */

export interface EurusdScalpSignal {
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
}

export interface EurusdScalpConfig {
  bbPeriod: number;
  bbStdDev: number;
  rsiPeriod: number;
  rsiBuyMax: number;
  rsiSellMin: number;
  atrPeriod: number;
  slAtrMult: number;
  tpRMultiple: number;
  maxAdx: number;
}

export const defaultEurusdScalpConfig: EurusdScalpConfig = {
  bbPeriod: 20,
  bbStdDev: 2,
  rsiPeriod: 14,
  rsiBuyMax: 35,
  rsiSellMin: 65,
  atrPeriod: 14,
  slAtrMult: 0.8,
  tpRMultiple: 1.2,
  maxAdx: 30,
};

export function evaluateEurusdScalpSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  config: EurusdScalpConfig = defaultEurusdScalpConfig,
): EurusdScalpSignal | null {
  if (m5.length < 80 || m15.length < 60 || h1.length < 60) return null;

  const h1Closes = h1.map((c) => c.close);
  const h1Adx = adxSimple(h1);
  if (h1Adx !== null && h1Adx > config.maxAdx) return null;

  const m5Closes = m5.map((c) => c.close);
  const m5Rsi = rsi(m5Closes, config.rsiPeriod);
  const m5Atr = atr(m5, config.atrPeriod);
  const m5Bb = bollingerBands(m5Closes, config.bbPeriod, config.bbStdDev);
  if (m5Rsi === null || m5Atr === null || m5Atr <= 0 || m5Bb === null) return null;

  const lastM5 = m5.at(-1);
  const prevM5 = m5.at(-2);
  if (!lastM5 || !prevM5) return null;

  const m15Closes = m15.map((c) => c.close);
  const m15Rsi = rsi(m15Closes, config.rsiPeriod);
  if (m15Rsi === null) return null;

  const bbTolerance = 0.3 * m5Atr;

  const meanRevBuy =
    m5Rsi <= config.rsiBuyMax &&
    lastM5.low <= m5Bb.lower + bbTolerance &&
    lastM5.close > lastM5.open &&
    m15Rsi < 50;

  const meanRevSell =
    m5Rsi >= config.rsiSellMin &&
    lastM5.high >= m5Bb.upper - bbTolerance &&
    lastM5.close < lastM5.open &&
    m15Rsi > 50;

  const prev2M5 = m5.at(-3);
  const microBreakoutBuy =
    prev2M5 != null &&
    lastM5.close > lastM5.open &&
    lastM5.close > prevM5.high &&
    prevM5.close < prevM5.open &&
    prev2M5.close < prev2M5.open &&
    m5Rsi > 45 && m5Rsi < 65 &&
    m15Rsi < 55;

  const microBreakoutSell =
    prev2M5 != null &&
    lastM5.close < lastM5.open &&
    lastM5.close < prevM5.low &&
    prevM5.close > prevM5.open &&
    prev2M5.close > prev2M5.open &&
    m5Rsi > 35 && m5Rsi < 55 &&
    m15Rsi > 45;

  const isBuy = meanRevBuy || microBreakoutBuy;
  const isSell = meanRevSell || microBreakoutSell;
  if (!isBuy && !isSell) return null;
  const isMicroBreakout = !meanRevBuy && !meanRevSell;
  const direction: "BUY" | "SELL" = isBuy ? "BUY" : "SELL";

  const entry = lastM5.close;
  const recentSwing = m5.slice(-10);
  const swingLow = Math.min(...recentSwing.map((c) => c.low));
  const swingHigh = Math.max(...recentSwing.map((c) => c.high));

  const stopLoss =
    direction === "BUY"
      ? Math.min(swingLow - config.slAtrMult * m5Atr, entry - 1.5 * m5Atr)
      : Math.max(swingHigh + config.slAtrMult * m5Atr, entry + 1.5 * m5Atr);

  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  if (risk < 0.3 * m5Atr) return null;

  const takeProfit =
    direction === "BUY"
      ? entry + config.tpRMultiple * risk
      : entry - config.tpRMultiple * risk;

  return {
    direction,
    entry: roundPrice(entry),
    stopLoss: roundPrice(stopLoss),
    takeProfit: roundPrice(takeProfit),
    reason: `EURUSD scalp${isMicroBreakout ? " (breakout)" : ""}: M5 RSI ${m5Rsi}, M15 RSI ${m15Rsi}, H1 ADX ${h1Adx ?? "n/a"}, TP ${config.tpRMultiple}R`,
  };
}

export function explainEurusdScalpRejection(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  config: EurusdScalpConfig = defaultEurusdScalpConfig,
): string {
  if (m5.length < 80) return `M5 candles ${m5.length} < 80`;
  if (m15.length < 60) return `M15 candles ${m15.length} < 60`;
  if (h1.length < 60) return `H1 candles ${h1.length} < 60`;

  const h1Adx = adxSimple(h1);
  if (h1Adx !== null && h1Adx > config.maxAdx) return `H1 ADX ${h1Adx} > ${config.maxAdx} — trend quá mạnh cho mean-reversion`;

  const m5Closes = m5.map((c) => c.close);
  const m5Rsi = rsi(m5Closes, config.rsiPeriod);
  const m5Bb = bollingerBands(m5Closes, config.bbPeriod, config.bbStdDev);
  if (m5Rsi === null || m5Bb === null) return "M5 RSI/BB unavailable";

  return `M5 RSI ${m5Rsi} chưa đạt vùng cực trị (cần ≤${config.rsiBuyMax} hoặc ≥${config.rsiSellMin}), BB chưa chạm band ngoài`;
}

function bollingerBands(
  values: number[],
  period: number,
  stdDev: number,
): { upper: number; middle: number; lower: number } | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper: mean + stdDev * sd,
    middle: mean,
    lower: mean - stdDev * sd,
  };
}

function adxSimple(candles: Candle[]): number | null {
  return adx(candles, 14);
}

function roundPrice(value: number): number {
  return Number(value.toFixed(5));
}
