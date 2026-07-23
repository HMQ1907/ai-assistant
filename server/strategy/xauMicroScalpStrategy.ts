import type { Candle } from "../../types/trading";
import { atr, ema, rsi } from "../utils/indicators";

/**
 * Micro-scalp M1 cho acc nhỏ (XAU hoặc EURUSD).
 * Mặc định SL = TP = 5 đơn vị (RR 1:1). Setup đẹp → TP > SL (1.5R).
 * Bias H1 EMA50 + M15 cùng hướng EMA50 + trigger nến M1 xác nhận.
 *
 * Đơn vị:
 * - XAUUSD: điểm giá (5.0 = $5 với lot 0.01)
 * - EURUSD: giá tuyệt đối theo pip 0.0001 (5 pip = 0.0005)
 */
export interface XauMicroScalpConfig {
  symbolLabel: "XAUUSD" | "EURUSD";
  priceDigits: number;
  slPoints: number;
  tpPoints: number;
  /** TP khi setup đẹp (RR > 1). */
  strongTpPoints: number;
  minRr: number;
  strongBodyRatio: number;
  strongBuyRsiMax: number;
  strongSellRsiMin: number;
  rsiPeriod: number;
  buyRsiMax: number;
  sellRsiMin: number;
  minBodyRatio: number;
  maxTriggerRange: number;
  maxEntryAtr: number;
}

/** Vàng: SL/TP = 5 điểm. */
export const defaultXauMicroScalpConfig: XauMicroScalpConfig = {
  symbolLabel: "XAUUSD",
  priceDigits: 3,
  slPoints: 5.0,
  tpPoints: 5.0,
  strongTpPoints: 7.5,
  minRr: 1.0,
  strongBodyRatio: 0.45,
  strongBuyRsiMax: 40,
  strongSellRsiMin: 60,
  rsiPeriod: 14,
  buyRsiMax: 48,
  sellRsiMin: 52,
  minBodyRatio: 0.35,
  maxTriggerRange: 4.0,
  maxEntryAtr: 6,
};

/** EURUSD: SL/TP = 5 pip (0.0005). Lot khuyến nghị 0.05 trên acc ~$100. */
export const defaultEurUsdMicroScalpConfig: XauMicroScalpConfig = {
  symbolLabel: "EURUSD",
  priceDigits: 5,
  slPoints: 0.0005,
  tpPoints: 0.0005,
  strongTpPoints: 0.00075,
  minRr: 1.0,
  strongBodyRatio: 0.45,
  strongBuyRsiMax: 40,
  strongSellRsiMin: 60,
  rsiPeriod: 14,
  buyRsiMax: 48,
  sellRsiMin: 52,
  minBodyRatio: 0.35,
  maxTriggerRange: 0.0004,
  maxEntryAtr: 0.0008,
};

export function microScalpConfigForSymbol(
  symbol: string | null | undefined,
): XauMicroScalpConfig {
  const normalized = String(symbol || "").toUpperCase();
  if (normalized.startsWith("EURUSD")) return defaultEurUsdMicroScalpConfig;
  return defaultXauMicroScalpConfig;
}

export interface XauMicroScalpSignal {
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
  strategyKind: "MOMENTUM_SCALP";
}

export function evaluateXauMicroScalpSignal(
  m1: Candle[],
  m15: Candle[],
  h1: Candle[] = [],
  config: XauMicroScalpConfig = defaultXauMicroScalpConfig,
): XauMicroScalpSignal | null {
  return buildXauMicroScalpSignal(m1, m15, h1, config).signal;
}

export function explainXauMicroScalpRejection(
  m1: Candle[],
  m15: Candle[],
  h1: Candle[] = [],
  config: XauMicroScalpConfig = defaultXauMicroScalpConfig,
): string {
  return buildXauMicroScalpSignal(m1, m15, h1, config).reason;
}

