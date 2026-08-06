import { describe, expect, it } from "vitest";
import {
  defaultXauMicroScalpBacktestConfig,
  runXauMicroScalpBacktest,
  type XauMicroScalpBacktestConfig,
} from "../../server/backtest/xauMicroScalpBacktester";
import {
  defaultXauMicroScalpConfig,
  type XauMicroScalpConfig,
} from "../../server/strategy/xauMicroScalpStrategy";
import type {
  XauBacktestResult,
  XauBacktestTrade,
} from "../../server/backtest/xauPullbackBacktester";
import type { Candle } from "../../types/trading";
import { loadCandlesCached } from "./candleCache";

const BRIDGE = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSDm";

const M1_COUNT = Number(process.env.SWEEP_M1_BARS || 90000);
const M5_COUNT = Number(process.env.SWEEP_M5_BARS || 20000);
const M15_COUNT = Number(process.env.SWEEP_M15_BARS || 8000);
const H1_COUNT = Number(process.env.SWEEP_H1_BARS || 3000);
const H4_COUNT = Number(process.env.SWEEP_H4_BARS || 900);

const baseConfig: XauMicroScalpBacktestConfig = {
  ...defaultXauMicroScalpBacktestConfig,
  spreadPrice: 0.3,
  maxHoldBars: 480,
  cooldownBars: 0,
  lot: 0.01,
  accountStartUsd: 100,
  maxLossPercentPerTrade: 10,
  maxTradesPerDay: 8,
  tradeWindows: "14:00-21:30",
  timeZone: "Asia/Saigon",
  scalpConfig: { ...defaultXauMicroScalpConfig, allowSell: false },
};

interface Variant {
  label: string;
  scalp?: Partial<XauMicroScalpConfig>;
  bt?: Partial<Omit<XauMicroScalpBacktestConfig, "scalpConfig">>;
}

function buildConfig(variant: Variant): XauMicroScalpBacktestConfig {
  return {
    ...baseConfig,
    ...variant.bt,
    scalpConfig: { ...baseConfig.scalpConfig, ...variant.scalp },
  };
}

function dirStat(trades: XauBacktestTrade[]): string {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const totR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  const winPct = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : "--";
  return `${trades.length}@${winPct}%/${totR >= 0 ? "+" : ""}${totR.toFixed(1)}R`;
}

function line(label: string, r: XauBacktestResult): string {
  const totR = r.tradeList.reduce((sum, t) => sum + t.rMultiple, 0);
  return [
    label.padEnd(34),
    `n=${String(r.trades).padStart(3)}`,
    `win%=${String(r.winRate).padStart(5)}`,
    `W/L/BE=${r.wins}/${r.losses}/${r.breakeven}`.padEnd(14),
    `expR=${totR / Math.max(1, r.trades) >= 0 ? "+" : ""}${(totR / Math.max(1, r.trades)).toFixed(3)}`.padEnd(
      12,
    ),
    `totR=${totR >= 0 ? "+" : ""}${totR.toFixed(1)}`.padEnd(12),
    `PF=${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf"}`.padEnd(8),
    `net$=${r.netUsd >= 0 ? "+" : ""}${r.netUsd.toFixed(2)}`.padEnd(12),
    `DD$=${r.maxDrawdownUsd.toFixed(2)}`.padEnd(11),
    `B ${dirStat(r.tradeList.filter((t) => t.direction === "BUY"))}`.padEnd(20),
    `S ${dirStat(r.tradeList.filter((t) => t.direction === "SELL"))}`,
  ].join(" ");
}

/** Chia đôi theo thời gian để tách in-sample / out-of-sample. */
function splitAt(candles: Candle[], pivotTime: string): [Candle[], Candle[]] {
  const idx = candles.findIndex((c) => c.time >= pivotTime);
  if (idx < 0) return [candles, []];
  return [candles.slice(0, idx), candles.slice(idx)];
}

const VARIANTS: Variant[] = [
  { label: "BUY-only (live hiện tại)", scalp: {} },
  { label: "BUY+SELL", scalp: { allowSell: true } },
  { label: "SELL-only", scalp: { allowBuy: false, allowSell: true } },
  { label: "BUY+SELL, trend-day OFF", scalp: { allowSell: true, trendDayEnabled: false } },
  { label: "BUY-only, trend-day OFF", scalp: { trendDayEnabled: false } },
];

describe("XAU micro-scalp — sweep tham số trên data dài", () => {
  it(
    "so sánh biến thể + kiểm tra in-sample / out-of-sample",
    async () => {
      let m1: Candle[];
      let m5: Candle[];
      let m15: Candle[];
      let h1: Candle[];
      let h4: Candle[];
      try {
        [m1, m5, m15, h1, h4] = await Promise.all([
          loadCandlesCached(BRIDGE, SYMBOL, "M1", M1_COUNT),
          loadCandlesCached(BRIDGE, SYMBOL, "M5", M5_COUNT),
          loadCandlesCached(BRIDGE, SYMBOL, "M15", M15_COUNT),
          loadCandlesCached(BRIDGE, SYMBOL, "H1", H1_COUNT),
          loadCandlesCached(BRIDGE, SYMBOL, "H4", H4_COUNT),
        ]);
      } catch (error) {
        console.warn("[sweep] skip: cannot fetch MT5 candles:", (error as Error).message);
        return;
      }
      if (m1.length < 5000) {
        console.warn("[sweep] skip: insufficient M1 bars", m1.length);
        return;
      }

      const pivot = m1[Math.floor(m1.length / 2)]?.time ?? "";
      const [m1Is, m1Oos] = splitAt(m1, pivot);

      console.info(`\n[sweep] full: ${m1[0]?.time} -> ${m1.at(-1)?.time} (${m1.length} nến M1)`);
      console.info(`[sweep] pivot IS/OOS: ${pivot}\n`);

      console.info("=== FULL ===");
      const results = VARIANTS.map((variant) => {
        const result = runXauMicroScalpBacktest(m1, m5, m15, h1, h4, buildConfig(variant));
        console.info(line(variant.label, result));
        return result;
      });

      console.info("\n=== IN-SAMPLE (nửa đầu) ===");
      for (const variant of VARIANTS) {
        console.info(
          line(variant.label, runXauMicroScalpBacktest(m1Is, m5, m15, h1, h4, buildConfig(variant))),
        );
      }

      console.info("\n=== OUT-OF-SAMPLE (nửa sau) ===");
      for (const variant of VARIANTS) {
        console.info(
          line(
            variant.label,
            runXauMicroScalpBacktest(m1Oos, m5, m15, h1, h4, buildConfig(variant)),
          ),
        );
      }

      expect(results[0]?.bars).toBeGreaterThan(0);
    },
    900_000,
  );
});
