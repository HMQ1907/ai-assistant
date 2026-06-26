import { createError, getQuery } from "h3";
import { fetchBacktestCandles } from "../../backtest/backtestData";
import { defaultBacktestConfig, runBacktest } from "../../backtest/backtester";
import { buildGrid, tradeStats } from "../../backtest/grid";

/**
 * GET /api/backtest/walkforward?symbol=XAUUSDm&bars=6000&spread=0.3&splitPct=0.6
 *
 * Walk-forward TRUNG THỰC chống curve-fit:
 *   1. Tách dữ liệu: in-sample (đầu) | out-of-sample (cuối, CHƯA dùng để chọn).
 *   2. Chọn cấu hình tốt nhất CHỈ theo expectancy in-sample.
 *   3. Báo cáo hiệu quả của chính cấu hình đó trên out-of-sample.
 * OOS dương => edge thật. OOS sập => curve-fit. Không tốn quota AI.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const query = getQuery(event);

  const symbol = typeof query.symbol === "string" && query.symbol.trim()
    ? query.symbol.trim()
    : config.mt5Symbol;
  const bars = clampInt(query.bars, 6000, 1000, 6000);
  const h4bars = Math.min(6000, Math.ceil(bars / 4) + 300);
  const spread = clampNumber(query.spread, /XAU/i.test(symbol) ? 0.3 : 0.0002, 0, 100);
  const splitPct = clampNumber(query.splitPct, 0.6, 0.4, 0.8);
  const minIsTrades = clampInt(query.minIsTrades, 15, 5, 100);

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

  const splitTime = h1[Math.floor(h1.length * splitPct)]?.time ?? "";
  if (!splitTime) {
    throw createError({ statusCode: 500, message: "Không xác định được mốc chia dữ liệu." });
  }

  const evaluated = buildGrid().map((variant) => {
    const result = runBacktest(symbol, h1, h4, {
      ...defaultBacktestConfig,
      maxHoldBars: variant.maxHoldBars,
      spreadPrice: spread,
      strategy: variant.strategy,
    });
    const inSample = tradeStats(
      result.tradeList.filter((trade) => trade.entryTime < splitTime),
    );
    const outOfSample = tradeStats(
      result.tradeList.filter((trade) => trade.entryTime >= splitTime),
    );
    return { label: variant.label, full: stripList(result), inSample, outOfSample };
  });

  // Chọn cấu hình tốt nhất CHỈ theo in-sample (đủ số lệnh để có ý nghĩa).
  const eligible = evaluated.filter((row) => row.inSample.trades >= minIsTrades);
  const ranked = [...eligible].sort(
    (a, b) => b.inSample.expectancyR - a.inSample.expectancyR,
  );
  const chosen = ranked[0] ?? null;

  return {
    symbol,
    bars: h1.length,
    spreadPrice: spread,
    splitTime,
    minIsTrades,
    note:
      "Cấu hình được chọn CHỈ dựa trên in-sample. Hãy nhìn outOfSample của nó: dương = edge thật, âm = curve-fit.",
    chosen,
    verdict: chosen
      ? chosen.outOfSample.expectancyR > 0 && chosen.outOfSample.trades >= 5
        ? "OOS DƯƠNG — edge có vẻ thật"
        : chosen.outOfSample.trades < 5
          ? "OOS quá ít lệnh — chưa kết luận"
          : "OOS ÂM — nhiều khả năng curve-fit"
      : "Không cấu hình nào đủ số lệnh in-sample",
    topByInSample: ranked.slice(0, 6),
  };
});

function stripList(result: ReturnType<typeof runBacktest>) {
  const { tradeList: _tradeList, ...rest } = result;
  return rest;
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
