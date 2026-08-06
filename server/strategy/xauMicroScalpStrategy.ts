import type { Candle } from "../../types/trading";
import { atr, ema, rsi } from "../utils/indicators";
import {
  defaultTrendDayFilterConfig,
  resolveTrendDayBlock,
} from "./trendDayFilter";

/**
 * Micro-scalp M1 cho acc nhỏ (XAU hoặc EURUSD).
 * SL khó quét: clamp(max(ATR×slAtrMult, ngoài-swing+đệm), min, max) — trần 6.
 * TP ưu tiên cấu trúc M5, fallback SL × rrTarget (strongRr) → RR ~1.2–1.5.
 * Bias H1 EMA50 + M15 cùng hướng EMA50 (nới bằng band ±k×ATR) + trigger nến M1.
 *
 * Đơn vị:
 * - XAUUSD: điểm giá (1.0 ≈ 1 USD)
 * - EURUSD: giá tuyệt đối theo pip 0.0001 (5 pip = 0.0005)
 */
export interface XauMicroScalpConfig {
  symbolLabel: "XAUUSD" | "EURUSD";
  priceDigits: number;
  /** Chu kỳ ATR dùng cho cả SL sizing lẫn band M15. */
  atrPeriod: number;
  /** SL = clamp(max(ATR(M1) × slAtrMult, khoảng-cấu-trúc), minSlDistance, maxSlDistance). */
  slAtrMult: number;
  minSlDistance: number;
  maxSlDistance: number;
  /** Số nến M1 lấy swing high/low để đặt SL ngoài cấu trúc gần nhất. */
  slSwingLookback: number;
  /** Đệm SL ngoài swing = ATR(M1) × slSwingBufferAtrMult. */
  slSwingBufferAtrMult: number;
  /** TP = SL × rrTarget (setup thường) hoặc × strongRr (setup mạnh). Dùng làm fallback. */
  rrTarget: number;
  strongRr: number;
  /** RR tối thiểu chấp nhận (chốt chặn an toàn). */
  minRr: number;
  /** Bật TP theo cấu trúc: nhắm đáy/đỉnh swing M5 gần nhất. */
  tpStructureEnabled: boolean;
  /** Số nến M5 lấy swing đối diện làm mục tiêu TP. */
  tpSwingLookback: number;
  /** Đặt TP hụt vào trong mốc cấu trúc 1 đệm = ATR(M1) × tpStructureBufferAtrMult. */
  tpStructureBufferAtrMult: number;
  /** RR tối thiểu để CHẤP NHẬN mục tiêu cấu trúc; thấp hơn → fallback R-thuần. */
  tpStructureMinRr: number;
  /** RR tối đa cho TP cấu trúc (mốc quá xa sẽ bị chặn về mức này). */
  tpStructureMaxRr: number;
  /** Nới M15: cho phép close lệch tối đa m15BandAtrMult × ATR(M15) sang phía ngược bias. */
  m15BandAtrMult: number;
  strongBodyRatio: number;
  strongBuyRsiMax: number;
  strongSellRsiMin: number;
  rsiPeriod: number;
  buyRsiMax: number;
  sellRsiMin: number;
  minBodyRatio: number;
  maxTriggerRange: number;
  maxEntryAtr: number;
  /**
   * Chặn vào lệnh khi nến H1 ĐANG CHẠY đã đi ngược quá mạnh:
   * adverse > max(ATR(H1)×formingH1AdverseAtrMult, SL×formingH1AdverseSlMult).
   * Open H1 đang chạy ≈ close H1 đã đóng gần nhất (bridge chỉ trả nến đóng).
   */
  formingH1AdverseAtrMult: number;
  formingH1AdverseSlMult: number;
  /** Chỉ vào lệnh khi H4 cùng hướng + (phá Asia range hoặc H1 xa EMA50). */
  trendDayEnabled: boolean;
  /**
   * Cho phép từng hướng lệnh. Backtest 07/2026 (XAU, ~3 tuần): SELL âm nặng
   * (27% win, −6.9R) trong khi BUY hoà/dương, nên hướng có thể tắt riêng.
   */
  allowBuy: boolean;
  allowSell: boolean;
}

