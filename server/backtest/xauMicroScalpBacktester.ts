import type { Candle } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import {
  defaultXauMicroScalpConfig,
  evaluateXauMicroScalpSignal,
  type XauMicroScalpConfig,
} from "../strategy/xauMicroScalpStrategy";
import type { XauBacktestResult, XauBacktestTrade } from "./xauPullbackBacktester";

/**
 * Backtest tái hiện auto-bot mode `xau_micro_scalp`:
 * - Quét mỗi nến M1 đóng trong cửa sổ giao dịch (mặc định 14:00–21:30 Asia/Saigon).
 * - Vào MARKET tại close M1; SL/TP từ evaluateXauMicroScalpSignal (trend-day + forming H1).
 * - 1 position tại một thời điểm; break-even +1R; time-stop theo maxHoldBars M1.
 */
export interface XauMicroScalpBacktestConfig {
  spreadPrice: number;
  /** Số nến M1 tối đa giữ lệnh (8h = 480). */
  maxHoldBars: number;
  /** Số nến M1 nghỉ sau khi đóng (0 = không cooldown). */
  cooldownBars: number;
  breakEvenAtR: number;
  lot: number;
  accountStartUsd: number;
  maxLossPercentPerTrade: number;
  maxTradesPerDay: number;
  timeZone: string;
  tradeWindows: string;
  scalpConfig: XauMicroScalpConfig;
}

export const defaultXauMicroScalpBacktestConfig: XauMicroScalpBacktestConfig = {
  spreadPrice: 0.3,
  maxHoldBars: 480,
  cooldownBars: 0,
  breakEvenAtR: 1,
  lot: 0.02,
  accountStartUsd: 200,
  maxLossPercentPerTrade: 10,
  maxTradesPerDay: 8,
  timeZone: "Asia/Saigon",
  tradeWindows: "14:00-21:30",
  scalpConfig: defaultXauMicroScalpConfig,
};

interface OpenPosition {
  direction: "BUY" | "SELL";
  entryIndex: number;
  entryTime: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  risk: number;
  movedToBreakEven: boolean;
}

export function runXauMicroScalpBacktest(
  m1: Candle[],
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[],
  config: XauMicroScalpBacktestConfig = defaultXauMicroScalpBacktestConfig,
): XauBacktestResult {
  const trades: XauBacktestTrade[] = [];
  let open: OpenPosition | null = null;
  let cooldownUntil = -1;
  let m5Idx = 0;
  let m15Idx = 0;
  let h1Idx = 0;
  let h4Idx = 0;
  let signalsRaw = 0;
  let skippedByRiskCap = 0;
  const maxLossUsd = config.accountStartUsd * (config.maxLossPercentPerTrade / 100);
  const windows = parseTradeScannerWindows(config.tradeWindows);
  const tradesByDay = new Map<string, number>();

  for (let i = 0; i < m1.length; i += 1) {
    const bar = m1[i];
    if (!bar) continue;

    if (open) {
      const holdBars = i - open.entryIndex;
      const resolved = resolveOpen(open, bar, config);
      if (resolved) {
        trades.push(buildTrade(open, bar, resolved, holdBars, config));
        cooldownUntil = i + config.cooldownBars;
        open = null;
      } else if (holdBars >= config.maxHoldBars) {
        trades.push(
          buildTrade(open, bar, { outcome: "TIMESTOP", exitPrice: bar.close }, holdBars, config),
        );
        cooldownUntil = i + config.cooldownBars;
        open = null;
      }
      continue;
    }

    if (i <= cooldownUntil) continue;
    if (!isInsideWindow(bar.time, config.timeZone, windows)) continue;

    while (m5Idx + 1 < m5.length && (m5[m5Idx + 1]?.time ?? "") <= bar.time) m5Idx += 1;
    while (m15Idx + 1 < m15.length && (m15[m15Idx + 1]?.time ?? "") <= bar.time) m15Idx += 1;
    while (h1Idx + 1 < h1.length && (h1[h1Idx + 1]?.time ?? "") <= bar.time) h1Idx += 1;
    while (h4Idx + 1 < h4.length && (h4[h4Idx + 1]?.time ?? "") <= bar.time) h4Idx += 1;

    // Cửa sổ trượt thay vì slice từ đầu: EMA50/RSI14/ATR14 đã hội tụ sau ~300 nến,
    // và slice(0, i) trên 90k nến M1 khiến backtest chậm bậc hai.
    const m1Slice = tailWindow(m1, i);
    const m5Slice = tailWindow(m5, m5Idx);
    const m15Slice = tailWindow(m15, m15Idx);
    const h1Slice = tailWindow(h1, h1Idx);
    const h4Slice = tailWindow(h4, h4Idx);

    if (
      m1Slice.length < 50 ||
      m5Slice.length < config.scalpConfig.tpSwingLookback ||
      m15Slice.length < 60 ||
      h1Slice.length < 60 ||
      h4Slice.length < 60
    ) {
      continue;
    }

    const dayKey = formatDayKey(bar.time, config.timeZone);
    if ((tradesByDay.get(dayKey) ?? 0) >= config.maxTradesPerDay) continue;

    const signal = evaluateXauMicroScalpSignal(
      m1Slice,
      m15Slice,
      h1Slice,
      config.scalpConfig,
      m5Slice,
      h4Slice,
      new Date(bar.time),
    );
    if (!signal) continue;

    const risk =
      signal.direction === "BUY"
        ? signal.entry - signal.stopLoss
        : signal.stopLoss - signal.entry;
    if (!Number.isFinite(risk) || risk <= 0) continue;
    signalsRaw += 1;

    const estLossUsd = risk * config.lot * tradingRules.xauUsdOuncesPerLot;
    if (estLossUsd > maxLossUsd) {
      skippedByRiskCap += 1;
      continue;
    }

    open = {
      direction: signal.direction,
      entryIndex: i,
      entryTime: bar.time,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      risk,
      movedToBreakEven: false,
    };
    tradesByDay.set(dayKey, (tradesByDay.get(dayKey) ?? 0) + 1);
  }

  return summarize(m1, trades, config, signalsRaw, skippedByRiskCap);
}

