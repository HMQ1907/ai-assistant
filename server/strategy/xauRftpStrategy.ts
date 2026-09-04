import type { Candle } from "../../types/trading";
import type { RuleSignal } from "./ruleStrategy";
import { atr, ema } from "../utils/indicators";

export interface XauRftpConfig {
  m15FastEma: number;
  m15RegimeEma: number;
  m15SlopeBars: number;
  m5FastEma: number;
  m5PullbackEma: number;
  atrPeriod: number;
  atrPercentileLookbackBars: number;
  minAtrPercentile: number;
  maxAtrPercentile: number;
  pullbackToleranceAtr: number;
  rejectionWickRatio: number;
  rejectionClosePosition: number;
  maxRejectionRangeAtr: number;
  confirmationBars: number;
  breakoutBufferAtr: number;
  maxEntryExtensionAtr: number;
  swingLookback: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  targetR: number;
  maxSpreadToStopRatio: number;
  maxSpreadMedianMultiple: number;
  sessionStartUtcMinutes: number;
  sessionEndUtcMinutes: number;
  useH1Bias: boolean;
  allowBuy: boolean;
  allowSell: boolean;
}

export interface XauRftpOptions {
  now?: Date;
  newsWindowClear?: boolean;
  bid?: number | null;
  ask?: number | null;
  spreadPrice?: number | null;
}

export interface XauRftpEvaluation {
  signal: RuleSignal | null;
  reason: string;
  regime: "LONG" | "SHORT" | "NEUTRAL";
  atrPercentile: number | null;
  sessionVwap: number | null;
  rejectionTime: string | null;
}

export const defaultXauRftpConfig: XauRftpConfig = {
  m15FastEma: 50,
  m15RegimeEma: 200,
  m15SlopeBars: 5,
  m5FastEma: 20,
  m5PullbackEma: 50,
  atrPeriod: 14,
  atrPercentileLookbackBars: 1_920,
  minAtrPercentile: 20,
  maxAtrPercentile: 95,
  pullbackToleranceAtr: 0.3,
  rejectionWickRatio: 0.3,
  rejectionClosePosition: 0.65,
  maxRejectionRangeAtr: 1.5,
  confirmationBars: 3,
  breakoutBufferAtr: 0.03,
  maxEntryExtensionAtr: 0.35,
  swingLookback: 6,
  stopBufferAtr: 0.15,
  minStopAtr: 0.6,
  maxStopAtr: 1.3,
  targetR: 2.0,
  maxSpreadToStopRatio: 0.1,
  maxSpreadMedianMultiple: 1.8,
  // Scanner stays awake all day; regime, spread, volatility and news gates decide whether to alert.
  sessionStartUtcMinutes: 0,
  sessionEndUtcMinutes: 24 * 60,
  useH1Bias: false,
  allowBuy: true,
  // The latest 90-day walk-forward rejected the SELL branch. Re-enable only after it passes OOS.
  allowSell: false,
};

export function evaluateXauRftpSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[] = [],
  options: XauRftpOptions = {},
  config: XauRftpConfig = defaultXauRftpConfig,
): RuleSignal | null {
  return explainXauRftp(m5, m15, h1, options, config).signal;
}

