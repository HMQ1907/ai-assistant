import { describe, expect, it } from "vitest";
import { fetchBacktestCandlesPaged } from "../../server/backtest/backtestData";
import {
  defaultXauMicroScalpBacktestConfig,
  runXauMicroScalpBacktest,
  type XauMicroScalpBacktestConfig,
} from "../../server/backtest/xauMicroScalpBacktester";
import { defaultXauMicroScalpConfig } from "../../server/strategy/xauMicroScalpStrategy";
import type {
  XauBacktestResult,
  XauBacktestTrade,
} from "../../server/backtest/xauPullbackBacktester";
import type { Candle } from "../../types/trading";

const BRIDGE = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSDm";

const M1_COUNT = Number(process.env.BACKTEST_M1_BARS || 20000);
const M5_COUNT = Number(process.env.BACKTEST_M5_BARS || 4500);
const M15_COUNT = Number(process.env.BACKTEST_M15_BARS || 1500);
const H1_COUNT = Number(process.env.BACKTEST_H1_BARS || 500);
const H4_COUNT = Number(process.env.BACKTEST_H4_BARS || 150);

/** Khớp .env live: vốn $100, lot 0.01, cửa sổ 14:00-21:30. */
const liveConfig: XauMicroScalpBacktestConfig = {
  ...defaultXauMicroScalpBacktestConfig,
  spreadPrice: Number(process.env.BACKTEST_SPREAD_PRICE || 0.3),
  maxHoldBars: Number(process.env.BACKTEST_MAX_HOLD_M1_BARS || 480),
  cooldownBars: Number(process.env.BACKTEST_COOLDOWN_M1_BARS || 0),
  lot: Number(process.env.BACKTEST_LOT || 0.01),
  accountStartUsd: Number(process.env.BACKTEST_ACCOUNT_SIZE_USD || 100),
  maxLossPercentPerTrade: Number(process.env.BACKTEST_MAX_LOSS_PERCENT || 10),
  maxTradesPerDay: Number(process.env.BACKTEST_MAX_TRADES_PER_DAY || 8),
  tradeWindows: process.env.BACKTEST_TRADE_WINDOWS || "14:00-21:30",
  timeZone: process.env.BACKTEST_TIMEZONE || "Asia/Saigon",
};

function dirStat(trades: XauBacktestTrade[]): string {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const totR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  const winPct = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : "--";
  return `${trades.length}@${winPct}%/${totR >= 0 ? "+" : ""}${totR.toFixed(1)}R`;
}

function line(label: string, r: XauBacktestResult): string {
  return [
    label.padEnd(30),
    `n=${String(r.trades).padStart(3)}`,
    `skip=${String(r.skippedByRiskCap).padStart(3)}`,
    `win%=${String(r.winRate).padStart(5)}`,
    `W/L/BE=${r.wins}/${r.losses}/${r.breakeven}`.padEnd(13),
    `expR=${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(3)}`.padEnd(12),
    `PF=${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf"}`.padEnd(8),
    `net$=${r.netUsd >= 0 ? "+" : ""}${r.netUsd.toFixed(2)}`.padEnd(12),
    `maxDD$=${r.maxDrawdownUsd.toFixed(2)}`.padEnd(14),
    `BUY ${dirStat(r.tradeList.filter((t) => t.direction === "BUY"))}`.padEnd(20),
    `SELL ${dirStat(r.tradeList.filter((t) => t.direction === "SELL"))}`,
  ].join("  ");
}

describe("XAUUSD micro-scalp (mode auto-bot thật) - backtest MT5", () => {
  it(
    "in win rate + expectancy cho config live và các biến thể",
    async () => {
      let m1: Candle[];
      let m5: Candle[];
      let m15: Candle[];
      let h1: Candle[];
      let h4: Candle[];
      try {
        [m1, m5, m15, h1, h4] = await Promise.all([
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "M1", M1_COUNT),
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "M5", M5_COUNT),
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "M15", M15_COUNT),
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "H1", H1_COUNT),
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "H4", H4_COUNT),
        ]);
      } catch (error) {
        console.warn(
          "[micro-scalp-backtest] skip: cannot fetch MT5 candles:",
          (error as Error).message,
        );
        return;
      }

      if (m1.length < 500) {
        console.warn("[micro-scalp-backtest] skip: insufficient M1 bars", m1.length);
        return;
      }

      const variants: Array<{ label: string; patch: Partial<XauMicroScalpBacktestConfig> }> = [
        { label: "LIVE (BUY-only, lot .01)", patch: {} },
        {
          label: "BUY+SELL (cũ)",
          patch: {
            scalpConfig: { ...defaultXauMicroScalpConfig, allowSell: true },
          },
        },
        {
          label: "BUY+SELL, trend-day OFF",
          patch: {
            scalpConfig: {
              ...defaultXauMicroScalpConfig,
              allowSell: true,
              trendDayEnabled: false,
            },
          },
        },
        { label: "BUY-only, lot .02", patch: { lot: 0.02 } },
      ];

      console.info(`\n[micro-scalp-backtest] period: ${m1[0]?.time} -> ${m1.at(-1)?.time}`);
      console.info(
        `[micro-scalp-backtest] vốn $${liveConfig.accountStartUsd}, cửa sổ ${liveConfig.tradeWindows}\n`,
      );

      let liveResult: XauBacktestResult | null = null;
      for (const variant of variants) {
        const cfg: XauMicroScalpBacktestConfig = {
          ...liveConfig,
          ...variant.patch,
          scalpConfig: variant.patch.scalpConfig ?? {
            ...defaultXauMicroScalpConfig,
            allowSell: false,
          },
        };
        const result = runXauMicroScalpBacktest(m1, m5, m15, h1, h4, cfg);
        console.info(line(variant.label, result));
        liveResult ??= result;
      }

      expect(liveResult).not.toBeNull();
      expect(liveResult!.bars).toBeGreaterThan(0);
      // BUY-only: không được phép sinh lệnh SELL nào.
      expect(liveResult!.tradeList.every((t) => t.direction === "BUY")).toBe(true);
    },
    180_000,
  );
});