/** Vàng: SL ~2.2×ATR(M1) (sàn 3.5 / trần 6), đệm swing dày hơn để khó bị quét. */
export const defaultXauMicroScalpConfig: XauMicroScalpConfig = {
  symbolLabel: "XAUUSD",
  priceDigits: 3,
  atrPeriod: 14,
  slAtrMult: 2.2,
  minSlDistance: 3.5,
  maxSlDistance: 6.0,
  slSwingLookback: 18,
  slSwingBufferAtrMult: 0.75,
  rrTarget: 1.3,
  strongRr: 1.5,
  minRr: 1.2,
  tpStructureEnabled: true,
  tpSwingLookback: 20,
  tpStructureBufferAtrMult: 0.3,
  tpStructureMinRr: 1.2,
  tpStructureMaxRr: 3.0,
  m15BandAtrMult: 0.35,
  strongBodyRatio: 0.45,
  strongBuyRsiMax: 40,
  strongSellRsiMin: 60,
  rsiPeriod: 14,
  buyRsiMax: 48,
  sellRsiMin: 52,
  minBodyRatio: 0.35,
  maxTriggerRange: 4.0,
  maxEntryAtr: 6,
  formingH1AdverseAtrMult: 0.6,
  formingH1AdverseSlMult: 0.8,
  trendDayEnabled: true,
  allowBuy: true,
  allowSell: true,
};

/** EURUSD: SL ~1.8×ATR(M1) (sàn 5 / trần 8 pip), lookback/đệm swing dày hơn. */
export const defaultEurUsdMicroScalpConfig: XauMicroScalpConfig = {
  symbolLabel: "EURUSD",
  priceDigits: 5,
  atrPeriod: 14,
  slAtrMult: 1.8,
  minSlDistance: 0.0005,
  maxSlDistance: 0.0008,
  slSwingLookback: 18,
  slSwingBufferAtrMult: 0.75,
  rrTarget: 1.3,
  strongRr: 1.5,
  minRr: 1.2,
  tpStructureEnabled: true,
  tpSwingLookback: 20,
  tpStructureBufferAtrMult: 0.3,
  tpStructureMinRr: 1.2,
  tpStructureMaxRr: 3.0,
  m15BandAtrMult: 0.35,
  strongBodyRatio: 0.45,
  strongBuyRsiMax: 40,
  strongSellRsiMin: 60,
  rsiPeriod: 14,
  buyRsiMax: 48,
  sellRsiMin: 52,
  minBodyRatio: 0.35,
  maxTriggerRange: 0.0004,
  maxEntryAtr: 0.0008,
  formingH1AdverseAtrMult: 0.6,
  formingH1AdverseSlMult: 0.8,
  trendDayEnabled: true,
  allowBuy: true,
  allowSell: true,
};

export function microScalpConfigForSymbol(
  symbol: string | null | undefined,
  overrides?: Partial<XauMicroScalpConfig>,
): XauMicroScalpConfig {
  const normalized = String(symbol || "").toUpperCase();
  const base = normalized.startsWith("EURUSD")
    ? defaultEurUsdMicroScalpConfig
    : defaultXauMicroScalpConfig;
  return overrides ? { ...base, ...overrides } : base;
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
  m5: Candle[] = [],
  h4: Candle[] = [],
  now: Date = new Date(),
): XauMicroScalpSignal | null {
  return buildXauMicroScalpSignal(m1, m15, h1, config, m5, h4, now).signal;
}

export function explainXauMicroScalpRejection(
  m1: Candle[],
  m15: Candle[],
  h1: Candle[] = [],
  config: XauMicroScalpConfig = defaultXauMicroScalpConfig,
  m5: Candle[] = [],
  h4: Candle[] = [],
  now: Date = new Date(),
): string {
  return buildXauMicroScalpSignal(m1, m15, h1, config, m5, h4, now).reason;
}

/**
 * SL = clamp(max(ATR×slAtrMult, structDistance), min, max) — lấy khoảng lớn hơn
 * giữa biến động ATR và khoảng-cấu-trúc (ngoài swing high/low gần nhất) để SL
 * không bị nhiễu quét. TP = SL × rrTarget (strong → strongRr) → RR ~1.2–1.5.
 * Khi thiếu ATR & structDistance → rơi về sàn minSlDistance.
 */
export function resolveScalpTpSl(
  strongSetup: boolean,
  config: XauMicroScalpConfig = defaultXauMicroScalpConfig,
  atrValue?: number | null,
  structDistance?: number | null,
): { tpPoints: number; slPoints: number; rr: number; strongSetup: boolean } {
  const safeAtr =
    Number.isFinite(atrValue) && (atrValue as number) > 0 ? (atrValue as number) : 0;
  const safeStruct =
    Number.isFinite(structDistance) && (structDistance as number) > 0
      ? (structDistance as number)
      : 0;
  const rawSl = Math.max(safeAtr * config.slAtrMult, safeStruct);
  const slPoints = clamp(rawSl, config.minSlDistance, config.maxSlDistance);
  const rr = strongSetup ? config.strongRr : config.rrTarget;
  const tpPoints = slPoints * rr;
  return {
    tpPoints: roundPrice(tpPoints, config.priceDigits),
    slPoints: roundPrice(slPoints, config.priceDigits),
    rr: roundPrice(rr, 3),
    strongSetup,
  };
}

