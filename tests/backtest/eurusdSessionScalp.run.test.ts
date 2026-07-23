import { describe, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBacktestCandles } from "../../server/backtest/backtestData";
import {
  evaluateEurusdScalpSignal,
  defaultEurusdScalpConfig,
  type EurusdScalpConfig,
} from "../../server/strategy/eurusdScalpStrategy";
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
  session: string;
}

const BRIDGE_URL = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const SYMBOL = process.env.BACKTEST_SYMBOL || "EURUSDm";
const SYMBOL_CODE: SymbolCode = "EURUSD";
const ACCOUNT_SIZE_USD = Number(process.env.BACKTEST_ACCOUNT_SIZE_USD || 100);
const LOT = Number(process.env.BACKTEST_LOT || 0.05);
const MAX_LOSS_PERCENT = Number(process.env.BACKTEST_MAX_LOSS_PERCENT || 15);
const MAX_HOLD_MINUTES = Number(process.env.BACKTEST_MAX_HOLD_MINUTES || 60);
const COOLDOWN_MINUTES = Number(process.env.BACKTEST_COOLDOWN_MINUTES || 5);
const MAX_TRADES_PER_DAY = Number(process.env.BACKTEST_MAX_TRADES_PER_DAY || 8);
const MAX_DAILY_LOSS_PERCENT = Number(process.env.BACKTEST_MAX_DAILY_LOSS_PERCENT || 10);
const MAX_DAILY_LOSS_USD = Number(process.env.BACKTEST_MAX_DAILY_LOSS_USD || 0);
const PROFIT_PROTECTION = process.env.BACKTEST_PROFIT_PROTECTION !== "false";
const SPREAD_PIPS = Number(process.env.BACKTEST_SPREAD_PIPS || 0.8);
const SPREAD_PRICE = SPREAD_PIPS * 0.0001;
const M1_BARS = Number(process.env.BACKTEST_M1_BARS || 6000);
const TP_R_MULT = Number(process.env.BACKTEST_TP_R_MULT || 1.5);
const DATA_DIR = process.env.BACKTEST_DATA_DIR || "";
const TRADE_TIMEZONE = process.env.TRADE_SCANNER_TIMEZONE || "Asia/Saigon";

const LONDON_NY_WINDOW = { startHour: 14, endHour: 20 };

const STRATEGY_CONFIG: EurusdScalpConfig = {
  ...defaultEurusdScalpConfig,
  tpRMultiple: TP_R_MULT,
};

function timeMs(candle: Candle): number {
  return new Date(candle.time).getTime();
}

function getHourInTz(timestampMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date(timestampMs));
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

function getSessionLabel(timestampMs: number): string | null {
  const hour = getHourInTz(timestampMs, TRADE_TIMEZONE);
  if (hour >= LONDON_NY_WINDOW.startHour && hour < LONDON_NY_WINDOW.endHour) return "LONDON_NY";
  return null;
}

function isInTradeWindow(timestampMs: number): boolean {
  return getSessionLabel(timestampMs) !== null;
}

function lossUsd(entry: number, stopLoss: number, lot: number): number {
  const slPips = Math.abs(entry - stopLoss) / 0.0001;
  return slPips * 10 * lot;
}

function pnlUsdForR(entry: number, stopLoss: number, r: number, lot: number): number {
  return Number((lossUsd(entry, stopLoss, lot) * r).toFixed(2));
}

function simulateExit(
  entryIndex: number,
  m1: Candle[],
  signal: NonNullable<ReturnType<typeof evaluateEurusdScalpSignal>>,
): Pick<Trade, "exitTime" | "outcome" | "r" | "holdMinutes"> {
  const entryTimeMs = timeMs(m1[entryIndex]!);
  const risk = Math.abs(signal.entry - signal.stopLoss);
  const maxBars = Math.max(1, MAX_HOLD_MINUTES);
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
      const stopR =
        signal.direction === "BUY"
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
      const favorableMove =
        signal.direction === "BUY"
          ? candle.close - signal.entry
          : signal.entry - candle.close;
      const reachedR = favorableMove / risk;
      const lockedR = reachedR >= 1.5 ? 0.5 : reachedR >= 1 ? 0 : null;
      if (lockedR !== null) {
        const candidate =
          signal.direction === "BUY"
            ? signal.entry + risk * lockedR + SPREAD_PRICE
            : signal.entry - risk * lockedR - SPREAD_PRICE;
        const validAgainstPrice =
          signal.direction === "BUY"
            ? candidate < candle.close
            : candidate > candle.close;
        const safer =
          signal.direction === "BUY"
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

function dayKey(timestampMs: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TRADE_TIMEZONE,
  }).format(new Date(timestampMs));
}

