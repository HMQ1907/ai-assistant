import { describe, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBacktestCandles } from "../../server/backtest/backtestData";
import { evaluateManualReversalScalpSignal } from "../../server/strategy/ruleStrategy";
import { checkAutoRisk } from "../../server/services/AutoTradeRunner";
import type { Candle, SymbolCode } from "../../types/trading";

interface Trade {
  direction: "BUY" | "SELL";
  entryTime: string;
  exitTime: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  outcome: "WIN" | "LOSS" | "PROTECTED" | "TIMEOUT";
  pnlUsd: number;
  r: number;
  holdMinutes: number;
  reason: string;
}

const BRIDGE_URL = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const SYMBOL = process.env.BACKTEST_SYMBOL || process.env.MT5_SYMBOL || "EURUSDm";
const SYMBOL_CODE: SymbolCode = SYMBOL.trim().toUpperCase().startsWith("XAUUSD")
  ? "XAUUSD"
  : "EURUSD";
const ACCOUNT_SIZE_USD = Number(process.env.BACKTEST_ACCOUNT_SIZE_USD || 100);
const LOT = Number(process.env.BACKTEST_LOT || 0.05);
const MAX_LOSS_PERCENT = Number(process.env.BACKTEST_MAX_LOSS_PERCENT || 15);
const MAX_HOLD_MINUTES = Number(process.env.BACKTEST_MAX_HOLD_MINUTES || 90);
const COOLDOWN_MINUTES = Number(process.env.BACKTEST_COOLDOWN_MINUTES || 5);
const MAX_TRADES_PER_DAY = Number(process.env.BACKTEST_MAX_TRADES_PER_DAY || 5);
const MAX_OPEN_TRADES = Number(
  process.env.BACKTEST_MAX_OPEN_TRADES || process.env.AUTO_SCALP_MAX_OPEN_TRADES || 1,
);
const MAX_DAILY_LOSS_PERCENT = Number(process.env.BACKTEST_MAX_DAILY_LOSS_PERCENT || 10);
const MAX_DAILY_LOSS_USD = Number(process.env.BACKTEST_MAX_DAILY_LOSS_USD || 0);
const PROFIT_PROTECTION = process.env.BACKTEST_PROFIT_PROTECTION !== "false";
const SPREAD_PRICE = Number(
  process.env.BACKTEST_SPREAD_PRICE || (SYMBOL_CODE === "EURUSD" ? 0.00008 : 0),
);
const M1_BARS = Number(process.env.BACKTEST_M1_BARS || 6000);
const TP_R_MULT = Number(process.env.BACKTEST_TP_R_MULT || process.env.AUTO_SCALP_TP_R || 1.5);
const SL_MULT = Number(process.env.BACKTEST_SL_MULT || 1);
const TRADE_WINDOWS = process.env.BACKTEST_TRADE_WINDOWS ?? process.env.TRADE_SCANNER_WINDOWS ?? "";
const TRADE_TIMEZONE = process.env.TRADE_SCANNER_TIMEZONE || "Asia/Saigon";
const SCALP_FREQUENCY =
  (process.env.BACKTEST_SCALP_FREQUENCY || process.env.AUTO_SCALP_FREQUENCY) === "high"
    ? "high"
    : "normal";
const DATA_DIR = process.env.BACKTEST_DATA_DIR || "";

function timeMs(candle: Candle): number {
  return new Date(candle.time).getTime();
}

function lossUsd(entry: number, stopLoss: number, lot: number): number {
  if (SYMBOL_CODE === "XAUUSD") {
    return Math.abs(entry - stopLoss) * lot * 100;
  }
  const slPips = Math.abs(entry - stopLoss) / 0.0001;
  return slPips * 10 * lot;
}

function pnlUsdForR(entry: number, stopLoss: number, r: number, lot: number): number {
  return Number((lossUsd(entry, stopLoss, lot) * r).toFixed(2));
}

