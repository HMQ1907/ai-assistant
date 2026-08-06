import type { Candle } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { adx, atr, ema, structureTrend, trend } from "../utils/indicators";

/**
 * ==========================================================================
 * PHẦN 1 — Dùng chung / các chiến lược khác (KHÔNG thuộc rulebook ICT XAUUSD)
 * ==========================================================================
 * - RuleStrategyConfig/defaultRuleStrategyConfig/convictionScore: dùng chung,
 *   kể cả bởi xau_micro_scalp (đang live) để tính điểm conviction -> chọn lot.
 * - evaluateManualReversalScalpSignal: chiến lược "manual/aggressive reversal
 *   scalp" độc lập, dùng cho cả XAUUSD và EURUSD (mode manual_scalp) — không
 *   liên quan tới rulebook ICT ở PHẦN 2.
 * ==========================================================================
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
  targetLookback: number;
  pullbackTouchTolerancePct: number;
  biasMode: BiasMode;
  confirmMode: ConfirmMode;
  requireBreakOfPreviousCandle: boolean;
  useRsiFilter: boolean;
  rsiMaxForBuy: number;
  rsiMinForSell: number;
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
  strategyKind?: "SETUP" | "MOMENTUM_SCALP" | "REVERSAL_SCALP" | "ICT_SETUP";
}

export interface ManualReversalScalpOptions {
  takeProfitR?: number;
  frequency?: "normal" | "high";
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

export function evaluateManualReversalScalpSignal(
  m1: Candle[],
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  options: ManualReversalScalpOptions = {},
): RuleSignal | null {
  return buildManualReversalScalpSignal(m1, m5, m15, h1, options).signal;
}

export function explainManualReversalScalpRejection(
  m1: Candle[],
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  options: ManualReversalScalpOptions = {},
): string | null {
  return buildManualReversalScalpSignal(m1, m5, m15, h1, options).reason;
}

function buildManualReversalScalpSignal(
  m1: Candle[],
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  options: ManualReversalScalpOptions = {},
): { signal: RuleSignal | null; reason: string } {
  if (m1.length < 60) return { signal: null, reason: `M1 candles ${m1.length} < 60` };
  if (m5.length < 80) return { signal: null, reason: `M5 candles ${m5.length} < 80` };
  if (m15.length < 80) return { signal: null, reason: `M15 candles ${m15.length} < 80` };
  if (h1.length < 60) return { signal: null, reason: `H1 candles ${h1.length} < 60` };

  const m15Closes = m15.map((candle) => candle.close);
  const m5Closes = m5.map((candle) => candle.close);
  const h1Closes = h1.map((candle) => candle.close);
  const m15Rsi = rsiLocal(m15Closes, 14);
  const m5Rsi = rsiLocal(m5Closes, 14);
  const m15Atr = atr(m15, 14);
  const m5Atr = atr(m5, 14);
  const h1Adx = adx(h1, 14);
  const h1Ema200 = ema(h1Closes, 200);
  const m15Bands = bollingerBands(m15Closes, 20, 2);
  const lastM15 = m15.at(-1);
  const lastM5 = m5.at(-1);
  const prevM5 = m5.at(-2);
  const lastM1 = m1.at(-1);
  const prevM1 = m1.at(-2);
  const lastH1 = h1.at(-1);

  if (
    m15Rsi === null ||
    m5Rsi === null ||
    m15Atr === null ||
    m15Atr <= 0 ||
    m5Atr === null ||
    m5Atr <= 0 ||
    h1Adx === null ||
    m15Bands === null ||
    !lastM15 ||
    !lastM5 ||
    !prevM5 ||
    !lastM1 ||
    !prevM1 ||
    !lastH1
  ) {
    return { signal: null, reason: "manual scalp indicator/candle data unavailable" };
  }

  const highFrequency = options.frequency === "high";
  const h1AdxMax = highFrequency ? 45 : 38;
  if (h1Adx > h1AdxMax) {
    return {
      signal: null,
      reason: `manual scalp blocked: H1 ADX ${h1Adx} > 38, trend quá mạnh để bắt đỉnh/đáy`,
    };
  }

  const buyBandTouch =
    lastM15.low <= m15Bands.lower || lastM15.close <= m15Bands.lower + 0.15 * m15Atr;
  const sellBandTouch =
    lastM15.high >= m15Bands.upper || lastM15.close >= m15Bands.upper - 0.15 * m15Atr;
  const buyExtreme = highFrequency ? m15Rsi <= 55 : m15Rsi <= 40;
  const sellExtreme = highFrequency ? m15Rsi >= 45 : m15Rsi >= 60;
  const m1SweepLookback = highFrequency ? 6 : 12;
  const m5SweepLookback = highFrequency ? 4 : 8;
  const buyM5RsiMax = highFrequency ? 60 : 50;
  const sellM5RsiMin = highFrequency ? 40 : 50;
  const buyTrigger =
    (hasBullishSweep(m1, m1SweepLookback) || hasBullishSweep(m5, m5SweepLookback)) &&
    isBullishManualScalpConfirm(lastM1) &&
    m5Rsi <= buyM5RsiMax &&
    isMomentumRecovering(m5, "BUY");
  const sellTrigger =
    (hasBearishSweep(m1, m1SweepLookback) || hasBearishSweep(m5, m5SweepLookback)) &&
    isBearishManualScalpConfirm(lastM1) &&
    m5Rsi >= sellM5RsiMin &&
    isMomentumRecovering(m5, "SELL");

  const direction: "BUY" | "SELL" | null =
    buyExtreme && buyTrigger ? "BUY" : sellExtreme && sellTrigger ? "SELL" : null;
  if (direction === null) {
    return {
      signal: null,
      reason:
        `manual scalp blocked: need ${highFrequency ? "high-frequency" : "aggressive"} M15 RSI zone + M1/M5 sweep + M1 momentum/pinbar trigger ` +
        `(M15 RSI ${m15Rsi}, M5 RSI ${m5Rsi}, H1 ADX ${h1Adx})`,
    };
  }

  if (
    direction === "BUY" &&
    h1Ema200 !== null &&
    lastH1.close < h1Ema200 &&
    h1Adx > 30
  ) {
    return { signal: null, reason: "manual scalp BUY blocked: H1 downtrend still too strong" };
  }
  if (
    direction === "SELL" &&
    h1Ema200 !== null &&
    lastH1.close > h1Ema200 &&
    h1Adx > 30
  ) {
    return { signal: null, reason: "manual scalp SELL blocked: H1 uptrend still too strong" };
  }

  const entry = lastM1.close;
  const recentM1 = m1.slice(-20);
  const sweepLow = Math.min(...recentM1.map((candle) => candle.low));
  const sweepHigh = Math.max(...recentM1.map((candle) => candle.high));
  const stopLoss =
    direction === "BUY"
      ? Math.min(sweepLow - 0.25 * m5Atr, entry - 0.6 * m15Atr)
      : Math.max(sweepHigh + 0.25 * m5Atr, entry + 0.6 * m15Atr);
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    return { signal: null, reason: `manual scalp ${direction} blocked: invalid SL/risk` };
  }

  const takeProfitR =
    Number.isFinite(options.takeProfitR) && Number(options.takeProfitR) > 0
      ? Number(options.takeProfitR)
      : 1.5;
  const takeProfit = direction === "BUY" ? entry + takeProfitR * risk : entry - takeProfitR * risk;
  return {
    signal: {
      direction,
      entry: round(entry),
      stopLoss: round(stopLoss),
      takeProfit: round(takeProfit),
      reason:
        `MANUAL ${highFrequency ? "HIGH_FREQUENCY" : "AGGRESSIVE"}_REVERSAL_SCALP: M15 RSI ${m15Rsi} ` +
        `(${direction === "BUY" ? (buyBandTouch ? "near lower band" : "no lower band touch") : (sellBandTouch ? "near upper band" : "no upper band touch")}), ` +
        `M1/M5 liquidity sweep trigger, M5 RSI ${m5Rsi}, H1 ADX ${h1Adx}, TP ${takeProfitR}R`,
      strategyKind: "REVERSAL_SCALP",
    },
    reason: "manual reversal scalp signal found",
  };
}

function hasBullishSweep(candles: Candle[], lookback: number): boolean {
  const last = candles.at(-1);
  if (!last || candles.length < lookback + 2) return false;
  const previous = candles.slice(-lookback - 1, -1);
  const previousLow = Math.min(...previous.map((candle) => candle.low));
  return last.low < previousLow && last.close > previousLow && last.close > last.open;
}

function hasBearishSweep(candles: Candle[], lookback: number): boolean {
  const last = candles.at(-1);
  if (!last || candles.length < lookback + 2) return false;
  const previous = candles.slice(-lookback - 1, -1);
  const previousHigh = Math.max(...previous.map((candle) => candle.high));
  return last.high > previousHigh && last.close < previousHigh && last.close < last.open;
}

function isBullishManualScalpConfirm(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const isMomentumBuy = body / range >= 0.45 && candle.close >= candle.low + range * 0.6;
  const isPinbarBuy = candle.close >= candle.low + range * 0.75;
  return isMomentumBuy || isPinbarBuy;
}

function isBearishManualScalpConfirm(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const isMomentumSell = body / range >= 0.45 && candle.close <= candle.low + range * 0.4;
  const isPinbarSell = candle.close <= candle.low + range * 0.25;
  return isMomentumSell || isPinbarSell;
}

function isMomentumRecovering(candles: Candle[], direction: "BUY" | "SELL"): boolean {
  if (candles.length < 4) return false;
  const recent = candles.slice(-4);
  const previousMove = recent[2]!.close - recent[0]!.open;
  const latestMove = recent[3]!.close - recent[2]!.open;
  return direction === "BUY"
    ? latestMove > 0 || latestMove > previousMove
    : latestMove < 0 || latestMove < previousMove;
}

function bollingerBands(
  values: number[],
  period: number,
  multiplier: number,
): { middle: number; upper: number; lower: number } | null {
  const clean = values.filter(Number.isFinite);
  if (clean.length < period) return null;
  const recent = clean.slice(-period);
  const middle = recent.reduce((sum, value) => sum + value, 0) / period;
  const variance = recent.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const stdev = Math.sqrt(variance);
  return {
    middle: round(middle),
    upper: round(middle + multiplier * stdev),
    lower: round(middle - multiplier * stdev),
  };
}

// RSI cục bộ (giữ nguyên công thức cũ) — tách riêng để không phụ thuộc export rsi() dùng chỗ khác.
function rsiLocal(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const changes: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i];
    const prev = values[i - 1];
    if (current !== undefined && prev !== undefined) changes.push(current - prev);
  }
  let gains = 0;
  let losses = 0;
  for (let i = 0; i < period; i += 1) {
    const change = changes[i] ?? 0;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
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

// Số chữ số thập phân theo độ lớn giá: XAUUSD (~hàng trăm/nghìn) dùng 3 số,
// EURUSD (~1.0x) cần 5 số để giữ độ chính xác pip lẻ. Cùng quy ước với
// roundPrice() trong AutoTradeRunner.ts.
function round(value: number, digits?: number): number {
  const d = digits ?? (Math.abs(value) >= 100 ? 3 : 5);
  return Number(value.toFixed(d));
}

/**
 * ==========================================================================
 * PHẦN 2 — XAUUSD PRICE ACTION RULEBOOK v0.2 "Frequency Mode" (KHÔNG dùng ATR)
 * H1 Bias (chính) + H4 context → Setup A (Sweep Reversal) hoặc Setup B (BOS
 * Continuation, không cần sweep) → Retest zone (M15) → M5 trigger → Entry →
 * SL cấu trúc → TP cố định 2R (có gate cản đối diện) → session 08:00-18:00Z.
 * ==========================================================================
 *
 * v0.2 (2026-08): thay v0.1 — v0.1 (H4 hard gate + 1 setup + session 2 khung
 * hẹp) vẫn quá ít lệnh. v0.2 đổi bias chính sang H1 (khung nhỏ hơn, đổi
 * hướng thường xuyên hơn H4), hạ H4 xuống làm CONTEXT FILTER (chỉ chặn khi
 * H4 chống lại hướng H1, không chặn khi H4 NEUTRAL), thêm Setup B (BOS
 * continuation — không cần liquidity sweep trước, chỉ cần M15 đóng phá
 * swing bằng buffer), nới M5 trigger thành rejection/engulfing/strong-close
 * (thay vì chỉ rejection), và mở rộng session ra 08:00-18:00 UTC (thay 2
 * khung hẹp 08-10:30/13-16h). Setup A và Setup B được gắn nhãn riêng
 * (setupKind trong reason) để KHÔNG trộn thống kê khi đánh giá kết quả.
 *
 * Lưu ý lệch giữa mô tả (§2 gốc: "H4 NEUTRAL → chỉ dùng Setup A") và pseudocode
 * "Final" cuối bản gốc (chỉ chặn khi H4 NGƯỢC hướng, không phân biệt Setup A/B
 * theo trạng thái H4 NEUTRAL) — code này theo đúng pseudocode "Final" (coi đó
 * là bản chốt cuối), nghĩa là H4 NEUTRAL cho phép CẢ Setup A và B.
 *
 * Bỏ so với v0.1: H4 làm bias chính (nay chỉ context). Vẫn giữ: không ATR ở
 * bất kỳ công thức nào, session/news evaluated tại đúng nến M5 trigger (không
 * cache), M15_BOS_CONFIRMED là nguồn sự thật duy nhất cho "phá cấu trúc",
 * setup hủy nếu giá M15 đóng xuyên ngược qua BOS hoặc có BOS ngược hướng sau.
 */