async function loadCandles(
  timeframe: "M1" | "M5" | "M15" | "H1",
  count: number,
): Promise<Candle[]> {
  if (DATA_DIR) {
    const file = join(DATA_DIR, `${SYMBOL}_${timeframe}.json`);
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf8")) as Candle[];
    }
  }
  return fetchBacktestCandles(BRIDGE_URL, SYMBOL, timeframe, count);
}

describe("EURUSD session scalp backtest (London-NY overlap)", () => {
  it(
    "runs on MT5 bridge candles",
    async () => {
      let m1: Candle[];
      let m5: Candle[];
      let m15: Candle[];
      let h1: Candle[];
      try {
        [m1, m5, m15, h1] = await Promise.all([
          loadCandles("M1", M1_BARS),
          loadCandles("M5", 3000),
          loadCandles("M15", 1500),
          loadCandles("H1", 600),
        ]);
      } catch (error) {
        console.warn(
          "[eurusd-session-scalp-backtest] skip: cannot fetch MT5 candles:",
          (error as Error).message,
        );
        return;
      }

      const trades: Trade[] = [];
      let nextAllowedTimeMs = 0;
      let equity = ACCOUNT_SIZE_USD;
      const equityCurve = [equity];
      let m5Cursor = 0;
      let m15Cursor = 0;
      let h1Cursor = 0;
      let currentDay = "";
      let dayBaselineEquity = equity;
      let tradesToday = 0;

      for (let i = 300; i < m1.length - 2; i += 1) {
        const nowMs = timeMs(m1[i]!);
        const scanDay = dayKey(nowMs);
        if (scanDay !== currentDay) {
          currentDay = scanDay;
          dayBaselineEquity = equity;
          tradesToday = 0;
        }

        if (nowMs < nextAllowedTimeMs) continue;
        if (!isInTradeWindow(nowMs)) continue;
        if (tradesToday >= MAX_TRADES_PER_DAY) continue;

        const dailyLossLimitUsd =
          MAX_DAILY_LOSS_USD > 0
            ? MAX_DAILY_LOSS_USD
            : (dayBaselineEquity * MAX_DAILY_LOSS_PERCENT) / 100;
        if (equity <= dayBaselineEquity - dailyLossLimitUsd) continue;

        while (m5Cursor < m5.length && timeMs(m5[m5Cursor]!) + 5 * 60_000 <= nowMs)
          m5Cursor += 1;
        while (m15Cursor < m15.length && timeMs(m15[m15Cursor]!) + 15 * 60_000 <= nowMs)
          m15Cursor += 1;
        while (h1Cursor < h1.length && timeMs(h1[h1Cursor]!) + 60 * 60_000 <= nowMs)
          h1Cursor += 1;

        const m5Slice = m5.slice(Math.max(0, m5Cursor - 350), m5Cursor);
        const m15Slice = m15.slice(Math.max(0, m15Cursor - 350), m15Cursor);
        const h1Slice = h1.slice(Math.max(0, h1Cursor - 350), h1Cursor);
        if (m5Slice.length < 80 || m15Slice.length < 60 || h1Slice.length < 60) continue;

        const signal = evaluateEurusdScalpSignal(m5Slice, m15Slice, h1Slice, STRATEGY_CONFIG);
        if (!signal) continue;

        const riskCheck = checkAutoRisk({
          symbol: SYMBOL_CODE,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          lot: LOT,
          accountSizeUsd: ACCOUNT_SIZE_USD,
          maxLossPercentPerTrade: MAX_LOSS_PERCENT,
        });
        if (!riskCheck.allowed) continue;

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
          session: getSessionLabel(nowMs) ?? "UNKNOWN",
        };

        equity = Number((equity + pnlUsd).toFixed(2));
        equityCurve.push(equity);
        trades.push(trade);
        tradesToday += 1;
        nextAllowedTimeMs = timeMs(
          m1[Math.min(i + Math.max(1, exit.holdMinutes), m1.length - 1)]!,
        ) + COOLDOWN_MINUTES * 60_000;
      }

      const wins = trades.filter((t) => t.outcome === "WIN").length;
      const losses = trades.filter((t) => t.outcome === "LOSS").length;
      const protectedExits = trades.filter((t) => t.outcome === "PROTECTED").length;
      const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
      const profitableTrades = trades.filter((t) => t.pnlUsd > 0).length;
      const losingTrades = trades.filter((t) => t.pnlUsd < 0).length;

      const londonNyTrades = trades.filter((t) => t.session === "LONDON_NY");
      const londonNyPnl = londonNyTrades.reduce((s, t) => s + t.pnlUsd, 0);
      const londonNyWins = londonNyTrades.filter((t) => t.outcome === "WIN").length;

      const dailyPnl = new Map<string, number>();
      for (const trade of trades) {
        const key = dayKey(timeMs({ time: trade.entryTime } as Candle));
        dailyPnl.set(key, Number(((dailyPnl.get(key) ?? 0) + trade.pnlUsd).toFixed(2)));
      }
      const dailyResults = [...dailyPnl.entries()].map(([day, pnl]) => ({ day, pnl }));
      const bestDay = dailyResults.reduce<{ day: string; pnl: number } | null>(
        (best, item) => (!best || item.pnl > best.pnl ? item : best),
        null,
      );
      const worstDay = dailyResults.reduce<{ day: string; pnl: number } | null>(
        (worst, item) => (!worst || item.pnl < worst.pnl ? item : worst),
        null,
      );

      const netPnl = Number((equity - ACCOUNT_SIZE_USD).toFixed(2));
      const winRate = trades.length ? Number(((wins / trades.length) * 100).toFixed(1)) : 0;
      const profitFactor =
        Math.abs(trades.filter((t) => t.pnlUsd < 0).reduce((s, t) => s + t.pnlUsd, 0)) > 0
          ? Number(
              (
                trades.filter((t) => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0) /
                Math.abs(
                  trades.filter((t) => t.pnlUsd < 0).reduce((s, t) => s + t.pnlUsd, 0),
                )
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
              maxHoldMinutes: MAX_HOLD_MINUTES,
              cooldownMinutes: COOLDOWN_MINUTES,
              maxTradesPerDay: MAX_TRADES_PER_DAY,
              maxDailyLossPercent: MAX_DAILY_LOSS_PERCENT,
              maxDailyLossUsd: MAX_DAILY_LOSS_USD || null,
              profitProtection: PROFIT_PROTECTION,
              spreadPips: SPREAD_PIPS,
              sessions: {
                londonNY: `${LONDON_NY_WINDOW.startHour}:00-${LONDON_NY_WINDOW.endHour}:00 ${TRADE_TIMEZONE}`,
              },
              strategyConfig: STRATEGY_CONFIG,
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
              startEquity: ACCOUNT_SIZE_USD,
              endEquity: equity,
              netPnl,
              netPnlPercent: Number(((netPnl / ACCOUNT_SIZE_USD) * 100).toFixed(2)),
              maxDrawdownUsd: maxDrawdown(equityCurve),
              profitFactor,
              activeTradingDays: dailyResults.length,
              bestDay,
              worstDay,
            },
            sessionBreakdown: {
              londonNY: {
                trades: londonNyTrades.length,
                wins: londonNyWins,
                winRate: londonNyTrades.length
                  ? Number(((londonNyWins / londonNyTrades.length) * 100).toFixed(1))
                  : 0,
                pnl: Number(londonNyPnl.toFixed(2)),
              },
            },
            dailyResults: dailyResults.slice(-20),
            recentTrades: trades.slice(-15),
          },
          null,
          2,
        ),
      );
    },
    120_000,
  );
});