function widenSignal(
  signal: NonNullable<ReturnType<typeof evaluateManualReversalScalpSignal>>,
) {
  if (SL_MULT === 1 && TP_R_MULT === 1.5) return signal;

  const risk = Math.abs(signal.entry - signal.stopLoss);
  const widenedRisk = risk * SL_MULT;
  const stopLoss =
    signal.direction === "BUY"
      ? signal.entry - widenedRisk
      : signal.entry + widenedRisk;
  const takeProfit =
    signal.direction === "BUY"
      ? signal.entry + widenedRisk * TP_R_MULT
      : signal.entry - widenedRisk * TP_R_MULT;

  return {
    ...signal,
    stopLoss: Number(stopLoss.toFixed(5)),
    takeProfit: Number(takeProfit.toFixed(5)),
  };
}

function simulateExit(
  entryIndex: number,
  m1: Candle[],
  signal: NonNullable<ReturnType<typeof evaluateManualReversalScalpSignal>>,
): Pick<Trade, "exitTime" | "outcome" | "r" | "holdMinutes"> {
  const entryTimeMs = timeMs(m1[entryIndex]!);
  const risk = Math.abs(signal.entry - signal.stopLoss);
  const maxBars = Math.max(1, Math.floor(MAX_HOLD_MINUTES));
  let protectedStop = signal.stopLoss;

  for (let offset = 1; offset <= maxBars && entryIndex + offset < m1.length; offset += 1) {
    const candle = m1[entryIndex + offset]!;
    const slHit =
      signal.direction === "BUY"
        ? candle.low <= protectedStop
        : candle.high >= protectedStop;
    const tpHit =
      signal.direction === "BUY"
        ? candle.high >= signal.takeProfit
        : candle.low <= signal.takeProfit;

    if (slHit || tpHit) {
      // Neu cung mot nen quet ca SL va TP thi gia lap bao thu: tinh SL truoc.
      const stopR = signal.direction === "BUY"
        ? (protectedStop - signal.entry) / risk
        : (signal.entry - protectedStop) / risk;
      const outcome = tpHit && !slHit ? "WIN" : stopR <= -0.99 ? "LOSS" : "PROTECTED";
      return {
        exitTime: candle.time,
        outcome,
        r: outcome === "WIN" ? TP_R_MULT : Number(stopR.toFixed(4)),
        holdMinutes: Math.round((timeMs(candle) - entryTimeMs) / 60_000),
      };
    }

    if (PROFIT_PROTECTION) {
      // Live bot evaluates once per minute. Use the closed M1 price and apply
      // the safer SL from the following candle to avoid optimistic intrabar ordering.
      const favorableMove = signal.direction === "BUY"
        ? candle.close - signal.entry
        : signal.entry - candle.close;
      const reachedR = favorableMove / risk;
      const lockedR = reachedR >= 1.5 ? 0.5 : reachedR >= 1 ? 0 : null;
      if (lockedR !== null) {
        const candidate = signal.direction === "BUY"
          ? signal.entry + risk * lockedR + SPREAD_PRICE
          : signal.entry - risk * lockedR - SPREAD_PRICE;
        const validAgainstPrice = signal.direction === "BUY"
          ? candidate < candle.close
          : candidate > candle.close;
        const safer = signal.direction === "BUY"
          ? candidate > protectedStop
          : candidate < protectedStop;
        if (validAgainstPrice && safer) protectedStop = candidate;
      }
    }
  }

  const exitIndex = Math.min(entryIndex + maxBars, m1.length - 1);
  const exit = m1[exitIndex]!;
  const rawR =
    signal.direction === "BUY"
      ? (exit.close - signal.entry) / risk
      : (signal.entry - exit.close) / risk;
  return {
    exitTime: exit.time,
    outcome: "TIMEOUT",
    r: Number(rawR.toFixed(2)),
    holdMinutes: Math.round((timeMs(exit) - entryTimeMs) / 60_000),
  };
}

function maxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 0;
  let maxDd = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return Number(maxDd.toFixed(2));
}

function minutesInTimeZone(timestampMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date(timestampMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function parseWindowMinutes(value: string): Array<{ start: number; end: number }> {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [startRaw, endRaw] = part.split("-");
      return {
        start: parseClockMinutes(startRaw ?? "00:00"),
        end: parseClockMinutes(endRaw ?? "24:00"),
      };
    })
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end));
}