/** SL=TP mặc định; setup đẹp → TP > SL. */
export function resolveScalpTpSl(
  strongSetup: boolean,
  config: XauMicroScalpConfig = defaultXauMicroScalpConfig,
): { tpPoints: number; slPoints: number; rr: number; strongSetup: boolean } {
  const slPoints = config.slPoints;
  const tpPoints = strongSetup ? config.strongTpPoints : config.tpPoints;
  const rr = slPoints > 0 ? tpPoints / slPoints : 0;
  return {
    tpPoints: roundPrice(tpPoints, config.priceDigits),
    slPoints: roundPrice(slPoints, config.priceDigits),
    rr: roundPrice(rr, 3),
    strongSetup,
  };
}

function buildXauMicroScalpSignal(
  m1: Candle[],
  m15: Candle[],
  h1: Candle[],
  config: XauMicroScalpConfig,
): { signal: XauMicroScalpSignal | null; reason: string } {
  if (m1.length < 40) {
    return { signal: null, reason: `micro-scalp M1 candles ${m1.length} < 40` };
  }
  if (m15.length < 60) {
    return { signal: null, reason: `micro-scalp M15 candles ${m15.length} < 60` };
  }
  if (h1.length < 60) {
    return { signal: null, reason: `micro-scalp H1 candles ${h1.length} < 60` };
  }

  const h1Closes = h1.map((c) => c.close);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Last = h1.at(-1);
  if (!h1Last || h1Ema50 === null) {
    return { signal: null, reason: "micro-scalp H1 EMA unavailable" };
  }
  const h1BuyBias = h1Last.close >= h1Ema50;
  const h1SellBias = h1Last.close <= h1Ema50;

  const m15Closes = m15.map((c) => c.close);
  const m15Ema50 = ema(m15Closes, 50);
  const m15Last = m15.at(-1);
  if (!m15Last || m15Ema50 === null) {
    return { signal: null, reason: "micro-scalp M15 EMA unavailable" };
  }
  const m15BuyAlign = m15Last.close >= m15Ema50;
  const m15SellAlign = m15Last.close <= m15Ema50;
  if (h1BuyBias && !m15BuyAlign) {
    return {
      signal: null,
      reason: `micro-scalp blocked: H1 BUY bias but M15 ${fmt(m15Last.close, config)} < EMA50 ${fmt(m15Ema50, config)}`,
    };
  }
  if (h1SellBias && !m15SellAlign) {
    return {
      signal: null,
      reason: `micro-scalp blocked: H1 SELL bias but M15 ${fmt(m15Last.close, config)} > EMA50 ${fmt(m15Ema50, config)}`,
    };
  }

  const m1Closes = m1.map((c) => c.close);
  const m1Rsi = rsi(m1Closes, config.rsiPeriod);
  const m1Atr = atr(m1, 14);
  const prev = m1.at(-2);
  const last = m1.at(-1);
  if (!prev || !last || m1Rsi === null || m1Atr === null || m1Atr <= 0) {
    return { signal: null, reason: "micro-scalp M1 indicators unavailable" };
  }
  if (m1Atr > config.maxEntryAtr) {
    return {
      signal: null,
      reason: `micro-scalp blocked: M1 ATR ${fmt(m1Atr, config)} > ${fmt(config.maxEntryAtr, config)} (quá biến động cho SL/TP ${fmt(config.slPoints, config)})`,
    };
  }

  const range = last.high - last.low;
  if (range <= 0) {
    return { signal: null, reason: "micro-scalp blocked: flat M1 candle" };
  }
  if (range > config.maxTriggerRange) {
    return {
      signal: null,
      reason: `micro-scalp blocked: M1 range ${fmt(range, config)} > ${fmt(config.maxTriggerRange, config)} (đuổi nến lớn)`,
    };
  }

  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;
  const bullish =
    last.close > last.open &&
    bodyRatio >= config.minBodyRatio &&
    last.close >= last.low + range * 0.55;
  const bearish =
    last.close < last.open &&
    bodyRatio >= config.minBodyRatio &&
    last.close <= last.low + range * 0.45;

  const buySweep = hasRecentSweep(m1, "BUY", 8);
  const sellSweep = hasRecentSweep(m1, "SELL", 8);
  const buyContext =
    h1BuyBias &&
    m15BuyAlign &&
    m1Rsi <= config.buyRsiMax &&
    (buySweep ||
      (prev.close < prev.open && last.close > prev.open) ||
      last.low < prev.low);
  const sellContext =
    h1SellBias &&
    m15SellAlign &&
    m1Rsi >= config.sellRsiMin &&
    (sellSweep ||
      (prev.close > prev.open && last.close < prev.open) ||
      last.high > prev.high);

  const direction: "BUY" | "SELL" | null =
    bullish && buyContext ? "BUY" : bearish && sellContext ? "SELL" : null;

  if (direction === null) {
    const biasNote = h1BuyBias
      ? `H1+M15>=EMA50 (BUY bias), M15 ${fmt(m15Last.close, config)}`
      : `H1+M15<=EMA50 (SELL bias), M15 ${fmt(m15Last.close, config)}`;
    return {
      signal: null,
      reason:
        `micro-scalp blocked: need H1+M15-aligned M1 confirm + RSI ` +
        `(${biasNote}, RSI ${m1Rsi.toFixed(1)}, body ${bodyRatio.toFixed(2)}, bull=${bullish}, bear=${bearish})`,
    };
  }

  const strongSetup =
    direction === "BUY"
      ? (buySweep && bodyRatio >= config.strongBodyRatio) ||
        m1Rsi <= config.strongBuyRsiMax
      : (sellSweep && bodyRatio >= config.strongBodyRatio) ||
        m1Rsi >= config.strongSellRsiMin;

  const { tpPoints, slPoints, rr } = resolveScalpTpSl(strongSetup, config);
  if (rr + 1e-4 < config.minRr) {
    return {
      signal: null,
      reason: `micro-scalp blocked: RR ${rr.toFixed(2)} < ${config.minRr}`,
    };
  }

  const entry = last.close;
  const stopLoss =
    direction === "BUY" ? entry - slPoints : entry + slPoints;
  const takeProfit =
    direction === "BUY" ? entry + tpPoints : entry - tpPoints;

  return {
    signal: {
      direction,
      entry: roundPrice(entry, config.priceDigits),
      stopLoss: roundPrice(stopLoss, config.priceDigits),
      takeProfit: roundPrice(takeProfit, config.priceDigits),
      reason:
        `${config.symbolLabel} MICRO_SCALP M1: H1+M15 ${direction === "BUY" ? "above" : "below"} EMA50 + M1 ${direction} confirm` +
        `${strongSetup ? " (strong)" : ""}, RSI ${m1Rsi.toFixed(1)}, ` +
        `TP ${fmt(tpPoints, config)} / SL ${fmt(slPoints, config)} (RR ${rr.toFixed(2)})`,
      strategyKind: "MOMENTUM_SCALP",
    },
    reason: "micro-scalp signal found",
  };
}

function hasRecentSweep(
  candles: Candle[],
  direction: "BUY" | "SELL",
  lookback: number,
): boolean {
  const last = candles.at(-1);
  if (!last || candles.length < lookback + 2) return false;
  const previous = candles.slice(-lookback - 1, -1);
  if (direction === "BUY") {
    const previousLow = Math.min(...previous.map((c) => c.low));
    return last.low <= previousLow && last.close > previousLow && last.close > last.open;
  }
  const previousHigh = Math.max(...previous.map((c) => c.high));
  return last.high >= previousHigh && last.close < previousHigh && last.close < last.open;
}

function roundPrice(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value: number, config: XauMicroScalpConfig): string {
  return value.toFixed(config.priceDigits);
}
