import { createError, getQuery } from "h3";
import { fetchBacktestCandles } from "../../backtest/backtestData";
import {
  defaultBacktestConfig,
  runBacktest,
  type BacktestTrade,
} from "../../backtest/backtester";
import {
  defaultRuleStrategyConfig,
  type RuleStrategyConfig,
} from "../../strategy/ruleStrategy";

/**
 * GET /api/backtest/sweep?symbol=XAUUSDm&bars=3000&spread=0.3
 * Quét lưới tham số (rr, EMA, maxHold, filter), trừ phí, và kiểm độ bền bằng
 * cách tách trades làm 2 nửa (đầu kỳ vs cuối kỳ). Trả về cấu hình đạt
 * winRate>55% & rr>=1.5 và BỀN ở cả hai nửa. Không tốn quota AI.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const query = getQuery(event);

  const symbol = typeof query.symbol === "string" && query.symbol.trim()
    ? query.symbol.trim()
    : config.mt5Symbol;
  const bars = clampInt(query.bars, 3000, 500, 6000);
  const h4bars = Math.min(6000, Math.ceil(bars / 4) + 300);
  const spread = clampNumber(
    query.spread,
    /XAU/i.test(symbol) ? 0.3 : 0.0002,
    0,
    100,
  );

  let h1, h4;
  try {
    [h1, h4] = await Promise.all([
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H1", bars),
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H4", h4bars),
    ]);
  } catch (error) {
    throw createError({
      statusCode: 500,
      message: error instanceof Error ? error.message : "Không lấy được nến.",
    });
  }

  const grid = buildGrid();
  const rows = grid.map((variant) => {
    const result = runBacktest(symbol, h1, h4, {
      ...defaultBacktestConfig,
      maxHoldBars: variant.maxHoldBars,
      spreadPrice: spread,
      strategy: variant.strategy,
    });
    const split = Math.floor(result.tradeList.length * 0.6);
    const firstHalf = stats(result.tradeList.slice(0, split));
    const secondHalf = stats(result.tradeList.slice(split));
    const meetsTarget =
      result.winRate > 55 && variant.strategy.rrTarget >= 1.5 && result.trades >= 20;
    const robust =
      meetsTarget && firstHalf.expectancyR > 0 && secondHalf.expectancyR > 0;
    return {
      label: variant.label,
      rrTarget: variant.strategy.rrTarget,
      emaFast: variant.strategy.emaFast,
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
    bars: h1.length,
    spreadPrice: spread,
    note: "expectancy/winRate đã TRỪ phí. 'robust' = đạt mục tiêu và expectancy dương ở CẢ hai nửa dữ liệu.",
    targetsMet: rows.filter((row) => row.meetsTarget),
    robustConfigs: rows.filter((row) => row.robust),
    top: rows.slice(0, 12),
  };
});

interface Variant {
  label: string;
  maxHoldBars: number;
  strategy: RuleStrategyConfig;
}

function buildGrid(): Variant[] {
  const rrValues = [1.5, 1.8, 2.0];
  const emaFastValues = [20, 34];
  const maxHoldValues = [48, 72];
  const filters: Array<{ tag: string; patch: Partial<RuleStrategyConfig> }> = [
    { tag: "base", patch: {} },
    { tag: "rsi", patch: { useRsiFilter: true } },
    { tag: "structure", patch: { biasMode: "STRUCTURE" } },
    { tag: "engulfing", patch: { confirmMode: "ENGULFING" } },
  ];

  const variants: Variant[] = [];
  for (const rrTarget of rrValues) {
    for (const emaFast of emaFastValues) {
      for (const maxHoldBars of maxHoldValues) {
        for (const filter of filters) {
          variants.push({
            label: `${filter.tag}|rr${rrTarget}|ema${emaFast}|hold${maxHoldBars}`,
            maxHoldBars,
            strategy: {
              ...defaultRuleStrategyConfig,
              rrTarget,
              emaFast,
              ...filter.patch,
            },
          });
        }
      }
    }
  }
  return variants;
}

function stats(trades: BacktestTrade[]): {
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
