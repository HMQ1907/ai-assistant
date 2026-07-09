import type { Candle } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { adx, atr, ema, rsi, structureTrend, trend } from "../utils/indicators";

/**
 * Rules engine TẤT ĐỊNH cho method 5 bước (không AI):
 *   1. BIAS: xu hướng H4 (EMA alignment hoặc Dow HH/HL).
 *   2. TRIGGER: trên H1, giá hồi về vùng EMA nhanh (pullback) thuận bias.
 *   3. XÁC NHẬN: nến H1 quay lại theo hướng bias (phá đỉnh/đáy nến trước, hoặc engulfing).
 *   4. SL: ngoài swing gần nhất + đệm ATR(H1).
 *   5. TP: theo cấu trúc nến gần nhất cùng hướng trade; RR chỉ là bộ lọc tối thiểu sau cùng.
 * Filter phụ (bật/tắt được, để backtest đo đóng góp): RSI, Dow bias, engulfing.
 */
export type BiasMode = "EMA" | "STRUCTURE";
export type ConfirmMode = "BREAK" | "ENGULFING";

export interface RuleStrategyConfig {
  emaFast: number;
  emaSlow: number;
  atrPeriod: number;
  atrBufferMult: number;
  // RR tối thiểu để ĐƯỢC PHÉP trade sau khi SL/TP đã được lấy theo cấu trúc.
  // Không dùng để kéo TP ra xa một cách máy móc.
  rrTarget: number;
  pullbackLookback: number;
  swingLookback: number;
  targetLookback: number;
  pullbackTouchTolerancePct: number;
  biasMode: BiasMode;
  confirmMode: ConfirmMode;
  requireBreakOfPreviousCandle: boolean;
  useRsiFilter: boolean;
  rsiMaxForBuy: number; // BUY chỉ khi RSI(H1) < ngưỡng (còn dư địa, đã thực sự hồi)
  rsiMinForSell: number; // SELL chỉ khi RSI(H1) > ngưỡng
}

export const defaultRuleStrategyConfig: RuleStrategyConfig = {
  emaFast: 20,
  emaSlow: 50,
  atrPeriod: 14,
  atrBufferMult: tradingRules.minStopLossAtrMultiple,
  rrTarget: tradingRules.minRiskReward,
  pullbackLookback: 5,
  swingLookback: 6,
  targetLookback: 80,
  pullbackTouchTolerancePct: 0.0015,
  biasMode: "EMA",
  confirmMode: "BREAK",
  requireBreakOfPreviousCandle: false,
  useRsiFilter: false,
  rsiMaxForBuy: 65,
  rsiMinForSell: 35,
};

export interface RuleSignal {
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
  strategyKind?: "SETUP" | "MOMENTUM_SCALP";
}

export interface XauTrendPullbackSetup {
  direction: "BUY" | "SELL";
  m15CandleTime: string;
  mode: "NORMAL" | "EARLY_TREND";
  kind: "TREND_PULLBACK" | "BREAKOUT_CONTINUATION";
  reason: string;
}

export function evaluateXauTrendPullbackSetup(
  m15: Candle[],
  h1: Candle[],
  m5?: Candle[],
): XauTrendPullbackSetup | null {
  return buildXauTrendPullbackSetup(m15, h1, m5).setup;
}

export function explainXauTrendPullbackSetupRejection(
  m15: Candle[],
  h1: Candle[],
  m5?: Candle[],
): string | null {
  return buildXauTrendPullbackSetup(m15, h1, m5).reason;
}

export function evaluateXauTrendPullbackTriggerSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  setup: XauTrendPullbackSetup,
): RuleSignal | null {
  const signal = evaluateXauTrendPullbackSignal(m5, m15, h1);
  return signal?.direction === setup.direction ? signal : null;
}

export function explainXauPendingSetupInvalidation(
  setup: XauTrendPullbackSetup,
  m15: Candle[],
  h1: Candle[],
): string | null {
  const h1Adx = adx(h1, 14);
  if (h1Adx !== null && h1Adx <= 15) {
    return `ADX H1 dropped to ${h1Adx} <= 15`;
  }

  const m15Closes = m15.map((candle) => candle.close);
  const m15Ema200 = ema(m15Closes, 200);
  const m15Last = m15.at(-1);
  if (!m15Last || m15Ema200 === null) return null;
  if (setup.direction === "BUY" && m15Last.close < m15Ema200) {
    return `M15 close ${m15Last.close} broke below EMA200 ${m15Ema200}`;
  }
  if (setup.direction === "SELL" && m15Last.close > m15Ema200) {
    return `M15 close ${m15Last.close} broke above EMA200 ${m15Ema200}`;
  }
  return null;
}

