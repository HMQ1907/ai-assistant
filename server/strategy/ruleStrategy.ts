import type { Candle } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { atr, ema, rsi, structureTrend, trend } from "../utils/indicators";

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
  const biasDir =
    config.biasMode === "STRUCTURE"
      ? structureTrend(bias, 20)
      : trend(bias.map((candle) => candle.close));
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
    const confirmed =
      config.confirmMode === "ENGULFING"
        ? isBullishEngulfing(prev, last) && last.close > emaFast
        : last.close > last.open && last.close > emaFast && last.close > prev.high;
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
    config.confirmMode === "ENGULFING"
      ? isBearishEngulfing(prev, last) && last.close < emaFast
      : last.close < last.open && last.close < emaFast && last.close < prev.low;
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

function isBearishEngulfing(prev: Candle, last: Candle): boolean {
  return (
    prev.close > prev.open &&
    last.close < last.open &&
    last.close <= prev.open &&
    last.open >= prev.close
  );
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

function round(value: number): number {
  return Number(value.toFixed(3));
}