export type IctSessionLabel =
  | "ASIA"
  | "LONDON_OPEN"
  | "LONDON_CONTINUATION"
  | "LONDON_NY_OVERLAP"
  | "NY_LATE"
  | "ROLLOVER_LOW_PRIORITY";

export type IctSetupKind = "SWEEP_REVERSAL" | "BOS_CONTINUATION";

export interface XauIctConfig {
  symbolLabel: "XAUUSD";
  priceDigits: number;
  /** Số nến xác nhận swing mỗi bên (2/2 theo baseline). */
  swingConfirmBars: number;
  /** Setup A (sweep reversal): thân/range tối thiểu + close-position của nến displacement. */
  displacementBodyRangeRatioA: number;
  displacementClosePositionMaxA: number;
  /** Displacement (Setup A) phải xuất hiện trong tối đa N nến M15 sau sweep. */
  displacementExpiryM15Bars: number;
  /** Setup B (BOS continuation, không cần sweep): ngưỡng nới hơn Setup A. */
  displacementBodyRangeRatioB: number;
  displacementClosePositionMaxB: number;
  /**
   * Buffer giá CỐ ĐỊNH theo symbol/broker — dùng cho cả BOS_BUFFER và
   * SL_BUFFER: buffer = max(spread × bufferSpreadMult, fixedPriceBuffer).
   * 0.20 (giá XAUUSD) chỉ là baseline test, KHÔNG phải số tối ưu — cần kiểm
   * định lại theo dữ liệu broker thật.
   */
  fixedPriceBuffer: number;
  bufferSpreadMult: number;
  /** Ngưỡng CỐ ĐỊNH (giá) coi 2 swing cùng phía là "Equal High/Low". */
  equalLevelToleranceFixed: number;
  /** Retest zone = [BOS_LEVEL, BOS_LEVEL + zoneBodyFraction × thân nến displacement] (BUY, đối xứng cho SELL). */
  zoneBodyFraction: number;
  /** Retest phải xảy ra trong tối đa N nến M5 sau khi displacement đóng. */
  retestExpiryM5Bars: number;
  /** M5 trigger: close phải nằm trong X% ngoài cùng range (rejection/strong-close). */
  m5TriggerClosePositionMax: number;
  /** M5 engulfing: thân nến trigger phải >= mult × thân nến trước. */
  m5EngulfingBodyMult: number;
  /** M5 strong-close: thân/range tối thiểu (không cần wick dài như rejection). */
  m5StrongCloseBodyRatio: number;
  /** RR tối thiểu — cũng là bội số R dùng làm TP MẶC ĐỊNH (Entry ± minTargetR×R). */
  minTargetR: number;
  /** Spread dùng khi caller không truyền spread thực tế. */
  defaultSpreadPrice: number;
}

