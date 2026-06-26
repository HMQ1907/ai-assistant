import { createError, getQuery } from "h3";
import { tradingRules } from "../config/tradingRules";
import { fetchBacktestCandles } from "../backtest/backtestData";
import {
  defaultBacktestConfig,
  runBacktest,
  type BacktestResult,
} from "../backtest/backtester";
import { defaultRuleStrategyConfig } from "../strategy/ruleStrategy";

/**
 * GET /api/backtest?symbols=XAUUSDm,EURUSDm&h1bars=1500&rr=1.5&maxHold=48
 * Chạy method tất định (KHÔNG dùng AI) qua nến lịch sử MT5, trả về expectancy
 * cho từng cặp. Backtest = tính toán cục bộ, không tốn quota AI.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const query = getQuery(event);

  const symbols = parseSymbols(query.symbols, [
    config.mt5Symbol,
    config.mt5EurUsdSymbol,
  ]);
  const h1bars = clampInt(query.h1bars, 1500, 200, 6000);
  const h4bars = Math.min(6000, Math.ceil(h1bars / 4) + 300);
  const rr = clampNumber(query.rr, tradingRules.minRiskReward, 0.5, 10);
  const maxHold = clampInt(query.maxHold, defaultBacktestConfig.maxHoldBars, 4, 500);
  const spread = clampNumber(query.spread, 0, 0, 100);

  const backtestConfig = {
    ...defaultBacktestConfig,
    maxHoldBars: maxHold,
    spreadPrice: spread,
    strategy: { ...defaultRuleStrategyConfig, rrTarget: rr },
  };

  const results: Array<
    Omit<BacktestResult, "tradeList"> & { recentTrades: BacktestResult["tradeList"] }
  > = [];
  const errors: Array<{ symbol: string; error: string }> = [];

  for (const symbol of symbols) {
    try {
      const [h1, h4] = await Promise.all([
        fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H1", h1bars),
        fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H4", h4bars),
      ]);
      const result = runBacktest(symbol, h1, h4, backtestConfig);
      const { tradeList, ...summary } = result;
      results.push({ ...summary, recentTrades: tradeList.slice(-5) });
    } catch (error) {
      errors.push({
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (results.length === 0 && errors.length > 0) {
    throw createError({
      statusCode: 500,
      message: `Backtest thất bại: ${errors.map((item) => `${item.symbol}: ${item.error}`).join("; ")}`,
    });
  }

  return {
    params: { symbols, h1bars, h4bars, rrTarget: rr, maxHoldBars: maxHold },
    results,
    errors,
  };
});

function parseSymbols(value: unknown, fallback: string[]): string[] {
  const cleanFallback = fallback.filter((item): item is string => Boolean(item));
  if (typeof value !== "string" || value.trim() === "") return cleanFallback;
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : cleanFallback;
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