function buildXauTrendPullbackSetup(
  m15: Candle[],
  h1: Candle[],
  m5?: Candle[],
): { setup: XauTrendPullbackSetup | null; reason: string | null } {
  if (h1.length < 220) return { setup: null, reason: `H1 candles ${h1.length} < 220` };
  if (m15.length < 220) return { setup: null, reason: `M15 candles ${m15.length} < 220` };

  const h1Closes = h1.map((candle) => candle.close);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Ema200 = ema(h1Closes, 200);
  const h1Adx = adx(h1, 14);
  const h1Last = h1.at(-1);
  if (!h1Last || h1Ema50 === null || h1Ema200 === null || h1Adx === null) {
    return { setup: null, reason: "H1 EMA50/EMA200/ADX unavailable" };
  }
  if (h1Adx <= 15) return { setup: null, reason: `H1 ADX ${h1Adx} <= 15` };
  const setupMode = h1Adx <= 18 ? "EARLY_TREND" : "NORMAL";

  const h1Bias = resolveXauH1Direction(h1Last.close, h1Ema50, h1Ema200);
  if (h1Bias === null) {
    return {
      setup: null,
      reason: `H1 filter blocked: EMA50 ${h1Ema50} vs EMA200 ${h1Ema200}, close ${h1Last.close}`,
    };
  }
  const { direction, kind } = h1Bias;

  const m15Closes = m15.map((candle) => candle.close);
  const m15Ema21 = ema(m15Closes, 21);
  const m15Ema50 = ema(m15Closes, 50);
  const m15Ema200 = ema(m15Closes, 200);
  const m15Atr = atr(m15, 14);
  const m15Rsi = rsi(m15Closes, 14);
  const m15Last = m15.at(-1);
  if (
    !m15Last ||
    m15Ema21 === null ||
    m15Ema50 === null ||
    m15Ema200 === null ||
    m15Atr === null ||
    m15Atr <= 0 ||
    m15Rsi === null
  ) {
    return { setup: null, reason: "M15 EMA/ATR/RSI unavailable" };
  }

  const pullbackTolerance = 0.5 * m15Atr;
  const touchedPullbackZone = hasRecentM15PullbackTouch(
    m15,
    direction,
    m15Ema21,
    m15Ema50,
    pullbackTolerance,
  );
  const m15Continuation = isStrongContinuationCandle(m15Last, direction);
  const m5VeryStrong = hasVeryStrongM5Trigger(m5, direction);
  if (
    !touchedPullbackZone &&
    !(kind === "BREAKOUT_CONTINUATION" && m15Continuation) &&
    !m5VeryStrong
  ) {
    return {
      setup: null,
      reason: "M15 setup blocked: no recent EMA21-EMA50 pullback, no continuation candle, and no very-strong M5 trigger",
    };
  }

  if (direction === "BUY") {
    if (m15Rsi < 38 || m15Rsi > 60) {
      return { setup: null, reason: `M15 BUY RSI ${m15Rsi} outside 38-60` };
    }
    if (m15Ema21 <= m15Ema200 && m15Last.close <= m15Ema200) {
      return { setup: null, reason: "M15 BUY structure broken: EMA21 <= EMA200 and close <= EMA200" };
    }
  } else {
    if (m15Rsi < 40 || m15Rsi > 62) {
      return { setup: null, reason: `M15 SELL RSI ${m15Rsi} outside 40-62` };
    }
    if (m15Ema21 >= m15Ema200 && m15Last.close >= m15Ema200) {
      return { setup: null, reason: "M15 SELL structure broken: EMA21 >= EMA200 and close >= EMA200" };
    }
  }

  return {
    setup: {
      direction,
      m15CandleTime: m15Last.time,
      mode: setupMode,
      kind,
      reason: `H1 ${direction} ${kind} + M15/M5 setup valid (${setupMode}), waiting up to 6 M5 candles for trigger`,
    },
    reason: null,
  };
}

export function evaluateXauTrendPullbackSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
): RuleSignal | null {
  return (
    buildXauTrendPullbackSignal(m5, m15, h1)?.signal ??
    buildXauMomentumScalpSignal(m5, m15, h1)?.signal ??
    null
  );
}

export function explainXauTrendPullbackRejection(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
): string | null {
  const setup = buildXauTrendPullbackSignal(m5, m15, h1);
  if (setup.signal) return setup.reason;
  const scalp = buildXauMomentumScalpSignal(m5, m15, h1);
  return scalp.signal ? scalp.reason : `${setup.reason}; scalp: ${scalp.reason}`;
}

function buildXauTrendPullbackSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
): { signal: RuleSignal | null; reason: string } {
  if (h1.length < 220) return { signal: null, reason: `H1 candles ${h1.length} < 220` };
  if (m15.length < 220) return { signal: null, reason: `M15 candles ${m15.length} < 220` };
  if (m5.length < 3) return { signal: null, reason: `M5 candles ${m5.length} < 3` };

  const h1Closes = h1.map((candle) => candle.close);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Ema200 = ema(h1Closes, 200);
  const h1Adx = adx(h1, 14);
  const h1Last = h1.at(-1);
  if (!h1Last || h1Ema50 === null || h1Ema200 === null || h1Adx === null) {
    return { signal: null, reason: "H1 EMA50/EMA200/ADX unavailable" };
  }
  if (h1Adx <= 15) return { signal: null, reason: `H1 ADX ${h1Adx} <= 15` };
  const setupMode = h1Adx <= 18 ? "EARLY_TREND" : "NORMAL";

  const h1Bias = resolveXauH1Direction(h1Last.close, h1Ema50, h1Ema200);
  if (h1Bias === null) {
    return {
      signal: null,
      reason: `H1 filter blocked: EMA50 ${h1Ema50} vs EMA200 ${h1Ema200}, close ${h1Last.close}`,
    };
  }
  const { direction, kind } = h1Bias;

  const m15Closes = m15.map((candle) => candle.close);
  const m15Ema21 = ema(m15Closes, 21);
  const m15Ema50 = ema(m15Closes, 50);
  const m15Ema200 = ema(m15Closes, 200);
  const m15Atr = atr(m15, 14);
  const m15Rsi = rsi(m15Closes, 14);
  const m15Last = m15.at(-1);
  if (
    !m15Last ||
    m15Ema21 === null ||
    m15Ema50 === null ||
    m15Ema200 === null ||
    m15Atr === null ||
    m15Atr <= 0 ||
    m15Rsi === null
  ) {
    return { signal: null, reason: "M15 EMA/ATR/RSI unavailable" };
  }

  const pullbackTolerance = 0.5 * m15Atr;
  const touchedPullbackZone = hasRecentM15PullbackTouch(
    m15,
    direction,
    m15Ema21,
    m15Ema50,
    pullbackTolerance,
  );
  const m15Continuation = isStrongContinuationCandle(m15Last, direction);
  const m5VeryStrong = hasVeryStrongM5Trigger(m5, direction);
  if (
    !touchedPullbackZone &&
    !(kind === "BREAKOUT_CONTINUATION" && m15Continuation) &&
    !m5VeryStrong
  ) {
    return {
      signal: null,
      reason: `M15 setup blocked: no recent EMA21-EMA50 pullback, no continuation candle, and no very-strong M5 trigger`,
    };
  }

  if (direction === "BUY") {
    if (m15Rsi < 38 || m15Rsi > 60) {
      return { signal: null, reason: `M15 BUY RSI ${m15Rsi} outside 38-60` };
    }
    if (m15Ema21 <= m15Ema200 && m15Last.close <= m15Ema200) {
      return { signal: null, reason: `M15 BUY structure broken: EMA21 <= EMA200 and close <= EMA200` };
    }
  } else {
    if (m15Rsi < 40 || m15Rsi > 62) {
      return { signal: null, reason: `M15 SELL RSI ${m15Rsi} outside 40-62` };
    }
    if (m15Ema21 >= m15Ema200 && m15Last.close >= m15Ema200) {
      return { signal: null, reason: `M15 SELL structure broken: EMA21 >= EMA200 and close >= EMA200` };
    }
  }

  const prevM5 = m5.at(-2);
  const lastM5 = m5.at(-1);
  if (!prevM5 || !lastM5) return { signal: null, reason: "M5 missing trigger candles" };
  const strongTrigger =
    direction === "BUY"
      ? isStrongBullishTrigger(lastM5) || isBullishMomentumBreak(prevM5, lastM5)
      : isStrongBearishTrigger(lastM5) || isBearishMomentumBreak(prevM5, lastM5);
  const trigger =
    direction === "BUY"
      ? isBullishEngulfing(prevM5, lastM5) ||
        isBullishPinBar(lastM5) ||
        strongTrigger
      : isBearishEngulfing(prevM5, lastM5) ||
        isBearishPinBar(lastM5) ||
        strongTrigger;
  if (!trigger) {
    return {
      signal: null,
      reason: `M5 ${direction} trigger blocked: no engulfing/pin bar/strong close/momentum break on closed candle`,
    };
  }
  if (setupMode === "EARLY_TREND" && !strongTrigger) {
    return {
      signal: null,
      reason: `M5 ${direction} early-trend trigger blocked: ADX ${h1Adx} requires strong-close candle`,
    };
  }

  const entry = lastM5.close;
  const rawStopLoss =
    direction === "BUY" ? entry - 1.5 * m15Atr : entry + 1.5 * m15Atr;
  const swingStop = findNearestM15SwingStop(m15, direction, entry);
  const stopLoss =
    swingStop === null
      ? rawStopLoss
      : direction === "BUY"
        ? Math.min(rawStopLoss, swingStop - 0.2 * m15Atr)
        : Math.max(rawStopLoss, swingStop + 0.2 * m15Atr);
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    return { signal: null, reason: `${direction} blocked: invalid SL/risk` };
  }

  const structuralTp = findNearestM15TargetSwing(m15, direction, entry);
  const fallbackTp = direction === "BUY" ? entry + 1.5 * risk : entry - 1.5 * risk;
  const wantedTp =
    structuralTp === null
      ? fallbackTp
      : direction === "BUY"
        ? structuralTp - 0.2 * m15Atr
        : structuralTp + 0.2 * m15Atr;
  const rawReward = direction === "BUY" ? wantedTp - entry : entry - wantedTp;
  const rawRr = rawReward / risk;
  const minRr = setupMode === "EARLY_TREND" || kind === "BREAKOUT_CONTINUATION" ? 1.5 : 1.3;
  if (!Number.isFinite(rawRr) || rawRr < minRr) {
    return {
      signal: null,
      reason: `${direction} blocked: structural RR ${Number(rawRr.toFixed(2))} < ${minRr}`,
    };
  }

  const takeProfit =
    rawRr > 2.5
      ? direction === "BUY"
        ? entry + 2.5 * risk
        : entry - 2.5 * risk
      : wantedTp;

  return {
    signal: {
      direction,
      entry: round(entry),
      stopLoss: round(stopLoss),
      takeProfit: round(takeProfit),
      reason: `XAUUSD Adaptive (${kind}/${setupMode}): H1 ADX ${h1Adx}, H1 filter ${direction}, M15 setup RSI ${m15Rsi}, M5 trigger, SL 1.5 ATR M15 adjusted by swing, TP structure/capped 2.5R`,
      strategyKind: "SETUP",
    },
    reason: "signal found",
  };
}

function buildXauMomentumScalpSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
): { signal: RuleSignal | null; reason: string } {
  if (h1.length < 220) return { signal: null, reason: `H1 candles ${h1.length} < 220` };
  if (m15.length < 60) return { signal: null, reason: `M15 candles ${m15.length} < 60` };
  if (m5.length < 8) return { signal: null, reason: `M5 candles ${m5.length} < 8` };

  const h1Closes = h1.map((candle) => candle.close);
  const h1Ema200 = ema(h1Closes, 200);
  const h1Adx = adx(h1, 14);
  const h1Last = h1.at(-1);
  if (!h1Last || h1Ema200 === null || h1Adx === null) {
    return { signal: null, reason: "scalp H1 EMA200/ADX unavailable" };
  }
  if (h1Adx <= 15) return { signal: null, reason: `scalp H1 ADX ${h1Adx} <= 15` };

  const m15Closes = m15.map((candle) => candle.close);
  const m15Atr = atr(m15, 14);
  const m15Rsi = rsi(m15Closes, 14);
  if (m15Atr === null || m15Atr <= 0 || m15Rsi === null) {
    return { signal: null, reason: "scalp M15 ATR/RSI unavailable" };
  }

  const prevM5 = m5.at(-2);
  const lastM5 = m5.at(-1);
  if (!prevM5 || !lastM5) return { signal: null, reason: "scalp missing M5 trigger candles" };

  const buyAllowed = h1Last.close > h1Ema200 && m15Rsi >= 60 && m15Rsi <= 78;
  const sellAllowed = h1Last.close < h1Ema200 && m15Rsi >= 22 && m15Rsi <= 40;
  const buyTrigger =
    isBullishMomentumBreak(prevM5, lastM5) ||
    isVeryStrongBullishTrigger(lastM5) ||
    isBullishScalpMomentumCandle(lastM5);
  const sellTrigger =
    isBearishMomentumBreak(prevM5, lastM5) ||
    isVeryStrongBearishTrigger(lastM5) ||
    isBearishScalpMomentumCandle(lastM5);

  const direction: "BUY" | "SELL" | null =
    buyAllowed && buyTrigger ? "BUY" : sellAllowed && sellTrigger ? "SELL" : null;
  if (direction === null) {
    return {
      signal: null,
      reason: `scalp blocked: H1/M15 momentum or M5 scalp candle not aligned (RSI ${m15Rsi}, close ${h1Last.close}, EMA200 ${h1Ema200})`,
    };
  }

  const entry = lastM5.close;
  const m5Swing = direction === "BUY"
    ? Math.min(...m5.slice(-6).map((candle) => candle.low))
    : Math.max(...m5.slice(-6).map((candle) => candle.high));
  const atrStop = direction === "BUY" ? entry - m15Atr : entry + m15Atr;
  const swingStop = direction === "BUY" ? m5Swing - 0.1 * m15Atr : m5Swing + 0.1 * m15Atr;
  const stopLoss = direction === "BUY" ? Math.min(atrStop, swingStop) : Math.max(atrStop, swingStop);
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    return { signal: null, reason: `scalp ${direction} blocked: invalid SL/risk` };
  }

  const takeProfit = direction === "BUY" ? entry + 1.5 * risk : entry - 1.5 * risk;
  return {
    signal: {
      direction,
      entry: round(entry),
      stopLoss: round(stopLoss),
      takeProfit: round(takeProfit),
      reason: `XAUUSD MOMENTUM_SCALP: H1 close ${direction === "BUY" ? "above" : "below"} EMA200, M15 RSI ${m15Rsi}, M5 momentum/scalp candle, TP 1.5R`,
      strategyKind: "MOMENTUM_SCALP",
    },
    reason: "scalp signal found",
  };
}

function oppositeTrend(left: ReturnType<typeof trend>, right: ReturnType<typeof trend>): boolean {
  return (
    (left === "UPTREND" && right === "DOWNTREND") ||
    (left === "DOWNTREND" && right === "UPTREND")
  );
}

function resolveXauH1Direction(
  close: number,
  ema50: number,
  ema200: number,
): {
  direction: "BUY" | "SELL";
  kind: XauTrendPullbackSetup["kind"];
} | null {
  if (ema50 > ema200 && close > ema200) {
    return { direction: "BUY", kind: "TREND_PULLBACK" };
  }
  if (ema50 < ema200 && close < ema200) {
    return { direction: "SELL", kind: "TREND_PULLBACK" };
  }
  if (ema50 > ema200 && close < ema200) {
    return { direction: "SELL", kind: "BREAKOUT_CONTINUATION" };
  }
  if (ema50 < ema200 && close > ema200) {
    return { direction: "BUY", kind: "BREAKOUT_CONTINUATION" };
  }
  return null;
}

function isStrongContinuationCandle(
  candle: Candle,
  direction: "BUY" | "SELL",
): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const bullishBody = candle.close - candle.open;
  const bearishBody = candle.open - candle.close;
  return direction === "BUY"
    ? bullishBody > 0 && bullishBody / range >= 0.45 && candle.close >= candle.low + range * 0.65
    : bearishBody > 0 && bearishBody / range >= 0.45 && candle.close <= candle.low + range * 0.35;
}

function hasRecentM15PullbackTouch(
  candles: Candle[],
  direction: "BUY" | "SELL",
  ema21: number,
  ema50: number,
  tolerance: number,
): boolean {
  const recent = candles.slice(-3);
  const lower = Math.min(ema21, ema50) - tolerance;
  const upper = Math.max(ema21, ema50) + tolerance;
  return recent.some((candle) =>
    direction === "BUY"
      ? candle.low <= upper && candle.low >= lower
      : candle.high >= lower && candle.high <= upper,
  );
}

function hasVeryStrongM5Trigger(
  candles: Candle[] | undefined,
  direction: "BUY" | "SELL",
): boolean {
  const last = candles?.at(-1);
  if (!last) return false;
  return direction === "BUY"
    ? isVeryStrongBullishTrigger(last)
    : isVeryStrongBearishTrigger(last);
}

