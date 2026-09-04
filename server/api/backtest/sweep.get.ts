import { createError, getQuery } from "h3";
import { fetchBacktestCandles } from "../../backtest/backtestData";
import { buildGrid } from "../../backtest/grid";
import {
  defaultXauIctBacktestConfig,
  runXauIctBacktest,
  type XauBacktestTrade,
} from "../../backtest/xauPullbackBacktester";

/**
 * GET /api/backtest/sweep?symbol=XAUUSDm&bars=20000&spread=0.3
 * Quét lưới tham số ICT rulebook (minTargetR, sweep depth, maxHold, filter),
 * trừ phí, và kiểm độ bền bằng cách tách trades làm 2 nửa (đầu kỳ vs cuối kỳ).
 * Trả về cấu hình đạt winRate>55% & RR>=2.0 và BỀN ở cả hai nửa. Không tốn quota AI.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const query = getQuery(event);

  const symbol = typeof query.symbol === "string" && query.symbol.trim()
    ? query.symbol.trim()
    : config.mt5Symbol;
  const m5Bars = clampInt(query.bars, 20000, 2000, 90000);
  const m15Bars = Math.min(20000, Math.ceil(m5Bars / 3) + 600);
  const h1Bars = Math.min(12000, Math.ceil(m5Bars / 12) + 400);
  const h4Bars = Math.min(6000, Math.ceil(m5Bars / 48) + 300);
  const spread = clampNumber(
    query.spread,
    /XAU/i.test(symbol) ? 0.3 : 0.0002,
    0,
    100,
  );

  let m5, m15, h1, h4;
  try {
    [m5, m15, h1, h4] = await Promise.all([
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "M5", m5Bars),
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "M15", m15Bars),
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H1", h1Bars),
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H4", h4Bars),
    ]);
  } catch (error) {
    throw createError({
      statusCode: 500,
      message: error instanceof Error ? error.message : "Không lấy được nến.",
    });
  }

  const grid = buildGrid();
  const rows = grid.map((variant) => {
    const result = runXauIctBacktest(m5, m15, h1, h4, {
      ...defaultXauIctBacktestConfig,
      maxHoldBars: variant.maxHoldBars,
      spreadPrice: spread,
      ictConfig: variant.ictConfig,
    });
    const split = Math.floor(result.tradeList.length * 0.6);
    const firstHalf = stats(result.tradeList.slice(0, split));
    const secondHalf = stats(result.tradeList.slice(split));
    const meetsTarget =
      result.winRate > 55 && variant.ictConfig.minTargetR >= 2.0 && result.trades >= 20;
    const robust =
      meetsTarget && firstHalf.expectancyR > 0 && secondHalf.expectancyR > 0;
    return {
      label: variant.label,
      minTargetR: variant.ictConfig.minTargetR,
      retestExpiryM5Bars: variant.ictConfig.retestExpiryM5Bars,
      maxHoldBars: variant.maxHoldBars,
      trades: result.trades,
      winRate: result.winRate,
      expectancyR: result.expectancyR,
      profitFactor: result.profitFactor,
      totalR: result.totalR,
      maxDrawdownR: result.maxDrawdownR,
      firstHalf,
      secondHalf,
      meetsTarget,
      robust,
    };
  });

  rows.sort((a, b) => b.expectancyR - a.expectancyR);

  return {
    symbol,
    bars: m5.length,
    spreadPrice: spread,
    note: "expectancy/winRate đã TRỪ phí. 'robust' = đạt mục tiêu và expectancy dương ở CẢ hai nửa dữ liệu.",
    targetsMet: rows.filter((row) => row.meetsTarget),
    robustConfigs: rows.filter((row) => row.robust),
    top: rows.slice(0, 12),
  };
});

function stats(trades: XauBacktestTrade[]): {
  trades: number;
  winRate: number;
  expectancyR: number;
} {
  const wins = trades.filter((trade) => trade.outcome === "WIN").length;
  const losses = trades.filter((trade) => trade.outcome === "LOSS").length;
  const totalR = trades.reduce((sum, trade) => sum + trade.rMultiple, 0);
  return {
    trades: trades.length,
    winRate: wins + losses > 0 ? round((wins / (wins + losses)) * 100) : 0,
    expectancyR: trades.length > 0 ? round(totalR / trades.length) : 0,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
