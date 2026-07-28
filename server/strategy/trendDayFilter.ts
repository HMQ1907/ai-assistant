import type { Candle } from "../../types/trading";
import { atr, ema } from "../utils/indicators";

export interface TrendDayFilterConfig {
  enabled: boolean;
  /** H4 close vs EMA50 phải cùng hướng với lệnh. */
  requireH4Align: boolean;
  /** Giờ bắt đầu phiên Á (Asia/Saigon), inclusive. */
  asiaStartHour: number;
  /** Giờ kết thúc phiên Á (Asia/Saigon), exclusive — trước cửa sổ London. */
  asiaEndHour: number;
  /** Xác nhận trend: |H1 close − EMA50| / ATR(H1) ≥ ngưỡng (không cần phá Asia). */
  minEmaDistAtrMult: number;
  atrPeriod: number;
  timeZone: string;
}

export const defaultTrendDayFilterConfig: TrendDayFilterConfig = {
  enabled: true,
  requireH4Align: true,
  asiaStartHour: 7,
  asiaEndHour: 14,
  minEmaDistAtrMult: 0.5,
  atrPeriod: 14,
  timeZone: "Asia/Saigon",
};

export interface AsiaRange {
  high: number;
  low: number;
  barCount: number;
  dayKey: string;
}

/**
 * Range high/low phiên Á trong ngày (theo timeZone), lấy từ nến H1 đã đóng.
 */
export function computeAsiaSessionRange(
  h1: Candle[],
  now: Date = new Date(),
  config: Pick<
    TrendDayFilterConfig,
    "asiaStartHour" | "asiaEndHour" | "timeZone"
  > = defaultTrendDayFilterConfig,
): AsiaRange | null {
  const dayKey = formatDayKey(now, config.timeZone);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let barCount = 0;

  for (const candle of h1) {
    const parts = zonedParts(new Date(candle.time), config.timeZone);
    if (!parts) continue;
    if (parts.dayKey !== dayKey) continue;
    if (parts.hour < config.asiaStartHour || parts.hour >= config.asiaEndHour) {
      continue;
    }
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
    barCount += 1;
  }

  if (barCount < 3 || !Number.isFinite(high) || !Number.isFinite(low) || high < low) {
    return null;
  }
  return { high, low, barCount, dayKey };
}

/**
 * Chỉ cho trade khi "trend day":
 * 1) H4 EMA50 cùng hướng H1/lệnh
 * 2) Đã phá range phiên Á theo hướng lệnh, HOẶC H1 đã cách EMA50 đủ xa (×ATR)
 */
export function resolveTrendDayBlock(input: {
  direction: "BUY" | "SELL";
  entry: number;
  h1: Candle[];
  h4: Candle[];
  now?: Date;
  config?: Partial<TrendDayFilterConfig>;
}): string | null {
  const config: TrendDayFilterConfig = {
    ...defaultTrendDayFilterConfig,
    ...input.config,
  };
  if (!config.enabled) return null;

  const now = input.now ?? new Date();
  const h1Last = input.h1.at(-1);
  if (!h1Last || !Number.isFinite(input.entry)) {
    return "trend-day blocked: H1/entry unavailable";
  }

  if (config.requireH4Align) {
    if (input.h4.length < 60) {
      return "trend-day blocked: H4 candles insufficient for EMA50";
    }
    const h4Ema50 = ema(
      input.h4.map((c) => c.close),
      50,
    );
    const h4Last = input.h4.at(-1);
    if (!h4Last || h4Ema50 === null) {
      return "trend-day blocked: H4 EMA unavailable";
    }
    const h4Buy = h4Last.close >= h4Ema50;
    const h4Sell = h4Last.close <= h4Ema50;
    if (input.direction === "BUY" && !h4Buy) {
      return (
        `trend-day blocked: H1/entry BUY but H4 ${h4Last.close.toFixed(3)} ` +
        `< EMA50 ${h4Ema50.toFixed(3)} (chưa phải ngày uptrend rõ)`
      );
    }
    if (input.direction === "SELL" && !h4Sell) {
      return (
        `trend-day blocked: H1/entry SELL but H4 ${h4Last.close.toFixed(3)} ` +
        `> EMA50 ${h4Ema50.toFixed(3)} (chưa phải ngày downtrend rõ)`
      );
    }
  }

  const h1Closes = input.h1.map((c) => c.close);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Atr = atr(input.h1, config.atrPeriod);
  const emaStretch =
    h1Ema50 !== null &&
    h1Atr !== null &&
    h1Atr > 0 &&
    Math.abs(h1Last.close - h1Ema50) / h1Atr >= config.minEmaDistAtrMult;

  const asia = computeAsiaSessionRange(input.h1, now, config);
  let asiaBreak = false;
  if (asia) {
    asiaBreak =
      input.direction === "BUY"
        ? input.entry >= asia.high || h1Last.close >= asia.high
        : input.entry <= asia.low || h1Last.close <= asia.low;
  }

  if (asiaBreak || emaStretch) return null;

  if (!asia) {
    return (
      "trend-day blocked: Asia range unavailable and H1 not stretched vs EMA50 " +
      `(need |close-EMA50| / ATR >= ${config.minEmaDistAtrMult})`
    );
  }

  return (
    `trend-day blocked: no Asia ${input.direction === "BUY" ? "high" : "low"} breakout ` +
    `(Asia ${asia.low.toFixed(3)}-${asia.high.toFixed(3)}, entry ${input.entry.toFixed(3)}) ` +
    `and H1 not stretched vs EMA50`
  );
}

function formatDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function zonedParts(
  date: Date,
  timeZone: string,
): { dayKey: string; hour: number } | null {
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  // Some engines emit hour "24" for midnight.
  if (hour === 24) hour = 0;
  if (!year || !month || !day || !Number.isFinite(hour)) return null;
  return { dayKey: `${year}-${month}-${day}`, hour };
}