function resolveBiasTrend(
  bias: Candle[],
  config: RuleStrategyConfig,
): {
  direction: ReturnType<typeof trend>;
  emaTrend: ReturnType<typeof trend>;
  structTrend: ReturnType<typeof structureTrend>;
  source: "EMA" | "STRUCTURE" | "NONE";
} {
  const emaTrendValue = trend(bias.map((candle) => candle.close));
  const structTrendValue = structureTrend(bias, 20);

  if (config.biasMode === "STRUCTURE") {
    return {
      direction: structTrendValue,
      emaTrend: emaTrendValue,
      structTrend: structTrendValue,
      source:
        structTrendValue === "UPTREND" || structTrendValue === "DOWNTREND"
          ? "STRUCTURE"
          : "NONE",
    };
  }

  if (emaTrendValue === "UPTREND" || emaTrendValue === "DOWNTREND") {
    return {
      direction: emaTrendValue,
      emaTrend: emaTrendValue,
      structTrend: structTrendValue,
      source: "EMA",
    };
  }

  if (structTrendValue === "UPTREND" || structTrendValue === "DOWNTREND") {
    return {
      direction: structTrendValue,
      emaTrend: emaTrendValue,
      structTrend: structTrendValue,
      source: "STRUCTURE",
    };
  }

  return {
    direction: emaTrendValue,
    emaTrend: emaTrendValue,
    structTrend: structTrendValue,
    source: "NONE",
  };
}

export function explainRuleSignalRejection(
  entry: Candle[],
  bias: Candle[],
  config: RuleStrategyConfig = defaultRuleStrategyConfig,
  intermediate?: Candle[],
): string | null {
  if (entry.length < 60) return `entry candles ${entry.length} < 60`;
  if (bias.length < 200) return `bias candles ${bias.length} < 200`;

  const biasState = resolveBiasTrend(bias, config);
  const biasDir = biasState.direction;
  if (biasDir !== "UPTREND" && biasDir !== "DOWNTREND") {
    return `H4 bias not clearly trending (EMA=${biasState.emaTrend}, structure=${biasState.structTrend})`;
  }

  if (intermediate && intermediate.length >= config.emaSlow) {
    const ic = intermediate.map((candle) => candle.close);
    const ief = ema(ic, config.emaFast);
    const ies = ema(ic, config.emaSlow);
    if (ief === null || ies === null) return "intermediate EMA unavailable";
    const aligned = biasDir === "UPTREND" ? ief > ies : ief < ies;
    if (!aligned) {
      return `intermediate trend not aligned with H4 (${round(ief)} vs ${round(ies)})`;
    }
  }

  const closes = entry.map((candle) => candle.close);
  const emaFast = ema(closes, config.emaFast);
  const emaSlow = ema(closes, config.emaSlow);
  const atrV = atr(entry, config.atrPeriod);
  if (emaFast === null) return `EMA${config.emaFast} unavailable`;
  if (emaSlow === null) return `EMA${config.emaSlow} unavailable`;
  if (atrV === null || atrV <= 0) return `ATR${config.atrPeriod} unavailable`;

  const rsiV = config.useRsiFilter ? rsi(closes) : null;
  if (config.useRsiFilter && rsiV === null) return "RSI unavailable";

  const last = entry.at(-1);
  const prev = entry.at(-2);
  if (!last || !prev) return "missing latest/previous candle";

  const window = entry.slice(-(config.pullbackLookback + 1), -1);
  const tol = config.pullbackTouchTolerancePct;
  const direction = biasDir === "UPTREND" ? "BUY" : "SELL";

  if (biasDir === "UPTREND") {
    if (emaFast <= emaSlow) {
      return `BUY blocked: EMA${config.emaFast} <= EMA${config.emaSlow}`;
    }
    const pulledBack = window.some((candle) => candle.low <= emaFast * (1 + tol));
    if (!pulledBack) {
      return `BUY blocked: no pullback to EMA${config.emaFast} in last ${config.pullbackLookback} candle(s)`;
    }
    const confirmed = isBullishConfirmation(prev, last, emaFast, config);
    if (!confirmed) {
      return "BUY blocked: confirmation candle not strong enough";
    }
    if (config.useRsiFilter && rsiV !== null && rsiV >= config.rsiMaxForBuy) {
      return `BUY blocked: RSI ${rsiV} >= ${config.rsiMaxForBuy}`;
    }
  } else {
    if (emaFast >= emaSlow) {
      return `SELL blocked: EMA${config.emaFast} >= EMA${config.emaSlow}`;
    }
    const pulledBack = window.some((candle) => candle.high >= emaFast * (1 - tol));
    if (!pulledBack) {
      return `SELL blocked: no pullback to EMA${config.emaFast} in last ${config.pullbackLookback} candle(s)`;
    }
    const confirmed = isBearishConfirmation(prev, last, emaFast, config);
    if (!confirmed) {
      return "SELL blocked: confirmation candle not strong enough";
    }
    if (config.useRsiFilter && rsiV !== null && rsiV <= config.rsiMinForSell) {
      return `SELL blocked: RSI ${rsiV} <= ${config.rsiMinForSell}`;
    }
  }

  const px = last.close;
  const buffer = atrV * config.atrBufferMult;
  const stopLoss =
    direction === "BUY"
      ? Math.min(...entry.slice(-config.swingLookback).map((candle) => candle.low)) - buffer
      : Math.max(...entry.slice(-config.swingLookback).map((candle) => candle.high)) + buffer;
  const risk = Math.abs(px - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return `${direction} blocked: invalid SL/risk`;

  const takeProfit = findStructuralTakeProfit(
    entry,
    direction,
    px,
    config.targetLookback,
  );
  if (takeProfit === null) {
    return `${direction} blocked: no structural TP beyond entry`;
  }
  const rr =
    direction === "BUY" ? (takeProfit - px) / risk : (px - takeProfit) / risk;
  if (!Number.isFinite(rr) || rr < config.rrTarget) {
    return `${direction} blocked: structural RR ${Number(rr.toFixed(2))} < ${config.rrTarget}`;
  }

  return null;
}

export function evaluateBalancedM5Signal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[],
  config: RuleStrategyConfig = defaultRuleStrategyConfig,
): RuleSignal | null {
  const h1Bias = resolveBiasTrend(h1, config);
  if (h1Bias.direction !== "UPTREND" && h1Bias.direction !== "DOWNTREND") {
    return null;
  }

  const h4Bias = resolveBiasTrend(h4, config);
  if (
    (h4Bias.direction === "UPTREND" || h4Bias.direction === "DOWNTREND") &&
    oppositeTrend(h1Bias.direction, h4Bias.direction)
  ) {
    return null;
  }

  if (!hasPullbackSetup(m15, h1Bias.direction, config)) {
    return null;
  }

  const signal = evaluateRuleSignal(m5, h1, config);
  return signal
    ? {
        ...signal,
        reason: `${signal.reason} (balanced: H1 bias + M15 pullback setup + M5 trigger, H4 soft filter)`,
      }
    : null;
}