export function explainXauRftp(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[] = [],
  options: XauRftpOptions = {},
  config: XauRftpConfig = defaultXauRftpConfig,
): XauRftpEvaluation {
  const neutral = (reason: string, atrPercentile: number | null = null, sessionVwap: number | null = null): XauRftpEvaluation => ({
    signal: null,
    reason,
    regime: "NEUTRAL",
    atrPercentile,
    sessionVwap,
    rejectionTime: null,
  });
  const now = options.now ?? new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (!isWithinUtcSession(utcMinutes, config.sessionStartUtcMinutes, config.sessionEndUtcMinutes)) {
    return neutral("RFTP blocked: outside configured UTC session");
  }
  if (options.newsWindowClear === false) return neutral("RFTP blocked: high-impact USD news blackout");
  const minM15 = Math.max(config.m15RegimeEma + config.m15SlopeBars, config.atrPeriod + 50);
  if (m15.length < minM15 || m5.length < config.m5PullbackEma + config.confirmationBars + 2) {
    return neutral(`RFTP blocked: insufficient candles M15=${m15.length}/${minM15}, M5=${m5.length}`);
  }

  const m15Close = m15.map((candle) => candle.close);
  const latestM15 = m15.at(-1)!;
  const ema50 = ema(m15Close, config.m15FastEma);
  const ema200 = ema(m15Close, config.m15RegimeEma);
  const ema200Past = ema(m15Close.slice(0, -config.m15SlopeBars), config.m15RegimeEma);
  const sessionVwap = resolveSessionVwap(m15, latestM15.time);
  const currentAtrM15 = atr(m15, config.atrPeriod);
  const atrPercentile = resolveAtrPercentile(m15, config.atrPeriod, config.atrPercentileLookbackBars);
  if (ema50 === null || ema200 === null || ema200Past === null || sessionVwap === null || currentAtrM15 === null || atrPercentile === null) {
    return neutral("RFTP blocked: regime indicators unavailable", atrPercentile, sessionVwap);
  }
  if (atrPercentile < config.minAtrPercentile || atrPercentile > config.maxAtrPercentile) {
    return neutral(`RFTP blocked: M15 ATR percentile ${atrPercentile.toFixed(1)} outside ${config.minAtrPercentile}-${config.maxAtrPercentile}`, atrPercentile, sessionVwap);
  }

  const longRegime = config.allowBuy && latestM15.close > ema200 && ema50 > ema200 && latestM15.close > sessionVwap && ema200 > ema200Past;
  const shortRegime = config.allowSell && latestM15.close < ema200 && ema50 < ema200 && latestM15.close < sessionVwap && ema200 < ema200Past;
  let regime: XauRftpEvaluation["regime"] = longRegime ? "LONG" : shortRegime ? "SHORT" : "NEUTRAL";
  if (regime === "NEUTRAL") return neutral("RFTP blocked: M15 EMA50/EMA200/VWAP/slope regime not aligned", atrPercentile, sessionVwap);
  if (config.useH1Bias && !h1BiasAligned(h1, regime)) {
    return { signal: null, reason: `RFTP blocked: optional H1 bias conflicts with ${regime}`, regime, atrPercentile, sessionVwap, rejectionTime: null };
  }

  const m5Atr = atr(m5, config.atrPeriod);
  if (m5Atr === null || m5Atr <= 0) {
    return { signal: null, reason: "RFTP blocked: M5 ATR unavailable", regime, atrPercentile, sessionVwap, rejectionTime: null };
  }
  const lastIndex = m5.length - 1;
  const firstCandidate = Math.max(config.m5PullbackEma, lastIndex - config.confirmationBars);
  let rejectionIndex = -1;
  for (let index = lastIndex - 1; index >= firstCandidate; index -= 1) {
    if (isPullbackRejection(m5, index, regime, m5Atr, config)) {
      rejectionIndex = index;
      break;
    }
  }
  if (rejectionIndex < 0) {
    return { signal: null, reason: `RFTP waiting: no valid M5 ${regime} pullback rejection`, regime, atrPercentile, sessionVwap, rejectionTime: null };
  }

  const rejection = m5[rejectionIndex]!;
  const buffer = Math.max(m5Atr * config.breakoutBufferAtr, options.spreadPrice ?? 0);
  const trigger = regime === "LONG" ? rejection.high + buffer : rejection.low - buffer;
  const confirmation = m5.slice(rejectionIndex + 1, rejectionIndex + 1 + config.confirmationBars);
  const broke = confirmation.some((candle) => regime === "LONG" ? candle.high >= trigger : candle.low <= trigger);
  if (!broke) {
    return { signal: null, reason: `RFTP waiting: ${regime === "LONG" ? "BUY_STOP" : "SELL_STOP"} ${round(trigger)} not triggered within ${config.confirmationBars} M5 bars`, regime, atrPercentile, sessionVwap, rejectionTime: rejection.time };
  }

  const quoteEntry = regime === "LONG" ? options.ask : options.bid;
  const entry = quoteEntry && Number.isFinite(quoteEntry) ? quoteEntry : trigger;
  if (Math.abs(entry - trigger) > config.maxEntryExtensionAtr * m5Atr) {
    return { signal: null, reason: "RFTP blocked: breakout already overextended; do not chase", regime, atrPercentile, sessionVwap, rejectionTime: rejection.time };
  }
  const swingSlice = m5.slice(Math.max(0, rejectionIndex + 1 - config.swingLookback), rejectionIndex + 1);
  const structure = regime === "LONG"
    ? Math.min(...swingSlice.map((candle) => candle.low))
    : Math.max(...swingSlice.map((candle) => candle.high));
  const stopLoss = regime === "LONG" ? structure - config.stopBufferAtr * m5Atr : structure + config.stopBufferAtr * m5Atr;
  const risk = regime === "LONG" ? entry - stopLoss : stopLoss - entry;
  if (risk < config.minStopAtr * m5Atr || risk > config.maxStopAtr * m5Atr) {
    return { signal: null, reason: `RFTP blocked: SL distance ${(risk / m5Atr).toFixed(2)} ATR outside ${config.minStopAtr}-${config.maxStopAtr}`, regime, atrPercentile, sessionVwap, rejectionTime: rejection.time };
  }
  const spread = options.spreadPrice ?? 0;
  if (spread > 0 && spread / risk > config.maxSpreadToStopRatio) {
    return { signal: null, reason: `RFTP blocked: spread is ${((spread / risk) * 100).toFixed(1)}% of SL`, regime, atrPercentile, sessionVwap, rejectionTime: rejection.time };
  }
  const historicalSpreads = m5.slice(-6).map((candle) => candle.spread).filter((value): value is number => value !== undefined && value > 0);
  const medianSpread = median(historicalSpreads);
  if (spread > 0 && medianSpread !== null && spread > medianSpread * config.maxSpreadMedianMultiple) {
    return { signal: null, reason: `RFTP blocked: spread ${spread.toFixed(3)} > median×${config.maxSpreadMedianMultiple}`, regime, atrPercentile, sessionVwap, rejectionTime: rejection.time };
  }

  const direction = regime === "LONG" ? "BUY" : "SELL";
  const takeProfit = direction === "BUY" ? entry + config.targetR * risk : entry - config.targetR * risk;
  return {
    signal: {
      direction,
      entry: round(entry),
      stopLoss: round(stopLoss),
      takeProfit: round(takeProfit),
      reason: `XAU RFTP v1: M15 ${regime} EMA50/200+VWAP, ATRp ${atrPercentile.toFixed(1)}, M5 pullback rejection+break, RR ${config.targetR.toFixed(2)}.`,
      strategyKind: "ICT_SETUP",
    },
    reason: "RFTP setup valid",
    regime,
    atrPercentile,
    sessionVwap,
    rejectionTime: rejection.time,
  };
}

