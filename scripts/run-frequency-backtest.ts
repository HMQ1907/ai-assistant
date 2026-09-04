import { fetchBacktestCandlesPaged } from "../server/backtest/backtestData";
import {
  defaultXauIctBacktestConfig,
  runXauIctBacktest,
} from "../server/backtest/xauPullbackBacktester";
import { defaultXauClassicPriceActionConfig } from "../server/strategy/ruleStrategy";

const bridgeUrl = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const symbol = process.env.MT5_SYMBOL || "XAUUSDm";
const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000);
const maxStopLossAtr = Number(process.env.BACKTEST_MAX_STOP_ATR || "2");
const retestExpiryM5Bars = Number(process.env.BACKTEST_RETEST_BARS || "8");
const m5StrongCloseBodyRatio = Number(process.env.BACKTEST_M5_BODY_RATIO || "0.6");
const m5TriggerClosePositionMax = Number(process.env.BACKTEST_M5_CLOSE_POSITION || "0.3");
const minVolatilityRatio = Number(process.env.BACKTEST_MIN_VOLATILITY_RATIO || "0.7");
const maxVolatilityRatio = Number(process.env.BACKTEST_MAX_VOLATILITY_RATIO || "2");
const diagnosticLoose = process.env.BACKTEST_DIAGNOSTIC_LOOSE === "true";
const maxHoldBars = Number(process.env.BACKTEST_MAX_HOLD_BARS || "96");
const cooldownBars = Number(process.env.BACKTEST_COOLDOWN_BARS || "0");
const strategyMode = process.env.BACKTEST_STRATEGY === "classic" ? "CLASSIC" : "ICT";
const maxLossPercentPerTrade = Number(process.env.BACKTEST_MAX_LOSS_PERCENT || "1000");
const classicTargetR = Number(process.env.BACKTEST_CLASSIC_TARGET_R || "1.3");
const classicConfig = strategyMode === "CLASSIC"
  ? { ...defaultXauClassicPriceActionConfig, targetR: classicTargetR }
  : null;

const [allM5, h1, h4] = await Promise.all([
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M5", 32_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H1", 4_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H4", 1_200),
]);
const m5 = allM5.filter((candle) => new Date(candle.time) >= cutoff);
const firstM5 = m5[0]?.time;
if (!firstM5 || m5.length < 5_000 || h1.length < 300 || h4.length < 80) {
  throw new Error(`Insufficient MT5 history: M5=${m5.length}, H1=${h1.length}, H4=${h4.length}`);
}
const m15 = (await fetchBacktestCandlesPaged(bridgeUrl, symbol, "M15", 12_000))
  .filter((candle) => candle.time >= firstM5);

const result = runXauIctBacktest(m5, m15, h1, h4, {
  ...defaultXauIctBacktestConfig,
  accountStartUsd: 100,
  lot: Number(process.env.BACKTEST_LOT || "0.02"),
  maxHoldBars,
  cooldownBars,
  strategyMode,
  // Người dùng yêu cầu lot cố định: không bỏ signal chỉ vì vượt risk cap.
  maxLossPercentPerTrade,
  ...(classicConfig ? { classicConfig } : {}),
  ictConfig: {
    ...defaultXauIctBacktestConfig.ictConfig,
    maxStopLossAtr,
    retestExpiryM5Bars,
    m5StrongCloseBodyRatio,
    m5TriggerClosePositionMax,
    minVolatilityRatio,
    maxVolatilityRatio,
    ...(diagnosticLoose
      ? {
          swingConfirmBars: 1,
          displacementBodyRangeRatioA: 0.2,
          displacementBodyRangeRatioB: 0.2,
          displacementClosePositionMaxA: 0.5,
          displacementClosePositionMaxB: 0.5,
          fixedPriceBuffer: 0.01,
          minSweepDepthAtr: 0,
          maxSweepDepthAtr: 10,
          maxEntryDistanceAtr: 10,
          minStopLossAtr: 0,
          minTargetR: 0.1,
          m5EngulfingBodyMult: 0,
          allowContinuationAgainstH4: true,
        }
      : {}),
  },
});

const marketDays = [...new Set(m5.map((candle) => candle.time.slice(0, 10)))];
const tradesByDay = new Map<string, number>();
for (const trade of result.tradeList) {
  const day = trade.entryTime.slice(0, 10);
  tradesByDay.set(day, (tradesByDay.get(day) ?? 0) + 1);
}
const counts = marketDays.map((day) => tradesByDay.get(day) ?? 0);
const distribution = {
  zero: counts.filter((count) => count === 0).length,
  one: counts.filter((count) => count === 1).length,
  two: counts.filter((count) => count === 2).length,
  three: counts.filter((count) => count === 3).length,
  fourOrMore: counts.filter((count) => count >= 4).length,
  max: Math.max(0, ...counts),
  average: Number((result.trades / marketDays.length).toFixed(3)),
};
const risks = result.tradeList.map((trade) => trade.riskUsd);

console.log(JSON.stringify({
  requestedStart: cutoff.toISOString(),
  data: {
    m5First: m5[0]?.time,
    m5Last: m5.at(-1)?.time,
    m5Bars: m5.length,
    m15Bars: m15.length,
    h1Bars: h1.length,
    h4Bars: h4.length,
  },
  assumptions: {
    accountStartUsd: 100,
    fixedLot: Number(process.env.BACKTEST_LOT || "0.02"),
    spreadPrice: defaultXauIctBacktestConfig.spreadPrice,
    newsFilter: "not simulated (historical calendar unavailable)",
    riskCap: `max ${maxLossPercentPerTrade}% of starting balance per trade`,
    maxStopLossAtr,
    maxHoldBars,
    cooldownBars,
    retestExpiryM5Bars,
    m5StrongCloseBodyRatio,
    m5TriggerClosePositionMax,
    volatilityRange: [minVolatilityRatio, maxVolatilityRatio],
    diagnosticLoose,
    strategyMode,
    classicTargetR: strategyMode === "CLASSIC" ? classicTargetR : undefined,
  },
  result: { ...result, tradeList: undefined },
  dailyFrequency: distribution,
  riskUsd: {
    average: Number((risks.reduce((total, value) => total + value, 0) / Math.max(1, risks.length)).toFixed(2)),
    max: Number(Math.max(0, ...risks).toFixed(2)),
  },
}, null, 2));