export function explainBalancedM5Rejection(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[],
  config: RuleStrategyConfig = defaultRuleStrategyConfig,
): string | null {
  const h1Bias = resolveBiasTrend(h1, config);
  if (h1Bias.direction !== "UPTREND" && h1Bias.direction !== "DOWNTREND") {
    return `H1 bias not clearly trending (EMA=${h1Bias.emaTrend}, structure=${h1Bias.structTrend})`;
  }

  const h4Bias = resolveBiasTrend(h4, config);
  if (
    (h4Bias.direction === "UPTREND" || h4Bias.direction === "DOWNTREND") &&
    oppositeTrend(h1Bias.direction, h4Bias.direction)
  ) {
    return `H4 soft filter blocked: H1=${h1Bias.direction}, H4=${h4Bias.direction}`;
  }

  if (!hasPullbackSetup(m15, h1Bias.direction, config)) {
    return `M15 setup blocked: no pullback to EMA${config.emaFast}/EMA${config.emaSlow} aligned with H1 ${h1Bias.direction}`;
  }

  return (
    explainRuleSignalRejection(m5, h1, config) ??
    "M5 passed balanced diagnostics but returned no signal"
  );
}

function hasPullbackSetup(
  candles: Candle[],
  biasDirection: ReturnType<typeof trend>,
  config: RuleStrategyConfig,
): boolean {
  if (candles.length < Math.max(config.emaSlow, config.pullbackLookback + 2)) {
    return false;
  }
  const closes = candles.map((candle) => candle.close);
  const emaFast = ema(closes, config.emaFast);
  const emaSlow = ema(closes, config.emaSlow);
  if (emaFast === null || emaSlow === null) return false;

  const recent = candles.slice(-(config.pullbackLookback + 1), -1);
  const tolerance = config.pullbackTouchTolerancePct;
  if (biasDirection === "UPTREND") {
    return recent.some(
      (candle) =>
        candle.low <= emaFast * (1 + tolerance) ||
        candle.low <= emaSlow * (1 + tolerance),
    );
  }
  if (biasDirection === "DOWNTREND") {
    return recent.some(
      (candle) =>
        candle.high >= emaFast * (1 - tolerance) ||
        candle.high >= emaSlow * (1 - tolerance),
    );
  }
  return false;
}

/**
 * @param entry  Khung vào lệnh (H1, hoặc M15).
 * @param bias   Khung xu hướng lớn (H4).
 * @param intermediate  Khung trung gian phải đồng pha (vd H1 khi entry là M15). Tùy chọn.
 */