function isPullbackRejection(m5: Candle[], index: number, regime: "LONG" | "SHORT", m5Atr: number, config: XauRftpConfig): boolean {
  const candle = m5[index];
  if (!candle) return false;
  const range = candle.high - candle.low;
  if (range <= 0 || range > config.maxRejectionRangeAtr * m5Atr) return false;
  const closes = m5.slice(0, index + 1).map((item) => item.close);
  const ema20 = ema(closes, config.m5FastEma);
  const ema50 = ema(closes, config.m5PullbackEma);
  if (ema20 === null || ema50 === null) return false;
  const tolerance = config.pullbackToleranceAtr * m5Atr;
  const touched = [ema20, ema50].some((level) => candle.low <= level + tolerance && candle.high >= level - tolerance);
  if (!touched) return false;
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBottom = Math.min(candle.open, candle.close);
  const lowerWick = bodyBottom - candle.low;
  const upperWick = candle.high - bodyTop;
  const closePosition = (candle.close - candle.low) / range;
  return regime === "LONG"
    ? candle.close > candle.open && lowerWick / range >= config.rejectionWickRatio && closePosition >= config.rejectionClosePosition
    : candle.close < candle.open && upperWick / range >= config.rejectionWickRatio && closePosition <= 1 - config.rejectionClosePosition;
}

function resolveSessionVwap(candles: Candle[], latestTime: string): number | null {
  const day = latestTime.slice(0, 10);
  const session = candles.filter((candle) => candle.time.slice(0, 10) === day);
  if (!session.length) return null;
  let weighted = 0;
  let volume = 0;
  for (const candle of session) {
    const candleVolume = Math.max(0, candle.volume);
    weighted += ((candle.high + candle.low + candle.close) / 3) * candleVolume;
    volume += candleVolume;
  }
  return volume > 0 ? weighted / volume : null;
}

function resolveAtrPercentile(candles: Candle[], period: number, lookback: number): number | null {
  const sample = candles.slice(-(lookback + period + 1));
  const trueRanges: number[] = [];
  for (let index = 1; index < sample.length; index += 1) {
    const current = sample[index];
    const previous = sample[index - 1];
    if (!current || !previous) continue;
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  const values: number[] = [];
  let rolling = 0;
  for (let index = 0; index < trueRanges.length; index += 1) {
    rolling += trueRanges[index] ?? 0;
    if (index >= period) rolling -= trueRanges[index - period] ?? 0;
    if (index >= period - 1) values.push(rolling / period);
  }
  const current = values.at(-1);
  if (current === undefined || values.length < 50) return null;
  const rank = values.filter((value) => value <= current).length;
  return (rank / values.length) * 100;
}

function h1BiasAligned(h1: Candle[], regime: "LONG" | "SHORT"): boolean {
  if (h1.length < 55) return false;
  const values = h1.map((candle) => candle.close);
  const current = ema(values, 50);
  const prior = ema(values.slice(0, -5), 50);
  return current !== null && prior !== null && (regime === "LONG" ? current > prior : current < prior);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

/** Supports ordinary sessions (07:00-12:00), overnight sessions (22:00-07:00), and 00:00-24:00. */
export function isWithinUtcSession(utcMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === 0 && endMinutes === 24 * 60) return true;
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return utcMinutes >= startMinutes && utcMinutes < endMinutes;
  return utcMinutes >= startMinutes || utcMinutes < endMinutes;
}
