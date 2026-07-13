import { describe, it } from "vitest";
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
  outcome: "WIN" | "LOSS" | "TIMEOUT";
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
const M1_BARS = Number(process.env.BACKTEST_M1_BARS || 6000);
const TP_R_MULT = Number(process.env.BACKTEST_TP_R_MULT || process.env.AUTO_SCALP_TP_R || 1.5);
const SL_MULT = Number(process.env.BACKTEST_SL_MULT || 1);
const TRADE_WINDOWS = process.env.BACKTEST_TRADE_WINDOWS ?? process.env.TRADE_SCANNER_WINDOWS ?? "";
const TRADE_TIMEZONE = process.env.TRADE_SCANNER_TIMEZONE || "Asia/Saigon";
const SCALP_FREQUENCY =
  (process.env.BACKTEST_SCALP_FREQUENCY || process.env.AUTO_SCALP_FREQUENCY) === "high"
    ? "high"
    : "normal";

function timeMs(candle: Candle): number {
  return new Date(candle.time).getTime();
}

function closedUntil(candles: Candle[], timestampMs: number): Candle[] {
  return candles.filter((candle) => timeMs(candle) <= timestampMs);
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

  for (let offset = 1; offset <= maxBars && entryIndex + offset < m1.length; offset += 1) {
    const candle = m1[entryIndex + offset]!;
    const slHit =
      signal.direction === "BUY"
        ? candle.low <= signal.stopLoss
        : candle.high >= signal.stopLoss;
    const tpHit =
      signal.direction === "BUY"
        ? candle.high >= signal.takeProfit
        : candle.low <= signal.takeProfit;

    if (slHit || tpHit) {
      // Neu cung mot nen quet ca SL va TP thi gia lap bao thu: tinh SL truoc.
      const outcome = slHit ? "LOSS" : "WIN";
      return {
        exitTime: candle.time,
        outcome,
        r: outcome === "WIN" ? TP_R_MULT : -1,
        holdMinutes: Math.round((timeMs(candle) - entryTimeMs) / 60_000),
      };
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
          fetchBacktestCandles(BRIDGE_URL, SYMBOL, "M1", M1_BARS),
          fetchBacktestCandles(BRIDGE_URL, SYMBOL, "M5", 3000),
          fetchBacktestCandles(BRIDGE_URL, SYMBOL, "M15", 1500),
          fetchBacktestCandles(BRIDGE_URL, SYMBOL, "H1", 600),
        ]);
      } catch (error) {
        console.warn("[eurusd-scalp-backtest] skip: cannot fetch MT5 candles:", (error as Error).message);
        return;
      }

      const trades: Trade[] = [];
      let nextAllowedTimeMs = 0;
      let equity = ACCOUNT_SIZE_USD;
      const equityCurve = [equity];

      for (let i = 300; i < m1.length - 2; i += 1) {
        const nowMs = timeMs(m1[i]!);
        if (nowMs < nextAllowedTimeMs) continue;
        if (!isInsideTradeWindow(nowMs)) continue;

        const m1Slice = m1.slice(0, i + 1);
        const m5Slice = closedUntil(m5, nowMs);
        const m15Slice = closedUntil(m15, nowMs);
        const h1Slice = closedUntil(h1, nowMs);
        if (m5Slice.length < 80 || m15Slice.length < 80 || h1Slice.length < 60) continue;

        const rawSignal = evaluateManualReversalScalpSignal(m1Slice, m5Slice, m15Slice, h1Slice, {
          takeProfitR: TP_R_MULT,
          frequency: SCALP_FREQUENCY,
        });
        if (!rawSignal) continue;
        const signal = widenSignal(rawSignal);

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
        equity = Number((equity + pnlUsd).toFixed(2));
        equityCurve.push(equity);

        trades.push({
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
        });

        nextAllowedTimeMs = new Date(exit.exitTime).getTime() + COOLDOWN_MINUTES * 60_000;
      }

      const wins = trades.filter((trade) => trade.outcome === "WIN").length;
      const losses = trades.filter((trade) => trade.outcome === "LOSS").length;
      const timeouts = trades.filter((trade) => trade.outcome === "TIMEOUT").length;
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
              tradeWindows: TRADE_WINDOWS || "24/24",
              tradeTimezone: TRADE_TIMEZONE,
              scalpFrequency: SCALP_FREQUENCY,
              note: "same manual/auto aggressive scalp engine; same-bar SL/TP collision is counted as SL",
            },
            summary: {
              trades: trades.length,
              wins,
              losses,
              timeouts,
              winRate,
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