export function evaluateRuleSignal(
  entry: Candle[],
  bias: Candle[],
  config: RuleStrategyConfig = defaultRuleStrategyConfig,
  intermediate?: Candle[],
): RuleSignal | null {
  if (entry.length < 60 || bias.length < 200) return null;

  // Bước 1: BIAS khung lớn.
  const biasState = resolveBiasTrend(bias, config);
  const biasDir = biasState.direction;
  if (biasDir !== "UPTREND" && biasDir !== "DOWNTREND") return null;

  // Khung trung gian (H1 khi entry là M15) phải đồng pha với bias.
  if (intermediate && intermediate.length >= config.emaSlow) {
    const ic = intermediate.map((candle) => candle.close);
    const ief = ema(ic, config.emaFast);
    const ies = ema(ic, config.emaSlow);
    if (ief === null || ies === null) return null;
    const aligned = biasDir === "UPTREND" ? ief > ies : ief < ies;
    if (!aligned) return null;
  }

  const closes = entry.map((candle) => candle.close);
  const emaFast = ema(closes, config.emaFast);
  const emaSlow = ema(closes, config.emaSlow);
  const atrV = atr(entry, config.atrPeriod);
  if (emaFast === null || emaSlow === null || atrV === null || atrV <= 0) {
    return null;
  }
  const rsiV = config.useRsiFilter ? rsi(closes) : null;
  if (config.useRsiFilter && rsiV === null) return null;

  const last = entry.at(-1);
  const prev = entry.at(-2);
  if (!last || !prev) return null;

  const buffer = atrV * config.atrBufferMult;
  const window = entry.slice(-(config.pullbackLookback + 1), -1);
  const tol = config.pullbackTouchTolerancePct;

  if (biasDir === "UPTREND") {
    const up = emaFast > emaSlow;
    const pulledBack = window.some((candle) => candle.low <= emaFast * (1 + tol));
    const confirmed = isBullishConfirmation(prev, last, emaFast, config);
    const rsiOk = !config.useRsiFilter || (rsiV !== null && rsiV < config.rsiMaxForBuy);
    if (!up || !pulledBack || !confirmed || !rsiOk) return null;

    const swingLow = Math.min(
      ...entry.slice(-config.swingLookback).map((candle) => candle.low),
    );
    const px = last.close;
    const stopLoss = round(swingLow - buffer);
    const risk = px - stopLoss;
    if (risk <= 0) return null;
    const takeProfit = findStructuralTakeProfit(
      entry,
      "BUY",
      px,
      config.targetLookback,
    );
    if (takeProfit === null) return null;
    const rr = (takeProfit - px) / risk;
    if (!Number.isFinite(rr) || rr < config.rrTarget) return null;
    return {
      direction: "BUY",
      entry: round(px),
      stopLoss,
      takeProfit,
      reason: "bias up + pullback EMA + xác nhận tăng",
    };
  }

  const down = emaFast < emaSlow;
  const pulledBack = window.some((candle) => candle.high >= emaFast * (1 - tol));
  const confirmed =
    isBearishConfirmation(prev, last, emaFast, config);
  const rsiOk = !config.useRsiFilter || (rsiV !== null && rsiV > config.rsiMinForSell);
  if (!down || !pulledBack || !confirmed || !rsiOk) return null;

  const swingHigh = Math.max(
    ...entry.slice(-config.swingLookback).map((candle) => candle.high),
  );
  const px = last.close;
  const stopLoss = round(swingHigh + buffer);
  const risk = stopLoss - px;
  if (risk <= 0) return null;
  const takeProfit = findStructuralTakeProfit(
    entry,
    "SELL",
    px,
    config.targetLookback,
  );
  if (takeProfit === null) return null;
  const rr = (px - takeProfit) / risk;
  if (!Number.isFinite(rr) || rr < config.rrTarget) return null;
  return {
    direction: "SELL",
    entry: round(px),
    stopLoss,
    takeProfit,
    reason: "bias down + pullback EMA + xác nhận giảm",
  };
}

/**
 * Điểm "độ đẹp" của setup (0-3), tất định — dùng để nâng lot ở auto-bot:
 *   +1 bias H4 đồng thuận cả EMA lẫn cấu trúc (HH/HL).
 *   +1 thân nến xác nhận mạnh (body/range >= 0.6).
 *   +1 EMA H1 xếp tầng đầy đủ thuận hướng (20>50>200 hoặc ngược).
 */
export function convictionScore(
  entry: Candle[],
  bias: Candle[],
  signal: RuleSignal,
  config: RuleStrategyConfig = defaultRuleStrategyConfig,
): number {
  let score = 0;
  const closes = entry.map((candle) => candle.close);
  const emaTrend = trend(bias.map((candle) => candle.close));
  const structTrend = structureTrend(bias, 20);
  const wantUp = signal.direction === "BUY";
  const biasLabel = wantUp ? "UPTREND" : "DOWNTREND";
  if (emaTrend === biasLabel && structTrend === biasLabel) score += 1;

  const last = entry.at(-1);
  if (last) {
    const range = last.high - last.low;
    const bodyRatio = range > 0 ? Math.abs(last.close - last.open) / range : 0;
    if (bodyRatio >= 0.6) score += 1;
  }

  const e20 = ema(closes, config.emaFast);
  const e50 = ema(closes, config.emaSlow);
  const e200 = ema(closes, 200);
  if (e20 !== null && e50 !== null && e200 !== null) {
    const stacked = wantUp ? e20 > e50 && e50 > e200 : e20 < e50 && e50 < e200;
    if (stacked) score += 1;
  }
  return score;
}

function isBullishEngulfing(prev: Candle, last: Candle): boolean {
  return (
    prev.close < prev.open &&
    last.close > last.open &&
    last.close >= prev.open &&
    last.open <= prev.close
  );
}

function isBullishPinBar(candle: Candle): boolean {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return lowerWick >= 2 * Math.max(body, 0.000001) && candle.close >= candle.low + range * (2 / 3);
}

function isStrongBullishTrigger(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = candle.close - candle.open;
  return body > 0 && body / range >= 0.55 && candle.close >= candle.low + range * 0.7;
}

function isVeryStrongBullishTrigger(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = candle.close - candle.open;
  return body > 0 && body / range >= 0.65 && candle.close >= candle.low + range * 0.78;
}

function isBullishMomentumBreak(prev: Candle, last: Candle): boolean {
  const range = last.high - last.low;
  if (range <= 0) return false;
  const body = last.close - last.open;
  return (
    body > 0 &&
    last.close > prev.high &&
    body / range >= 0.4 &&
    last.close >= last.low + range * 0.55
  );
}

function isBullishScalpMomentumCandle(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = candle.close - candle.open;
  return body > 0 && body / range >= 0.45 && candle.close >= candle.low + range * 0.6;
}

function isBullishConfirmation(
  prev: Candle,
  last: Candle,
  emaFast: number,
  config: RuleStrategyConfig,
): boolean {
  if (config.confirmMode === "ENGULFING") {
    return isBullishEngulfing(prev, last) && last.close > emaFast;
  }
  const base = last.close > last.open && last.close > emaFast;
  return config.requireBreakOfPreviousCandle ? base && last.close > prev.high : base;
}