export const defaultXauIctConfig: XauIctConfig = {
  symbolLabel: "XAUUSD",
  priceDigits: 3,
  swingConfirmBars: 2,
  displacementBodyRangeRatioA: 0.6,
  displacementClosePositionMaxA: 0.2,
  displacementExpiryM15Bars: 5,
  displacementBodyRangeRatioB: 0.55,
  displacementClosePositionMaxB: 0.25,
  fixedPriceBuffer: 0.2,
  bufferSpreadMult: 2,
  equalLevelToleranceFixed: 0.2,
  zoneBodyFraction: 0.5,
  retestExpiryM5Bars: 8,
  m5TriggerClosePositionMax: 0.3,
  m5EngulfingBodyMult: 1.0,
  m5StrongCloseBodyRatio: 0.6,
  minTargetR: 2.0,
  defaultSpreadPrice: 0.3,
};

export interface XauIctEvaluationOptions {
  /** Thời điểm đóng nến M5 trigger. Mặc định = new Date(). */
  now?: Date;
  /**
   * Đã tính SẴN bởi caller (vd AutoTradeRunner qua newsBlackoutBlockReason)
   * tại đúng `now`. KHÔNG cache từ thời điểm sweep/displacement.
   */
  newsWindowClear?: boolean;
  /** Spread giá thực tế (nếu có) để tính BOS_BUFFER/SL_BUFFER. */
  spreadPrice?: number;
}