/** Số nến tối đa đưa vào chỉ báo — đủ để EMA50/RSI14/ATR14 hội tụ. */
const INDICATOR_WINDOW = 320;

function tailWindow(candles: Candle[], lastIdx: number): Candle[] {
  return candles.slice(Math.max(0, lastIdx + 1 - INDICATOR_WINDOW), lastIdx + 1);
}

interface Resolution {
  outcome: XauBacktestTrade["outcome"];
  exitPrice: number;
}

function resolveOpen(
  open: OpenPosition,
  bar: Candle,
  config: XauMicroScalpBacktestConfig,
): Resolution | null {
  const buffer = config.spreadPrice;
  if (open.direction === "BUY") {
    if (bar.low <= open.stopLoss) {
      return {
        outcome: open.movedToBreakEven ? "BREAKEVEN" : "LOSS",
        exitPrice: open.stopLoss,
      };
    }
    if (bar.high >= open.takeProfit) return { outcome: "WIN", exitPrice: open.takeProfit };
    if (!open.movedToBreakEven && bar.high >= open.entry + config.breakEvenAtR * open.risk) {
      open.stopLoss = open.entry + buffer;
      open.movedToBreakEven = true;
    }
  } else {
    if (bar.high >= open.stopLoss) {
      return {
        outcome: open.movedToBreakEven ? "BREAKEVEN" : "LOSS",
        exitPrice: open.stopLoss,
      };
    }
    if (bar.low <= open.takeProfit) return { outcome: "WIN", exitPrice: open.takeProfit };
    if (!open.movedToBreakEven && bar.low <= open.entry - config.breakEvenAtR * open.risk) {
      open.stopLoss = open.entry - buffer;
      open.movedToBreakEven = true;
    }
  }
  return null;
}