function isBearishEngulfing(prev: Candle, last: Candle): boolean {
  return (
    prev.close > prev.open &&
    last.close < last.open &&
    last.close <= prev.open &&
    last.open >= prev.close
  );
}

function isBearishPinBar(candle: Candle): boolean {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return upperWick >= 2 * Math.max(body, 0.000001) && candle.close <= candle.low + range / 3;
}

function isStrongBearishTrigger(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = candle.open - candle.close;
  return body > 0 && body / range >= 0.55 && candle.close <= candle.low + range * 0.3;
}

function isVeryStrongBearishTrigger(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = candle.open - candle.close;
  return body > 0 && body / range >= 0.65 && candle.close <= candle.low + range * 0.22;
}

function isBearishMomentumBreak(prev: Candle, last: Candle): boolean {
  const range = last.high - last.low;
  if (range <= 0) return false;
  const body = last.open - last.close;
  return (
    body > 0 &&
    last.close < prev.low &&
    body / range >= 0.4 &&
    last.close <= last.low + range * 0.45
  );
}

function isBearishScalpMomentumCandle(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = candle.open - candle.close;
  return body > 0 && body / range >= 0.45 && candle.close <= candle.low + range * 0.4;
}

function isBearishConfirmation(
  prev: Candle,
  last: Candle,
  emaFast: number,
  config: RuleStrategyConfig,
): boolean {
  if (config.confirmMode === "ENGULFING") {
    return isBearishEngulfing(prev, last) && last.close < emaFast;
  }
  const base = last.close < last.open && last.close < emaFast;
  return config.requireBreakOfPreviousCandle ? base && last.close < prev.low : base;
}

function findStructuralTakeProfit(
  candles: Candle[],
  direction: "BUY" | "SELL",
  entryPrice: number,
  lookback: number,
): number | null {
  const history = candles.slice(-Math.max(10, lookback + 1), -1);
  if (history.length < 10) return null;

  if (direction === "BUY") {
    const candidates = structuralHighs(history)
      .filter((level) => Number.isFinite(level) && level > entryPrice);
    return candidates.length > 0 ? round(Math.min(...candidates)) : null;
  }

  const candidates = structuralLows(history)
    .filter((level) => Number.isFinite(level) && level < entryPrice);
  return candidates.length > 0 ? round(Math.max(...candidates)) : null;
}

function findNearestM15SwingStop(
  candles: Candle[],
  direction: "BUY" | "SELL",
  entryPrice: number,
): number | null {
  const history = candles.slice(-50);
  const swings = direction === "BUY" ? structuralLows(history) : structuralHighs(history);
  const candidates = swings.filter((level) =>
    direction === "BUY" ? level < entryPrice : level > entryPrice,
  );
  if (candidates.length === 0) return null;
  return direction === "BUY" ? Math.max(...candidates) : Math.min(...candidates);
}

function findNearestM15TargetSwing(
  candles: Candle[],
  direction: "BUY" | "SELL",
  entryPrice: number,
): number | null {
  const history = candles.slice(-50);
  const swings = direction === "BUY" ? structuralHighs(history) : structuralLows(history);
  const candidates = swings.filter((level) =>
    direction === "BUY" ? level > entryPrice : level < entryPrice,
  );
  if (candidates.length === 0) return null;
  return direction === "BUY" ? Math.min(...candidates) : Math.max(...candidates);
}

function structuralHighs(candles: Candle[]): number[] {
  const pivots: number[] = [];
  for (let i = 2; i < candles.length - 2; i += 1) {
    const left2 = candles[i - 2]!;
    const left1 = candles[i - 1]!;
    const current = candles[i]!;
    const right1 = candles[i + 1]!;
    const right2 = candles[i + 2]!;
    if (
      current.high >= left2.high &&
      current.high >= left1.high &&
      current.high >= right1.high &&
      current.high >= right2.high
    ) {
      pivots.push(current.high);
    }
  }

  // Fallback: nếu thị trường trend quá mượt không tạo pivot rõ, dùng high lịch sử
  // gần nhất như vùng chốt lời cấu trúc, rồi để RR filter quyết định có đáng đánh không.
  return pivots.length > 0 ? pivots : candles.map((candle) => candle.high);
}

function structuralLows(candles: Candle[]): number[] {
  const pivots: number[] = [];
  for (let i = 2; i < candles.length - 2; i += 1) {
    const left2 = candles[i - 2]!;
    const left1 = candles[i - 1]!;
    const current = candles[i]!;
    const right1 = candles[i + 1]!;
    const right2 = candles[i + 2]!;
    if (
      current.low <= left2.low &&
      current.low <= left1.low &&
      current.low <= right1.low &&
      current.low <= right2.low
    ) {
      pivots.push(current.low);
    }
  }

  return pivots.length > 0 ? pivots : candles.map((candle) => candle.low);
}

// Số chữ số thập phân theo độ lớn giá: XAUUSD (~hàng trăm/nghìn) dùng 3 số,
// EURUSD (~1.0x) cần 5 số để giữ độ chính xác pip lẻ. Cùng quy ước với
// roundPrice() trong AutoTradeRunner.ts.
// Số chữ số thập phân theo độ lớn giá: XAUUSD (~hàng trăm/nghìn) dùng 3 số,
// EURUSD (~1.0x) cần 5 số để giữ độ chính xác pip lẻ. Cùng quy ước với
// roundPrice() trong AutoTradeRunner.ts.
function round(value: number): number {
  const digits = Math.abs(value) >= 100 ? 3 : 5;
  return Number(value.toFixed(digits));
}
