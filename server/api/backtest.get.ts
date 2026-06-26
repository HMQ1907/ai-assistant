import { createError, getQuery } from "h3";
import { tradingRules } from "../config/tradingRules";
import { fetchBacktestCandles } from "../backtest/backtestData";
import {
  defaultBacktestConfig,
  runBacktest,
  type BacktestResult,
} from "../backtest/backtester";
import { defaultRuleStrategyConfig } from "../strategy/ruleStrategy";
import type { Timeframe } from "../../types/trading";

/**
 * GET /api/backtest?symbols=XAUUSDm&entryTf=H1&bars=1500&rr=2&spread=0.3
 * entryTf=H1  -> vào lệnh trên H1, bias H4.
 * entryTf=M15 -> vào lệnh trên M15, bias H4, trend trung gian H1 phải đồng pha.
 * Tính toán cục bộ, không tốn quota AI.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const query = getQuery(event);

  const symbols = parseSymbols(query.symbols, [config.mt5Symbol, config.mt5EurUsdSymbol]);
  const entryTf: Timeframe = query.entryTf === "M15" ? "M15" : "H1";
  const bars = clampInt(query.bars, entryTf === "M15" ? 5000 : 1500, 200, 6000);
  const rr = clampNumber(query.rr, tradingRules.minRiskReward, 0.5, 10);
  const spread = clampNumber(query.spread, 0, 0, 100);
  // maxHold theo thời gian (~giờ): H1 -> bars; M15 -> bars*... ; mặc định 72h.
  const maxHoldBars = entryTf === "M15" ? 288 : 72;
  const startIndex = entryTf === "M15" ? 60 : 210;

  const backtestConfig = {
    ...defaultBacktestConfig,
    maxHoldBars: clampInt(query.maxHold, maxHoldBars, 4, 2000),
    startIndex,
    spreadPrice: spread,
    strategy: { ...defaultRuleStrategyConfig, rrTarget: rr },
  };

  const results: Array<
    Omit<BacktestResult, "tradeList"> & { recentTrades: BacktestResult["tradeList"] }
  > = [];
  const errors: Array<{ symbol: string; error: string }> = [];

  for (const symbol of symbols) {
    try {
      const entry = await fetchBacktestCandles(config.mt5BridgeUrl, symbol, entryTf, bars);
      const bias = await fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H4", 1000);
      const intermediate =
        entryTf === "M15"
          ? await fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H1", 2500)
          : undefined;
      const result = runBacktest(symbol, entry, bias, backtestConfig, intermediate);
      const { tradeList, ...summary } = result;
      results.push({ ...summary, recentTrades: tradeList.slice(-5) });
    } catch (error) {
      errors.push({ symbol, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (results.length === 0 && errors.length > 0) {
    throw createError({
      statusCode: 500,
      message: `Backtest thất bại: ${errors.map((e) => `${e.symbol}: ${e.error}`).join("; ")}`,
    });
  }

  return {
    params: { symbols, entryTf, bars, rrTarget: rr, spreadPrice: spread, maxHoldBars: backtestConfig.maxHoldBars },
    results,
    errors,
  };
});

function parseSymbols(value: unknown, fallback: string[]): string[] {
  const cleanFallback = fallback.filter((item): item is string => Boolean(item));
  if (typeof value !== "string" || value.trim() === "") return cleanFallback;
  const parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
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