/**
 * Session UTC v0.2 (§6): cho phép giao dịch 08:00-18:00 UTC (4 khung con,
 * TẤT CẢ đều allowed=true — nhãn con chỉ để ghi log/ưu tiên, KHÔNG dùng làm
 * hard gate riêng). Chặn 00:00-08:00 và 18:00-24:00. Cần kiểm định lại theo
 * dữ liệu broker thật (spread/thanh khoản thực tế) trước khi coi là cố định.
 */
export function resolveIctSession(date: Date): { label: IctSessionLabel; allowed: boolean } {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (utcMinutes < 480) return { label: "ASIA", allowed: false };
  if (utcMinutes < 630) return { label: "LONDON_OPEN", allowed: true };
  if (utcMinutes < 780) return { label: "LONDON_CONTINUATION", allowed: true };
  if (utcMinutes < 960) return { label: "LONDON_NY_OVERLAP", allowed: true };
  if (utcMinutes < 1080) return { label: "NY_LATE", allowed: true };
  return { label: "ROLLOVER_LOW_PRIORITY", allowed: false };
}

export function evaluateXauIctSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[] = [],
  config: XauIctConfig = defaultXauIctConfig,
  options: XauIctEvaluationOptions = {},
): RuleSignal | null {
  return buildXauIctSignal(m5, m15, h1, h4, config, options).signal;
}

export function explainXauIctRejection(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[] = [],
  config: XauIctConfig = defaultXauIctConfig,
  options: XauIctEvaluationOptions = {},
): string {
  return buildXauIctSignal(m5, m15, h1, h4, config, options).reason;
}

type IctDirection = "BUY" | "SELL";
type TrendBias = "BULLISH" | "BEARISH" | "NEUTRAL";

interface SwingPoint {
  side: "HIGH" | "LOW";
  price: number;
  index: number;
}

type LiquidityKind =
  | "PDH"
  | "PDL"
  | "ASIA_HIGH"
  | "ASIA_LOW"
  | "EQUAL_HIGH"
  | "EQUAL_LOW"
  | "SWING_HIGH"
  | "SWING_LOW";

interface LiquidityLevel {
  kind: LiquidityKind;
  side: "HIGH" | "LOW";
  price: number;
}

interface ChainResult {
  setupKind: IctSetupKind;
  sweepIndex: number | null;
  sweepLevel: LiquidityLevel | null;
  displacementIndex: number;
  swingRef: number;
}

/** Chuỗi tối đa cần quét lùi để tìm sweep còn "sống" (chưa hết hạn displacement). */
const MAX_CHAIN_LOOKBACK_M15 = 12;

function buildXauIctSignal(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[],
  config: XauIctConfig,
  options: XauIctEvaluationOptions,
): { signal: RuleSignal | null; reason: string } {
  const now = options.now ?? new Date();
  const spreadPrice = options.spreadPrice ?? config.defaultSpreadPrice;
  const newsWindowClear = options.newsWindowClear ?? true;

  const minM15 = config.swingConfirmBars * 2 + Math.max(config.displacementExpiryM15Bars, MAX_CHAIN_LOOKBACK_M15) + 30;
  if (m15.length < minM15) {
    return { signal: null, reason: `ICT blocked: M15 candles ${m15.length} < ${minM15}` };
  }
  if (h1.length < config.swingConfirmBars * 2 + 8) {
    return { signal: null, reason: `ICT blocked: H1 candles ${h1.length} too short for swing bias` };
  }
  if (m5.length < 2) {
    return { signal: null, reason: `ICT blocked: M5 candles ${m5.length} < 2` };
  }

  // ===== 1) H1 BIAS chính (§2) + H4 context filter =====
  const h1Bias = resolveTrendBias(h1, config.swingConfirmBars);
  if (h1Bias === "NEUTRAL") {
    return { signal: null, reason: "ICT blocked: H1 bias NEUTRAL (chưa có chuỗi HH/HL hoặc LL/LH rõ)" };
  }
  const direction: IctDirection = h1Bias === "BULLISH" ? "BUY" : "SELL";
  const h4Bias: TrendBias =
    h4.length >= config.swingConfirmBars * 2 + 8 ? resolveTrendBias(h4, config.swingConfirmBars) : "NEUTRAL";
  const h4Opposes =
    (direction === "BUY" && h4Bias === "BEARISH") || (direction === "SELL" && h4Bias === "BULLISH");
  if (h4Opposes) {
    return {
      signal: null,
      reason: `ICT blocked: H4 ${h4Bias} ngược hướng H1 ${h1Bias} (context filter chặn cả Setup A và B)`,
    };
  }

  // ===== 2) Key liquidity + Setup A (sweep reversal) hoặc Setup B (BOS continuation) (§3-5) =====
  const m15Swings = findConfirmedSwings(m15, config.swingConfirmBars);
  const liquidityLevels = collectKeyLiquidity(m15, h1, m15Swings, config);
  const chain =
    findSweepReversalChain(m15, liquidityLevels, direction, config, spreadPrice) ??
    findBosContinuationChain(m15, direction, config, spreadPrice);
  if (!chain) {
    return {
      signal: null,
      reason:
        `ICT blocked: không tìm được Setup A (sweep+displacement+BOS) hoặc Setup B ` +
        `(BOS continuation, không cần sweep) cho ${direction} khớp H1 ${h1Bias}`,
    };
  }

  // ===== 3) Setup invalidation (§8) — BOS bị phá ngược hoặc có BOS ngược hướng sau đó =====
  const invalidReason = checkChainInvalidated(m15, chain, direction, config, spreadPrice);
  if (invalidReason) {
    return { signal: null, reason: `ICT blocked: ${invalidReason}` };
  }

  // ===== 4) Retest zone + M5 trigger (rejection/engulfing/strong-close) trong tối đa retestExpiryM5Bars nến =====
  const zone = resolveEntryZone(direction, chain, m15, config);
  if (!zone) {
    return { signal: null, reason: "ICT blocked: không dựng được retest zone (thiếu nến displacement)" };
  }
  const displacementCandle = m15[chain.displacementIndex];
  if (!displacementCandle) {
    return { signal: null, reason: "ICT blocked: displacement candle missing" };
  }
  const zoneCreatedAt = displacementCandle.time;
  const m5SinceZone = m5.filter((candle) => candle.time > zoneCreatedAt);
  if (m5SinceZone.length === 0) {
    return { signal: null, reason: "ICT blocked: chưa có nến M5 nào sau khi displacement đóng" };
  }
  if (m5SinceZone.length > config.retestExpiryM5Bars) {
    return {
      signal: null,
      reason: `ICT blocked: retest quá hạn (${m5SinceZone.length} nến M5 > ${config.retestExpiryM5Bars})`,
    };
  }
  const lastM5 = m5.at(-1);
  const prevM5 = m5.at(-2);
  if (!lastM5) return { signal: null, reason: "ICT blocked: missing M5 candle" };
  const triggerType = resolveM5TriggerType(lastM5, prevM5, zone, direction, config);
  if (!triggerType) {
    return {
      signal: null,
      reason: `ICT blocked: nến M5 hiện tại không phải valid ${direction} trigger (rejection/engulfing/strong-close) trong retest zone [${zone.low.toFixed(config.priceDigits)}, ${zone.high.toFixed(config.priceDigits)}]`,
    };
  }
  const entry = lastM5.close;

  // ===== 5) SL cấu trúc (§8) =====
  const slResult = resolveStopLoss(direction, entry, chain, zone, m15, spreadPrice, config);
  if (!slResult) {
    return { signal: null, reason: "ICT blocked: SL không hợp lệ (khoảng cách <= 0)" };
  }
  const stopLoss = direction === "BUY" ? entry - slResult.distance : entry + slResult.distance;

  // ===== 6) TP cố định minTargetR×R — chỉ chặn nếu có cản GẦN HƠN target (§8) =====
  const tpResult = resolveTakeProfit(direction, entry, slResult.distance, liquidityLevels, config);
  if (!tpResult) {
    return {
      signal: null,
      reason: `ICT blocked: cản đối diện gần hơn ${config.minTargetR}R — target mặc định không khả thi`,
    };
  }

  // ===== 7) Final-time gates — đánh giá LẠI tại đúng lúc đóng nến M5 hiện tại (§6/§9) =====
  const session = resolveIctSession(now);
  if (!session.allowed) {
    return {
      signal: null,
      reason: `ICT blocked: trigger rơi vào session ${session.label} (chỉ cho phép 08:00-18:00 UTC)`,
    };
  }
  if (!newsWindowClear) {
    return { signal: null, reason: "ICT blocked: trigger rơi vào news blackout window" };
  }

  const sweepNote = chain.sweepLevel ? `sweep@${chain.sweepLevel.kind}, ` : "";
  return {
    signal: {
      direction,
      entry: roundIct(entry, config.priceDigits),
      stopLoss: roundIct(stopLoss, config.priceDigits),
      takeProfit: roundIct(tpResult.takeProfit, config.priceDigits),
      reason:
        `${config.symbolLabel} PA v0.2 [${chain.setupKind}]: H1 ${h1Bias}, H4 ${h4Bias}, ${sweepNote}` +
        `displacement+M15_BOS_CONFIRMED, retest zone [${zone.low.toFixed(config.priceDigits)}, ${zone.high.toFixed(config.priceDigits)}], ` +
        `M5 ${triggerType}, RR ${tpResult.rr.toFixed(2)}, session ${session.label}.`,
      strategyKind: "ICT_SETUP",
    },
    reason: "PA setup found",
  };
}