function parseClockMinutes(value: string): number {
  const [hourRaw, minuteRaw = "0"] = value.trim().split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  return hour * 60 + minute;
}

function isInsideTradeWindow(timestampMs: number): boolean {
  const windows = parseWindowMinutes(TRADE_WINDOWS);
  if (windows.length === 0) return true;
  const current = minutesInTimeZone(timestampMs, TRADE_TIMEZONE);
  return windows.some((window) =>
    window.start <= window.end
      ? current >= window.start && current < window.end
      : current >= window.start || current < window.end,
  );
}

function dayKey(timestampMs: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TRADE_TIMEZONE,
  }).format(new Date(timestampMs));
}

async function loadBacktestCandles(timeframe: "M1" | "M5" | "M15" | "H1", count: number): Promise<Candle[]> {
  if (DATA_DIR) {
    const file = join(DATA_DIR, `${SYMBOL}_${timeframe}.json`);
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf8")) as Candle[];
    }
  }
  return fetchBacktestCandles(BRIDGE_URL, SYMBOL, timeframe, count);
}

describe("EURUSD aggressive scalp live-data backtest", () => {
  it(
    "runs on MT5 bridge candles",
    async () => {
      let m1: Candle[];
      let m5: Candle[];
      let m15: Candle[];
      let h1: Candle[];
      try {
        [m1, m5, m15, h1] = await Promise.all([
          loadBacktestCandles("M1", M1_BARS),
          loadBacktestCandles("M5", 3000),
          loadBacktestCandles("M15", 1500),
          loadBacktestCandles("H1", 600),
        ]);
      } catch (error) {
        console.warn("[eurusd-scalp-backtest] skip: cannot fetch MT5 candles:", (error as Error).message);
        return;
      }

      const trades: Trade[] = [];
      const openTrades: Array<{ trade: Trade; exitIndex: number; riskUsd: number }> = [];
      let nextAllowedTimeMs = 0;
      let equity = ACCOUNT_SIZE_USD;
      const equityCurve = [equity];
      let m5Cursor = 0;
      let m15Cursor = 0;
      let h1Cursor = 0;
      let currentDay = "";
      let dayBaselineEquity = equity;
      let tradesToday = 0;
      const m1IndexByTime = new Map(m1.map((candle, index) => [candle.time, index]));

      for (let i = 300; i < m1.length - 2; i += 1) {
        const nowMs = timeMs(m1[i]!);
        const activeBeforeSettlement = openTrades.length;
        const completed = openTrades
          .filter((item) => item.exitIndex <= i)
          .sort((a, b) => a.exitIndex - b.exitIndex);
        for (const item of completed) {
          equity = Number((equity + item.trade.pnlUsd).toFixed(2));
          equityCurve.push(equity);
          trades.push(item.trade);
          openTrades.splice(openTrades.indexOf(item), 1);
        }
        if (activeBeforeSettlement > 0 && openTrades.length === 0 && completed.length > 0) {
          nextAllowedTimeMs = nowMs + COOLDOWN_MINUTES * 60_000;
        }

        const scanDay = dayKey(nowMs);
        if (scanDay !== currentDay) {
          currentDay = scanDay;
          dayBaselineEquity = equity;
          tradesToday = 0;
        }
        if (openTrades.length >= MAX_OPEN_TRADES) continue;
        if (nowMs < nextAllowedTimeMs) continue;
        if (!isInsideTradeWindow(nowMs)) continue;
        if (tradesToday >= MAX_TRADES_PER_DAY) continue;
        const dailyLossLimitUsd = MAX_DAILY_LOSS_USD > 0
          ? MAX_DAILY_LOSS_USD
          : dayBaselineEquity * MAX_DAILY_LOSS_PERCENT / 100;
        if (equity <= dayBaselineEquity - dailyLossLimitUsd) continue;

        const m1Slice = m1.slice(Math.max(0, i - 350), i + 1);
        // Higher-timeframe candles are timestamped at candle open. Expose them
        // only after their full duration has closed to prevent look-ahead bias.
        while (
          m5Cursor < m5.length &&
          timeMs(m5[m5Cursor]!) + 5 * 60_000 <= nowMs
        ) m5Cursor += 1;
        while (
          m15Cursor < m15.length &&
          timeMs(m15[m15Cursor]!) + 15 * 60_000 <= nowMs
        ) m15Cursor += 1;
        while (
          h1Cursor < h1.length &&
          timeMs(h1[h1Cursor]!) + 60 * 60_000 <= nowMs
        ) h1Cursor += 1;
        const m5Slice = m5.slice(Math.max(0, m5Cursor - 350), m5Cursor);
        const m15Slice = m15.slice(Math.max(0, m15Cursor - 350), m15Cursor);
        const h1Slice = h1.slice(Math.max(0, h1Cursor - 350), h1Cursor);
        if (m5Slice.length < 80 || m15Slice.length < 80 || h1Slice.length < 60) continue;

        const rawSignal = evaluateManualReversalScalpSignal(m1Slice, m5Slice, m15Slice, h1Slice, {
          takeProfitR: TP_R_MULT,
          frequency: SCALP_FREQUENCY,
        });
        if (!rawSignal) continue;
        const signal = widenSignal(rawSignal);
        if (
          openTrades.some((item) => item.trade.direction !== signal.direction)
        ) continue;

        const riskCheck = checkAutoRisk({
          symbol: SYMBOL_CODE,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          lot: LOT,
          accountSizeUsd: ACCOUNT_SIZE_USD,
          maxLossPercentPerTrade: MAX_LOSS_PERCENT,
        });
        if (!riskCheck.allowed) continue;

        const reservedRiskUsd = openTrades.reduce((sum, item) => sum + item.riskUsd, 0);
        if (
          equity - reservedRiskUsd - riskCheck.estimatedLossUsd <
          dayBaselineEquity - dailyLossLimitUsd
        ) continue;

        const exit = simulateExit(i, m1, signal);
        const pnlUsd =
          exit.outcome === "WIN"
            ? pnlUsdForR(signal.entry, signal.stopLoss, TP_R_MULT, LOT)
            : exit.outcome === "LOSS"
              ? -pnlUsdForR(signal.entry, signal.stopLoss, 1, LOT)
              : pnlUsdForR(signal.entry, signal.stopLoss, exit.r, LOT);
        const trade: Trade = {
          direction: signal.direction,
          entryTime: m1[i]!.time,
          exitTime: exit.exitTime,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          outcome: exit.outcome,
          pnlUsd,
          r: exit.r,
          holdMinutes: exit.holdMinutes,
          reason: signal.reason,
        };
        openTrades.push({
          trade,
          exitIndex: m1IndexByTime.get(exit.exitTime) ?? i + Math.max(1, exit.holdMinutes),
          riskUsd: riskCheck.estimatedLossUsd,
        });
        tradesToday += 1;
      }

      for (const item of openTrades.sort((a, b) => a.exitIndex - b.exitIndex)) {
        equity = Number((equity + item.trade.pnlUsd).toFixed(2));
        equityCurve.push(equity);
        trades.push(item.trade);
      }

      const wins = trades.filter((trade) => trade.outcome === "WIN").length;
      const losses = trades.filter((trade) => trade.outcome === "LOSS").length;
      const timeouts = trades.filter((trade) => trade.outcome === "TIMEOUT").length;
      const protectedExits = trades.filter((trade) => trade.outcome === "PROTECTED").length;
      const profitableTrades = trades.filter((trade) => trade.pnlUsd > 0).length;
      const losingTrades = trades.filter((trade) => trade.pnlUsd < 0).length;
      const flatTrades = trades.length - profitableTrades - losingTrades;
      const dailyPnl = new Map<string, number>();
      for (const trade of trades) {
        const key = dayKey(timeMs({ time: trade.entryTime } as Candle));
        dailyPnl.set(key, Number(((dailyPnl.get(key) ?? 0) + trade.pnlUsd).toFixed(2)));
      }
      const dailyResults = [...dailyPnl.entries()].map(([day, pnl]) => ({ day, pnl }));
      const bestDay = dailyResults.reduce<{ day: string; pnl: number } | null>(
        (best, item) => (best === null || item.pnl > best.pnl ? item : best),
        null,
      );
      const worstDay = dailyResults.reduce<{ day: string; pnl: number } | null>(
        (worst, item) => (worst === null || item.pnl < worst.pnl ? item : worst),
        null,
      );
      const configuredDailyLossUsd = MAX_DAILY_LOSS_USD > 0
        ? MAX_DAILY_LOSS_USD
        : ACCOUNT_SIZE_USD * MAX_DAILY_LOSS_PERCENT / 100;
      const daysReachingDailyStop = dailyResults.filter(
        (item) => item.pnl <= -configuredDailyLossUsd,
      ).length;
      const monthlyPnl = new Map<string, number>();
      for (const item of dailyResults) {
        const month = item.day.slice(0, 7);
        monthlyPnl.set(month, Number(((monthlyPnl.get(month) ?? 0) + item.pnl).toFixed(2)));
      }
      const monthlyResults = [...monthlyPnl.entries()].map(([month, pnl]) => ({ month, pnl }));
      const netPnl = Number((equity - ACCOUNT_SIZE_USD).toFixed(2));
      const avgPnl = trades.length
        ? Number((trades.reduce((sum, trade) => sum + trade.pnlUsd, 0) / trades.length).toFixed(2))
        : 0;
      const winRate = trades.length ? Number(((wins / trades.length) * 100).toFixed(1)) : 0;
      const profitFactor =
        Math.abs(trades.filter((trade) => trade.pnlUsd < 0).reduce((sum, trade) => sum + trade.pnlUsd, 0)) > 0
          ? Number(
              (
                trades.filter((trade) => trade.pnlUsd > 0).reduce((sum, trade) => sum + trade.pnlUsd, 0) /
                Math.abs(trades.filter((trade) => trade.pnlUsd < 0).reduce((sum, trade) => sum + trade.pnlUsd, 0))
              ).toFixed(2),
            )
          : null;

      console.log(
        JSON.stringify(
          {
            params: {
              symbol: SYMBOL,
              accountSizeUsd: ACCOUNT_SIZE_USD,
              lot: LOT,
              maxLossPercent: MAX_LOSS_PERCENT,
              m1Bars: m1.length,
              from: m1[0]?.time,
              to: m1.at(-1)?.time,
              tpR: TP_R_MULT,
              slMult: SL_MULT,
              maxHoldMinutes: MAX_HOLD_MINUTES,
              cooldownMinutes: COOLDOWN_MINUTES,
              maxTradesPerDay: MAX_TRADES_PER_DAY,
              maxOpenTrades: MAX_OPEN_TRADES,
              maxDailyLossPercent: MAX_DAILY_LOSS_PERCENT,
              maxDailyLossUsd: MAX_DAILY_LOSS_USD || null,
              profitProtection: PROFIT_PROTECTION,
              spreadPrice: SPREAD_PRICE,
              tradeWindows: TRADE_WINDOWS || "24/24",
              tradeTimezone: TRADE_TIMEZONE,
              scalpFrequency: SCALP_FREQUENCY,
              note: "same manual/auto aggressive scalp engine; same-bar SL/TP collision is counted as SL",
            },
            summary: {
              trades: trades.length,
              wins,
              losses,
              protectedExits,
              timeouts,
              winRate,
              profitableTrades,
              losingTrades,
              flatTrades,
              profitableTradeRate: trades.length
                ? Number(((profitableTrades / trades.length) * 100).toFixed(1))
                : 0,
              activeTradingDays: dailyResults.length,
              averagePnlPerActiveDay: dailyResults.length
                ? Number((netPnl / dailyResults.length).toFixed(2))
                : 0,
              bestDay,
              worstDay,
              daysReachingDailyStop,
              monthlyResults,
              startEquity: ACCOUNT_SIZE_USD,
              endEquity: equity,
              netPnl,
              netPnlPercent: Number(((netPnl / ACCOUNT_SIZE_USD) * 100).toFixed(2)),
              maxDrawdownUsd: maxDrawdown(equityCurve),
              avgPnl,
              profitFactor,
            },
            recentTrades: trades.slice(-10),
          },
          null,
          2,
        ),
      );
    },
    120_000,
  );
});