/**
 * TP theo cấu trúc: nhắm đáy swing (SELL) / đỉnh swing (BUY) trên M5, đặt hụt
 * vào trong mốc 1 đệm = ATR(M1) × tpStructureBufferAtrMult để dễ khớp.
 * - RR mốc < tpStructureMinRr hoặc thiếu dữ liệu M5 → trả null (fallback R-thuần).
 * - RR mốc > tpStructureMaxRr → chặn TP ở tpStructureMaxRr × SL.
 */
export function resolveStructureTp(input: {
  config: XauMicroScalpConfig;
  direction: "BUY" | "SELL";
  entry: number;
  slPoints: number;
  m1Atr: number;
  m5: Candle[];
}): { tpPoints: number; rr: number } | null {
  const { config, direction, entry, slPoints, m1Atr, m5 } = input;
  if (!config.tpStructureEnabled) return null;
  if (!Number.isFinite(slPoints) || slPoints <= 0) return null;
  if (!m5 || m5.length < config.tpSwingLookback) return null;

  const window = m5.slice(-config.tpSwingLookback);
  const buffer =
    (Number.isFinite(m1Atr) && m1Atr > 0 ? m1Atr : 0) *
    config.tpStructureBufferAtrMult;

  const target =
    direction === "BUY"
      ? Math.max(...window.map((c) => c.high)) - buffer
      : Math.min(...window.map((c) => c.low)) + buffer;

  const tpDist = direction === "BUY" ? target - entry : entry - target;
  if (!Number.isFinite(tpDist) || tpDist <= 0) return null;

  const structRr = tpDist / slPoints;
  if (structRr + 1e-9 < config.tpStructureMinRr) return null;

  const cappedDist = Math.min(tpDist, slPoints * config.tpStructureMaxRr);
  return {
    tpPoints: roundPrice(cappedDist, config.priceDigits),
    rr: roundPrice(cappedDist / slPoints, 3),
  };
}

/**
 * Chặn SELL khi H1 đang chạy đã hồi lên quá mạnh / BUY khi đã dump quá mạnh.
 * Open nến H1 đang chạy ≈ close H1 đã đóng gần nhất.
 * Ngưỡng = max(ATR(H1)×atrMult, SL×slMult) — cho phép pullback nông, chặn hồi lớn.
 */
export function resolveFormingH1AdverseBlock(input: {
  config: XauMicroScalpConfig;
  direction: "BUY" | "SELL";
  entry: number;
  slPoints: number;
  h1: Candle[];
}): string | null {
  const { config, direction, entry, slPoints, h1 } = input;
  const lastClosed = h1.at(-1);
  if (!lastClosed || !Number.isFinite(entry) || !Number.isFinite(slPoints) || slPoints <= 0) {
    return null;
  }

  const formingOpen = lastClosed.close;
  const h1Atr = atr(h1, config.atrPeriod);
  const atrPart =
    Number.isFinite(h1Atr) && (h1Atr as number) > 0
      ? (h1Atr as number) * config.formingH1AdverseAtrMult
      : 0;
  const slPart = slPoints * config.formingH1AdverseSlMult;
  const threshold = Math.max(atrPart, slPart);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;

  const adverse =
    direction === "SELL" ? entry - formingOpen : formingOpen - entry;
  if (adverse <= threshold + 1e-9) return null;

  return (
    `micro-scalp blocked: forming H1 adverse ${fmt(adverse, config)} > ` +
    `max(ATR×${config.formingH1AdverseAtrMult}, SL×${config.formingH1AdverseSlMult})=` +
    `${fmt(threshold, config)} (H1 open≈${fmt(formingOpen, config)}, entry ${fmt(entry, config)})`
  );
}