/**
 * Swing chỉ hợp lệ sau khi có đủ `confirmBars` nến bên phải xác nhận (§4.1).
 * Truyền `candles.slice(0, X)` trước khi gọi để đảm bảo không nhìn thấy swing
 * hình thành SAU thời điểm đang xét (chống lookahead bias).
 */
function findConfirmedSwings(candles: Candle[], confirmBars: number): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = confirmBars; i < candles.length - confirmBars; i += 1) {
    const current = candles[i];
    if (!current) continue;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= confirmBars; k += 1) {
      const left = candles[i - k];
      const right = candles[i + k];
      if (!left || !right) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (!(current.high > left.high && current.high >= right.high)) isHigh = false;
      if (!(current.low < left.low && current.low <= right.low)) isLow = false;
    }
    if (isHigh) swings.push({ side: "HIGH", price: current.high, index: i });
    if (isLow) swings.push({ side: "LOW", price: current.low, index: i });
  }
  return swings;
}

/**
 * Trend bias theo HH/HL (bullish) hoặc LL/LH (bearish); mâu thuẫn/thiếu dữ
 * liệu -> NEUTRAL (§2 v0.2). Dùng chung cho H1 (bias chính) và H4 (context).
 */
function resolveTrendBias(candles: Candle[], confirmBars: number): TrendBias {
  const swings = findConfirmedSwings(candles, confirmBars);
  const highs = swings.filter((s) => s.side === "HIGH");
  const lows = swings.filter((s) => s.side === "LOW");
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";
  const lastHigh = highs[highs.length - 1]!;
  const prevHigh = highs[highs.length - 2]!;
  const lastLow = lows[lows.length - 1]!;
  const prevLow = lows[lows.length - 2]!;
  const lastClose = candles.at(-1)?.close;
  if (lastClose === undefined) return "NEUTRAL";

  const higherHigh = lastHigh.price > prevHigh.price;
  const higherLow = lastLow.price > prevLow.price;
  const lowerLow = lastLow.price < prevLow.price;
  const lowerHigh = lastHigh.price < prevHigh.price;

  if (higherHigh && higherLow && lastClose >= lastLow.price) return "BULLISH";
  if (lowerLow && lowerHigh && lastClose <= lastHigh.price) return "BEARISH";
  return "NEUTRAL";
}

function utcDayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** High/Low của ngày UTC hoàn chỉnh gần nhất TRƯỚC ngày của nến M15 cuối (§5.1 PDH/PDL). */
function previousDayHighLow(m15: Candle[]): { high: number; low: number } | null {
  const last = m15.at(-1);
  if (!last) return null;
  const todayKey = utcDayKey(last.time);
  let prevKey: string | null = null;
  for (let i = m15.length - 1; i >= 0; i -= 1) {
    const key = utcDayKey(m15[i]!.time);
    if (key < todayKey) {
      prevKey = key;
      break;
    }
  }
  if (!prevKey) return null;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const candle of m15) {
    if (utcDayKey(candle.time) !== prevKey) continue;
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low };
}

/** High/Low phiên Á 00:00-08:00 UTC của ngày UTC hiện tại (§5.1 Asia High/Low). */
function asiaHighLow(m15: Candle[]): { high: number; low: number } | null {
  const last = m15.at(-1);
  if (!last) return null;
  const todayKey = utcDayKey(last.time);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let count = 0;
  for (const candle of m15) {
    if (utcDayKey(candle.time) !== todayKey) continue;
    if (new Date(candle.time).getUTCHours() >= 8) continue;
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
    count += 1;
  }
  if (count < 3 || !Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low };
}

/** Hai swing cùng phía cách nhau <= tolerance -> "Equal High/Low" (§5.1). */
function findEqualLevels(swings: SwingPoint[], side: "HIGH" | "LOW", toleranceAbs: number): LiquidityLevel[] {
  if (toleranceAbs <= 0) return [];
  const points = swings.filter((s) => s.side === side);
  const levels: LiquidityLevel[] = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i]!;
      const b = points[j]!;
      if (Math.abs(a.price - b.price) <= toleranceAbs) {
        const price = side === "HIGH" ? Math.max(a.price, b.price) : Math.min(a.price, b.price);
        levels.push({ kind: side === "HIGH" ? "EQUAL_HIGH" : "EQUAL_LOW", side, price });
      }
    }
  }
  return levels;
}

function collectKeyLiquidity(
  m15: Candle[],
  h1: Candle[],
  m15Swings: SwingPoint[],
  config: XauIctConfig,
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];

  const pdhl = previousDayHighLow(m15);
  if (pdhl) {
    levels.push({ kind: "PDH", side: "HIGH", price: pdhl.high });
    levels.push({ kind: "PDL", side: "LOW", price: pdhl.low });
  }
  const asia = asiaHighLow(m15);
  if (asia) {
    levels.push({ kind: "ASIA_HIGH", side: "HIGH", price: asia.high });
    levels.push({ kind: "ASIA_LOW", side: "LOW", price: asia.low });
  }

  levels.push(...findEqualLevels(m15Swings, "HIGH", config.equalLevelToleranceFixed));
  levels.push(...findEqualLevels(m15Swings, "LOW", config.equalLevelToleranceFixed));

  for (const swing of m15Swings) {
    levels.push({
      kind: swing.side === "HIGH" ? "SWING_HIGH" : "SWING_LOW",
      side: swing.side,
      price: swing.price,
    });
  }

  if (h1.length >= config.swingConfirmBars * 2 + 1) {
    const h1Swings = findConfirmedSwings(h1, config.swingConfirmBars);
    for (const swing of h1Swings) {
      levels.push({
        kind: swing.side === "HIGH" ? "SWING_HIGH" : "SWING_LOW",
        side: swing.side,
        price: swing.price,
      });
    }
  }

  return levels;
}

/** Sweep bullish/bearish (§3) — v0.1 không còn ràng buộc độ sâu (không có ATR để chuẩn hóa). */
function checkBullishSweep(candle: Candle, level: LiquidityLevel): boolean {
  if (level.side !== "LOW") return false;
  return candle.low < level.price && candle.close > level.price;
}

function checkBearishSweep(candle: Candle, level: LiquidityLevel): boolean {
  if (level.side !== "HIGH") return false;
  return candle.high > level.price && candle.close < level.price;
}

/** PDH/PDL/Asia được ưu tiên hơn Equal High/Low, ưu tiên hơn swing thường (khi 1 nến quét trúng nhiều mức). */
function rankLiquidityKind(kind: LiquidityKind): number {
  if (kind === "PDH" || kind === "PDL" || kind === "ASIA_HIGH" || kind === "ASIA_LOW") return 2;
  if (kind === "EQUAL_HIGH" || kind === "EQUAL_LOW") return 1;
  return 0;
}

/** Buffer giá dùng chung cho BOS_BUFFER và SL_BUFFER: max(spread×mult, buffer cố định) (§4, §8). */
function resolveBuffer(spreadPrice: number, config: XauIctConfig): number {
  return Math.max(spreadPrice * config.bufferSpreadMult, config.fixedPriceBuffer);
}

/**
 * Displacement candle (§4/§5) — chỉ điều kiện SỨC MẠNH nến, không còn ràng
 * buộc theo ATR. bodyRangeRatio/closePositionMax truyền riêng cho Setup A
 * (chặt, 0.60/0.20) hoặc Setup B (nới hơn, 0.55/0.25).
 */
function isDisplacementCandle(
  candle: Candle,
  direction: IctDirection,
  bodyRangeRatio: number,
  closePositionMax: number,
): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  if (body / range < bodyRangeRatio) return false;
  if (direction === "BUY") {
    if (candle.close <= candle.open) return false;
    return (candle.high - candle.close) / range <= closePositionMax;
  }
  if (candle.close >= candle.open) return false;
  return (candle.close - candle.low) / range <= closePositionMax;
}

/** Swing tham chiếu cho BOS = swing đã CONFIRMED trước displacementIndex (chống lookahead). */
function resolveBosSwingRef(
  m15: Candle[],
  displacementIndex: number,
  direction: IctDirection,
  config: XauIctConfig,
): number | null {
  const priorSwings = findConfirmedSwings(m15.slice(0, displacementIndex), config.swingConfirmBars);
  const side = direction === "BUY" ? "HIGH" : "LOW";
  const relevant = priorSwings.filter((s) => s.side === side);
  if (relevant.length === 0) return null;
  return relevant[relevant.length - 1]!.price;
}

