import { createError, getQuery } from "h3";
import { fetchBacktestCandles } from "../../backtest/backtestData";
import { buildGrid, tradeStats } from "../../backtest/grid";
import { defaultXauIctBacktestConfig, runXauIctBacktest } from "../../backtest/xauPullbackBacktester";

/**
 * GET /api/backtest/walkforward?symbol=XAUUSDm&bars=6000&spread=0.3&splitPct=0.6
 *
 * Walk-forward TRUNG THỰC chống curve-fit cho ICT rulebook (M5 entry, M15 setup, H4 bias):
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
  const m5Bars = clampInt(query.bars, 20000, 2000, 90000);
  const m15Bars = Math.min(20000, Math.ceil(m5Bars / 3) + 600);
  const h4Bars = Math.min(6000, Math.ceil(m5Bars / 48) + 300);
  const spread = clampNumber(query.spread, /XAU/i.test(symbol) ? 0.3 : 0.0002, 0, 100);
  const splitPct = clampNumber(query.splitPct, 0.6, 0.4, 0.8);
  const minIsTrades = clampInt(query.minIsTrades, 15, 5, 100);

  let m5, m15, h4;
  try {
    [m5, m15, h4] = await Promise.all([
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "M5", m5Bars),
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "M15", m15Bars),
      fetchBacktestCandles(config.mt5BridgeUrl, symbol, "H4", h4Bars),
    ]);
  } catch (error) {
    throw createError({
      statusCode: 500,
      message: error instanceof Error ? error.message : "Không lấy được nến.",
    });
  }

  const splitTime = m5[Math.floor(m5.length * splitPct)]?.time ?? "";
  if (!splitTime) {
    throw createError({ statusCode: 500, message: "Không xác định được mốc chia dữ liệu." });
  }

  const evaluated = buildGrid().map((variant) => {
    const result = runXauIctBacktest(m5, m15, h4, {
      ...defaultXauIctBacktestConfig,
      maxHoldBars: variant.maxHoldBars,
      spreadPrice: spread,
      ictConfig: variant.ictConfig,
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
    bars: m5.length,
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

function stripList(result: ReturnType<typeof runXauIctBacktest>) {
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