function buildXauMicroScalpSignal(
  m1: Candle[],
  m15: Candle[],
  h1: Candle[],
  config: XauMicroScalpConfig,
  m5: Candle[] = [],
  h4: Candle[] = [],
  now: Date = new Date(),
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
  const m15Atr = atr(m15, config.atrPeriod);
  const m15Last = m15.at(-1);
  if (!m15Last || m15Ema50 === null) {
    return { signal: null, reason: "micro-scalp M15 EMA unavailable" };
  }
  // Nới M15 có kiểm soát: cho phép close lệch tối đa m15BandAtrMult×ATR(M15)
  // sang phía ngược bias (chấp nhận hồi nông) nhưng vẫn loại M15 ngược momentum rõ.
  const m15Band =
    (Number.isFinite(m15Atr) && (m15Atr as number) > 0 ? (m15Atr as number) : 0) *
    config.m15BandAtrMult;
  const m15BuyAlign = m15Last.close >= m15Ema50 - m15Band;
  const m15SellAlign = m15Last.close <= m15Ema50 + m15Band;
  if (h1BuyBias && !m15BuyAlign) {
    return {
      signal: null,
      reason: `micro-scalp blocked: H1 BUY bias but M15 ${fmt(m15Last.close, config)} < EMA50 ${fmt(m15Ema50, config)} - band ${fmt(m15Band, config)}`,
    };
  }
  if (h1SellBias && !m15SellAlign) {
    return {
      signal: null,
      reason: `micro-scalp blocked: H1 SELL bias but M15 ${fmt(m15Last.close, config)} > EMA50 ${fmt(m15Ema50, config)} + band ${fmt(m15Band, config)}`,
    };
  }

  const m1Closes = m1.map((c) => c.close);
  const m1Rsi = rsi(m1Closes, config.rsiPeriod);
  const m1Atr = atr(m1, config.atrPeriod);
  const prev = m1.at(-2);
  const last = m1.at(-1);
  if (!prev || !last || m1Rsi === null || m1Atr === null || m1Atr <= 0) {
    return { signal: null, reason: "micro-scalp M1 indicators unavailable" };
  }
  if (m1Atr > config.maxEntryAtr) {
    return {
      signal: null,
      reason: `micro-scalp blocked: M1 ATR ${fmt(m1Atr, config)} > ${fmt(config.maxEntryAtr, config)} (quá biến động, SL/TP theo ATR sẽ quá rộng)`,
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

  if (direction === "BUY" && !config.allowBuy) {
    return { signal: null, reason: "micro-scalp blocked: BUY direction disabled" };
  }
  if (direction === "SELL" && !config.allowSell) {
    return { signal: null, reason: "micro-scalp blocked: SELL direction disabled" };
  }

  const trendDayBlock = resolveTrendDayBlock({
    direction,
    entry: last.close,
    h1,
    h4,
    now,
    config: {
      ...defaultTrendDayFilterConfig,
      enabled: config.trendDayEnabled,
      atrPeriod: config.atrPeriod,
    },
  });
  if (trendDayBlock) {
    return { signal: null, reason: trendDayBlock };
  }

  const strongSetup =
    direction === "BUY"
      ? (buySweep && bodyRatio >= config.strongBodyRatio) ||
        m1Rsi <= config.strongBuyRsiMax
      : (sellSweep && bodyRatio >= config.strongBodyRatio) ||
        m1Rsi >= config.strongSellRsiMin;

  const entry = last.close;

  // SL ngoài cấu trúc: swing high/low N nến M1 gần nhất + đệm theo ATR.
  const swingWindow = m1.slice(-config.slSwingLookback);
  const swingHigh = Math.max(...swingWindow.map((c) => c.high));
  const swingLow = Math.min(...swingWindow.map((c) => c.low));
  const swingBuffer = m1Atr * config.slSwingBufferAtrMult;
  const structDistance =
    direction === "BUY"
      ? entry - swingLow + swingBuffer
      : swingHigh - entry + swingBuffer;

  const { tpPoints: fallbackTp, slPoints, rr: fallbackRr } = resolveScalpTpSl(
    strongSetup,
    config,
    m1Atr,
    structDistance,
  );
  if (fallbackRr + 1e-4 < config.minRr) {
    return {
      signal: null,
      reason: `micro-scalp blocked: RR ${fallbackRr.toFixed(2)} < ${config.minRr}`,
    };
  }

  // Nến H1 đang chạy đã hồi/dump quá mạnh so với open → đứng ngoài (tránh SELL giữa nhịp hồi).
  const formingBlock = resolveFormingH1AdverseBlock({
    config,
    direction,
    entry,
    slPoints,
    h1,
  });
  if (formingBlock) {
    return { signal: null, reason: formingBlock };
  }

  // TP theo cấu trúc: nhắm đáy/đỉnh swing M5 đối diện, đặt hụt vào trong 1 đệm ATR.
  // Chỉ dùng khi RR mốc >= tpStructureMinRr; mốc quá xa bị chặn ở tpStructureMaxRr;
  // không đạt hoặc thiếu dữ liệu M5 → fallback TP R-thuần.
  const tpStructure = resolveStructureTp({
    config,
    direction,
    entry,
    slPoints,
    m1Atr,
    m5,
  });
  const tpPoints = tpStructure?.tpPoints ?? fallbackTp;
  const rr = tpStructure?.rr ?? fallbackRr;
  const tpMode = tpStructure ? "struct-M5" : "R";

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
        `TP ${fmt(tpPoints, config)} / SL ${fmt(slPoints, config)} (RR ${rr.toFixed(2)}, TP=${tpMode})`,
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function roundPrice(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value: number, config: XauMicroScalpConfig): string {
  return value.toFixed(config.priceDigits);
}