function buildTrade(
  open: OpenPosition,
  bar: Candle,
  resolution: Resolution,
  holdBars: number,
  config: XauMicroScalpBacktestConfig,
): XauBacktestTrade {
  const move =
    open.direction === "BUY"
      ? resolution.exitPrice - open.entry
      : open.entry - resolution.exitPrice;
  const costR = open.risk > 0 ? config.spreadPrice / open.risk : 0;
  const rMultiple = move / open.risk - costR;
  const usd = rMultiple * open.risk * config.lot * tradingRules.xauUsdOuncesPerLot;
  return {
    direction: open.direction,
    entryTime: open.entryTime,
    entry: round(open.entry),
    stopLoss: round(open.stopLoss),
    takeProfit: round(open.takeProfit),
    exitTime: bar.time,
    exitPrice: round(resolution.exitPrice),
    outcome: resolution.outcome,
    rMultiple: round(rMultiple),
    usd: Number(usd.toFixed(2)),
    riskUsd: Number((open.risk * config.lot * tradingRules.xauUsdOuncesPerLot).toFixed(2)),
    holdBars,
  };
}

function summarize(
  m1: Candle[],
  trades: XauBacktestTrade[],
  config: XauMicroScalpBacktestConfig,
  signalsRaw: number,
  skippedByRiskCap: number,
): XauBacktestResult {
  const wins = trades.filter((t) => t.outcome === "WIN");
  const losses = trades.filter((t) => t.outcome === "LOSS");
  const breakeven = trades.filter((t) => t.outcome === "BREAKEVEN");
  const timestop = trades.filter((t) => t.outcome === "TIMESTOP");
  const totalR = sum(trades.map((t) => t.rMultiple));
  const grossWin = sum(trades.filter((t) => t.rMultiple > 0).map((t) => t.rMultiple));
  const grossLoss = Math.abs(sum(trades.filter((t) => t.rMultiple < 0).map((t) => t.rMultiple)));

  let equityR = 0;
  let peakR = 0;
  let maxDdR = 0;
  let equityUsd = config.accountStartUsd;
  let peakUsd = config.accountStartUsd;
  let maxDdUsd = 0;
  for (const t of trades) {
    equityR += t.rMultiple;
    peakR = Math.max(peakR, equityR);
    maxDdR = Math.max(maxDdR, peakR - equityR);
    equityUsd += t.usd;
    peakUsd = Math.max(peakUsd, equityUsd);
    maxDdUsd = Math.max(maxDdUsd, peakUsd - equityUsd);
  }

  return {
    bars: m1.length,
    firstTime: m1[0]?.time ?? "",
    lastTime: m1.at(-1)?.time ?? "",
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    timestop: timestop.length,
    signalsRaw,
    skippedByRiskCap,
    winRate: pct(wins.length, wins.length + losses.length),
    expectancyR: round(trades.length ? totalR / trades.length : 0),
    avgWinR: round(
      wins.length ? grossWin / Math.max(1, trades.filter((t) => t.rMultiple > 0).length) : 0,
    ),
    avgLossR: round(
      losses.length ? -grossLoss / Math.max(1, trades.filter((t) => t.rMultiple < 0).length) : 0,
    ),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
    totalR: round(totalR),
    maxDrawdownR: round(maxDdR),
    netUsd: Number((equityUsd - config.accountStartUsd).toFixed(2)),
    endEquityUsd: Number(equityUsd.toFixed(2)),
    maxDrawdownUsd: Number(maxDdUsd.toFixed(2)),
    tradeList: trades,
  };
}

function isInsideWindow(
  isoTime: string,
  timeZone: string,
  windows: Array<{ startMinutes: number; endMinutes: number }>,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date(isoTime));
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  if (hour === 24) hour = 0;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const currentMinutes = hour * 60 + minute;
  return windows.some(
    (w) => currentMinutes >= w.startMinutes && currentMinutes < w.endMinutes,
  );
}

function formatDayKey(isoTime: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTime));
}

function parseTradeScannerWindows(
  value: string,
): Array<{ startMinutes: number; endMinutes: number }> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [start, end] = item.split("-").map((part) => part?.trim());
      const startMinutes = parseClockMinutes(start ?? "");
      const endMinutes = parseClockMinutes(end ?? "");
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        return null;
      }
      return { startMinutes, endMinutes };
    })
    .filter((item): item is { startMinutes: number; endMinutes: number } => item !== null);
}

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function pct(n: number, d: number): number {
  return d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
