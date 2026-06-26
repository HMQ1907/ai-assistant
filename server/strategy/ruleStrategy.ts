import type { Candle } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { atr, ema, rsi, structureTrend, trend } from "../utils/indicators";

/**
 * Rules engine TẤT ĐỊNH cho method 5 bước (không AI):
 *   1. BIAS: xu hướng H4 (EMA alignment hoặc Dow HH/HL).
 *   2. TRIGGER: trên H1, giá hồi về vùng EMA nhanh (pullback) thuận bias.
 *   3. XÁC NHẬN: nến H1 quay lại theo hướng bias (phá đỉnh/đáy nến trước, hoặc engulfing).
 *   4. SL: ngoài swing gần nhất + đệm ATR(H1).
 *   5. TP: theo bội số R (rrTarget) của khoảng rủi ro.
 * Filter phụ (bật/tắt được, để backtest đo đóng góp): RSI, Dow bias, engulfing.
 */
export type BiasMode = "EMA" | "STRUCTURE";
export type ConfirmMode = "BREAK" | "ENGULFING";

export interface RuleStrategyConfig {
  emaFast: number;
  emaSlow: number;
  atrPeriod: number;
  atrBufferMult: number;
  rrTarget: number;
  pullbackLookback: number;
  swingLookback: number;
  pullbackTouchTolerancePct: number;
  biasMode: BiasMode;
  confirmMode: ConfirmMode;
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
  pullbackTouchTolerancePct: 0.0015,
  biasMode: "EMA",
  confirmMode: "BREAK",
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
}

export function evaluateRuleSignal(
  h1: Candle[],
  h4: Candle[],
  config: RuleStrategyConfig = defaultRuleStrategyConfig,
): RuleSignal | null {
  if (h1.length < 60 || h4.length < 200) return null;

  // Bước 1: BIAS H4.
  const h4Bias =
    config.biasMode === "STRUCTURE"
      ? structureTrend(h4, 20)
      : trend(h4.map((candle) => candle.close));
  if (h4Bias !== "UPTREND" && h4Bias !== "DOWNTREND") return null;

  const closes = h1.map((candle) => candle.close);
  const emaFast = ema(closes, config.emaFast);
  const emaSlow = ema(closes, config.emaSlow);
  const atrH1 = atr(h1, config.atrPeriod);
  if (emaFast === null || emaSlow === null || atrH1 === null || atrH1 <= 0) {
    return null;
  }
  const rsiH1 = config.useRsiFilter ? rsi(closes) : null;
  if (config.useRsiFilter && rsiH1 === null) return null;

  const last = h1.at(-1);
  const prev = h1.at(-2);
  if (!last || !prev) return null;

  const buffer = atrH1 * config.atrBufferMult;
  const window = h1.slice(-(config.pullbackLookback + 1), -1);
  const tol = config.pullbackTouchTolerancePct;

  if (h4Bias === "UPTREND") {
    const h1Up = emaFast > emaSlow;
    const pulledBack = window.some((candle) => candle.low <= emaFast * (1 + tol));
    const confirmed =
      config.confirmMode === "ENGULFING"
        ? isBullishEngulfing(prev, last) && last.close > emaFast
        : last.close > last.open && last.close > emaFast && last.close > prev.high;
    const rsiOk = !config.useRsiFilter || (rsiH1 !== null && rsiH1 < config.rsiMaxForBuy);
    if (!h1Up || !pulledBack || !confirmed || !rsiOk) return null;

    const swingLow = Math.min(
      ...h1.slice(-config.swingLookback).map((candle) => candle.low),
    );
    const entry = last.close;
    const stopLoss = round(swingLow - buffer);
    const risk = entry - stopLoss;
    if (risk <= 0) return null;
    return {
      direction: "BUY",
      entry: round(entry),
      stopLoss,
      takeProfit: round(entry + config.rrTarget * risk),
      reason: "H4 up + H1 pullback EMA + xác nhận tăng",
    };
  }

  const h1Down = emaFast < emaSlow;
  const pulledBack = window.some((candle) => candle.high >= emaFast * (1 - tol));
  const confirmed =
    config.confirmMode === "ENGULFING"
      ? isBearishEngulfing(prev, last) && last.close < emaFast
      : last.close < last.open && last.close < emaFast && last.close < prev.low;
  const rsiOk = !config.useRsiFilter || (rsiH1 !== null && rsiH1 > config.rsiMinForSell);
  if (!h1Down || !pulledBack || !confirmed || !rsiOk) return null;

  const swingHigh = Math.max(
    ...h1.slice(-config.swingLookback).map((candle) => candle.high),
  );
  const entry = last.close;
  const stopLoss = round(swingHigh + buffer);
  const risk = stopLoss - entry;
  if (risk <= 0) return null;
  return {
    direction: "SELL",
    entry: round(entry),
    stopLoss,
    takeProfit: round(entry - config.rrTarget * risk),
    reason: "H4 down + H1 pullback EMA + xác nhận giảm",
  };
}

/**
 * Điểm "độ đẹp" của setup (0-3), tất định — dùng để nâng lot ở auto-bot:
 *   +1 bias H4 đồng thuận cả EMA lẫn cấu trúc (HH/HL).
 *   +1 thân nến xác nhận mạnh (body/range >= 0.6).
 *   +1 EMA H1 xếp tầng đầy đủ thuận hướng (20>50>200 hoặc ngược).
 */
export function convictionScore(
  h1: Candle[],
  h4: Candle[],
  signal: RuleSignal,
  config: RuleStrategyConfig = defaultRuleStrategyConfig,
): number {
  let score = 0;
  const closes = h1.map((candle) => candle.close);
  const emaTrend = trend(h4.map((candle) => candle.close));
  const structTrend = structureTrend(h4, 20);
  const wantUp = signal.direction === "BUY";
  const biasLabel = wantUp ? "UPTREND" : "DOWNTREND";
  if (emaTrend === biasLabel && structTrend === biasLabel) score += 1;

  const last = h1.at(-1);
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

function isBearishEngulfing(prev: Candle, last: Candle): boolean {
  return (
    prev.close > prev.open &&
    last.close < last.open &&
    last.close <= prev.open &&
    last.open >= prev.close
  );
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