/** M15_BOS_CONFIRMED (§4) — nguồn sự thật DUY NHẤT cho "phá cấu trúc" trong v0.1. */
function checkBos(
  m15: Candle[],
  displacementIndex: number,
  direction: IctDirection,
  spreadPrice: number,
  config: XauIctConfig,
): { confirmed: boolean; swingRef: number | null } {
  const candle = m15[displacementIndex];
  if (!candle) return { confirmed: false, swingRef: null };
  const swingRef = resolveBosSwingRef(m15, displacementIndex, direction, config);
  if (swingRef === null) return { confirmed: false, swingRef: null };
  const buffer = resolveBuffer(spreadPrice, config);
  const confirmed = direction === "BUY" ? candle.close > swingRef + buffer : candle.close < swingRef - buffer;
  return { confirmed, swingRef };
}

/**
 * Setup A — Sweep Reversal (§4). Quét lùi tối đa MAX_CHAIN_LOOKBACK_M15 nến
 * để tìm sweep còn "sống": sweep xong displacement+BOS phải xảy ra trong
 * displacementExpiryM15Bars nến kế. Trả về chuỗi GẦN HIỆN TẠI nhất tìm được.
 */
function findSweepReversalChain(
  m15: Candle[],
  liquidityLevels: LiquidityLevel[],
  direction: IctDirection,
  config: XauIctConfig,
  spreadPrice: number,
): ChainResult | null {
  const startIdx = Math.max(1, m15.length - 1 - MAX_CHAIN_LOOKBACK_M15 - config.displacementExpiryM15Bars);
  const candidateLevels = direction === "BUY" ? liquidityLevels.filter((l) => l.side === "LOW") : liquidityLevels.filter((l) => l.side === "HIGH");

  for (let sweepIdx = m15.length - 2; sweepIdx >= startIdx; sweepIdx -= 1) {
    const candle = m15[sweepIdx];
    if (!candle) continue;

    let sweptLevel: LiquidityLevel | null = null;
    for (const level of candidateLevels) {
      const ok = direction === "BUY" ? checkBullishSweep(candle, level) : checkBearishSweep(candle, level);
      if (ok && (!sweptLevel || rankLiquidityKind(level.kind) > rankLiquidityKind(sweptLevel.kind))) {
        sweptLevel = level;
      }
    }
    if (!sweptLevel) continue;

    const maxDisplacementIdx = Math.min(m15.length - 1, sweepIdx + config.displacementExpiryM15Bars);
    for (let dIdx = sweepIdx + 1; dIdx <= maxDisplacementIdx; dIdx += 1) {
      const dCandle = m15[dIdx];
      if (!dCandle) continue;
      if (!isDisplacementCandle(dCandle, direction, config.displacementBodyRangeRatioA, config.displacementClosePositionMaxA)) continue;
      const bos = checkBos(m15, dIdx, direction, spreadPrice, config);
      if (!bos.confirmed || bos.swingRef === null) continue;
      return {
        setupKind: "SWEEP_REVERSAL",
        sweepIndex: sweepIdx,
        sweepLevel: sweptLevel,
        displacementIndex: dIdx,
        swingRef: bos.swingRef,
      };
    }
  }
  return null;
}

/**
 * Setup B — BOS Continuation (§5). KHÔNG cần liquidity sweep trước — chỉ cần
 * M15 đóng phá swing gần nhất bằng buffer, dùng ngưỡng displacement nới hơn
 * Setup A. Quét lùi tối đa MAX_CHAIN_LOOKBACK_M15 nến, trả về gần hiện tại nhất.
 */
function findBosContinuationChain(
  m15: Candle[],
  direction: IctDirection,
  config: XauIctConfig,
  spreadPrice: number,
): ChainResult | null {
  const startIdx = Math.max(1, m15.length - 1 - MAX_CHAIN_LOOKBACK_M15);
  for (let dIdx = m15.length - 1; dIdx >= startIdx; dIdx -= 1) {
    const dCandle = m15[dIdx];
    if (!dCandle) continue;
    if (!isDisplacementCandle(dCandle, direction, config.displacementBodyRangeRatioB, config.displacementClosePositionMaxB)) continue;
    const bos = checkBos(m15, dIdx, direction, spreadPrice, config);
    if (!bos.confirmed || bos.swingRef === null) continue;
    return {
      setupKind: "BOS_CONTINUATION",
      sweepIndex: null,
      sweepLevel: null,
      displacementIndex: dIdx,
      swingRef: bos.swingRef,
    };
  }
  return null;
}

/**
 * Setup hết hiệu lực (§8) nếu: (a) M15 đã đóng xuyên NGƯỢC qua chính mức BOS
 * vừa phá, hoặc (b) xuất hiện displacement + M15 BOS NGƯỢC hướng sau đó — quét
 * các nến từ displacementIndex+1 tới hiện tại cho cả hai điều kiện (dùng
 * ngưỡng displacement Setup A làm định nghĩa "BOS ngược hướng" chuẩn).
 */
function checkChainInvalidated(
  m15: Candle[],
  chain: ChainResult,
  direction: IctDirection,
  config: XauIctConfig,
  spreadPrice: number,
): string | null {
  const opposite: IctDirection = direction === "BUY" ? "SELL" : "BUY";
  for (let i = chain.displacementIndex + 1; i < m15.length; i += 1) {
    const candle = m15[i];
    if (!candle) continue;
    if (direction === "BUY" && candle.close < chain.swingRef) {
      return `giá M15 đã đóng (${candle.close.toFixed(config.priceDigits)}) xuyên ngược dưới mức BOS (${chain.swingRef.toFixed(config.priceDigits)})`;
    }
    if (direction === "SELL" && candle.close > chain.swingRef) {
      return `giá M15 đã đóng (${candle.close.toFixed(config.priceDigits)}) xuyên ngược trên mức BOS (${chain.swingRef.toFixed(config.priceDigits)})`;
    }
    if (
      isDisplacementCandle(candle, opposite, config.displacementBodyRangeRatioA, config.displacementClosePositionMaxA) &&
      checkBos(m15, i, opposite, spreadPrice, config).confirmed
    ) {
      return `xuất hiện displacement + M15 BOS ngược hướng (${opposite}) sau displacement của ta`;
    }
  }
  return null;
}

/** Retest zone (§6): [BOS_LEVEL, BOS_LEVEL + zoneBodyFraction×thân nến displacement] (BUY), đối xứng cho SELL. */
function resolveEntryZone(
  direction: IctDirection,
  chain: ChainResult,
  m15: Candle[],
  config: XauIctConfig,
): { low: number; high: number } | null {
  const displacementCandle = m15[chain.displacementIndex];
  if (!displacementCandle) return null;
  const body = Math.abs(displacementCandle.close - displacementCandle.open);
  const bosLevel = chain.swingRef;
  if (direction === "BUY") {
    return { low: bosLevel, high: bosLevel + config.zoneBodyFraction * body };
  }
  return { low: bosLevel - config.zoneBodyFraction * body, high: bosLevel };
}

/**
 * M5 trigger (§4/§5): rejection HOẶC engulfing HOẶC strong-close — cả ba đều
 * phải nằm trong retest zone (§9 "Entry phải nằm trong vùng retest hợp lệ").
 * rejection = wick dài + close ở mép ngoài range; engulfing = phá thân nến
 * trước; strong-close = thân lớn đóng sát mép range (không cần wick dài).
 */
type M5TriggerType = "rejection" | "engulfing" | "strong_close";

function resolveM5TriggerType(
  last: Candle,
  prev: Candle | undefined,
  zone: { low: number; high: number },
  direction: IctDirection,
  config: XauIctConfig,
): M5TriggerType | null {
  const range = last.high - last.low;
  if (range <= 0) return null;
  const body = Math.abs(last.close - last.open);
  const prevBody = prev ? Math.abs(prev.close - prev.open) : 0;

  if (direction === "BUY") {
    const touchesZone = last.low <= zone.high && last.close >= zone.low;
    if (!touchesZone) return null;
    if (last.close <= last.open) return null;
    const closePos = (last.high - last.close) / range;
    const lowerWick = Math.min(last.open, last.close) - last.low;
    if (lowerWick >= 1.5 * Math.max(body, 1e-9) && closePos <= config.m5TriggerClosePositionMax) return "rejection";
    if (prev && last.close > prev.high && body >= config.m5EngulfingBodyMult * prevBody) return "engulfing";
    if (body / range >= config.m5StrongCloseBodyRatio && closePos <= config.m5TriggerClosePositionMax) return "strong_close";
    return null;
  }

  const touchesZone = last.high >= zone.low && last.close <= zone.high;
  if (!touchesZone) return null;
  if (last.close >= last.open) return null;
  const closePos = (last.close - last.low) / range;
  const upperWick = last.high - Math.max(last.open, last.close);
  if (upperWick >= 1.5 * Math.max(body, 1e-9) && closePos <= config.m5TriggerClosePositionMax) return "rejection";
  if (prev && last.close < prev.low && body >= config.m5EngulfingBodyMult * prevBody) return "engulfing";
  if (body / range >= config.m5StrongCloseBodyRatio && closePos <= config.m5TriggerClosePositionMax) return "strong_close";
  return null;
}

/**
 * SL (§8) = min/max(SweepLow/High, ZoneLow/High) ∓ buffer — Setup B không có
 * sweep nên chỉ dùng ZoneLow/High. Không ràng buộc SL-distance theo ATR: zone
 * (50% thân displacement quanh BOS_LEVEL) đã tự nhiên giữ entry gần cấu trúc.
 */
function resolveStopLoss(
  direction: IctDirection,
  entry: number,
  chain: ChainResult,
  zone: { low: number; high: number },
  m15: Candle[],
  spreadPrice: number,
  config: XauIctConfig,
): { stopLoss: number; distance: number } | null {
  const sweepCandle = chain.sweepIndex !== null ? m15[chain.sweepIndex] : null;
  const buffer = resolveBuffer(spreadPrice, config);

  if (direction === "BUY") {
    const base = sweepCandle ? Math.min(sweepCandle.low, zone.low) : zone.low;
    const stopLoss = base - buffer;
    const distance = entry - stopLoss;
    if (!Number.isFinite(distance) || distance <= 0) return null;
    return { stopLoss, distance };
  }

  const base = sweepCandle ? Math.max(sweepCandle.high, zone.high) : zone.high;
  const stopLoss = base + buffer;
  const distance = stopLoss - entry;
  if (!Number.isFinite(distance) || distance <= 0) return null;
  return { stopLoss, distance };
}

/**
 * TP (§8) MẶC ĐỊNH cố định = Entry ± minTargetR×R (KHÔNG phải giá cấu trúc).
 * Cản đối diện chỉ là GATE: mốc gần nhất trong lookback gần hơn target cố
 * định → từ chối (target không khả thi); không có mốc nào trong lookback =
 * không có gì được biết để chặn = PASS (rất thường xảy ra lúc trend mạnh,
 * không phải trường hợp hiếm — xem ghi chú đầu PHẦN 2).
 */
function resolveTakeProfit(
  direction: IctDirection,
  entry: number,
  slDistance: number,
  liquidityLevels: LiquidityLevel[],
  config: XauIctConfig,
): { takeProfit: number; rr: number } | null {
  const requiredDistance = slDistance * config.minTargetR;
  const takeProfit = direction === "BUY" ? entry + requiredDistance : entry - requiredDistance;

  const oppositeSide = direction === "BUY" ? "HIGH" : "LOW";
  const candidates = liquidityLevels
    .filter((level) => level.side === oppositeSide)
    .filter((level) => (direction === "BUY" ? level.price > entry : level.price < entry));
  if (candidates.length === 0) return { takeProfit, rr: config.minTargetR };

  const nearest =
    direction === "BUY"
      ? Math.min(...candidates.map((level) => level.price))
      : Math.max(...candidates.map((level) => level.price));
  const nearestDistance = direction === "BUY" ? nearest - entry : entry - nearest;
  if (!Number.isFinite(nearestDistance) || nearestDistance < requiredDistance) return null;
  return { takeProfit, rr: config.minTargetR };
}

function roundIct(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
