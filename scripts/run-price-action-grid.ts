import { fetchBacktestCandlesPaged } from "../server/backtest/backtestData";
import {
  defaultXauIctBacktestConfig,
  runXauIctBacktest,
} from "../server/backtest/xauPullbackBacktester";
import type { Candle } from "../types/trading";
import type { XauClassicPriceActionConfig } from "../server/strategy/ruleStrategy";

const bridgeUrl = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const symbol = process.env.MT5_SYMBOL || "XAUUSDm";
const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000);

function marketDayCount(candles: Candle[]) {
  return new Set(candles.map((candle) => candle.time.slice(0, 10))).size;
}

function run(candles: Candle[], m15: Candle[], h1: Candle[], h4: Candle[], classicConfig: XauClassicPriceActionConfig) {
  return runXauIctBacktest(candles, m15, h1, h4, {
    ...defaultXauIctBacktestConfig,
    accountStartUsd: 100,
    lot: 0.02,
    maxLossPercentPerTrade: 1_000,
    maxHoldBars: 96,
    cooldownBars: 0,
    strategyMode: "CLASSIC",
    classicConfig,
  });
}

const [allM5, allM15, h1, h4] = await Promise.all([
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M5", 32_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M15", 12_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H1", 4_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H4", 1_200),
]);
const m5 = allM5.filter((candle) => new Date(candle.time) >= cutoff);
const splitAt = new Date(cutoff.getTime() + 60 * 24 * 60 * 60_000);
const trainM5 = m5.filter((candle) => new Date(candle.time) < splitAt);
const testM5 = m5.filter((candle) => new Date(candle.time) >= splitAt);
const first = m5[0]?.time ?? "";
const m15 = allM15.filter((candle) => candle.time >= first);

const candidates: Array<{ config: XauClassicPriceActionConfig; train: ReturnType<typeof run>; test: ReturnType<typeof run> }> = [];
for (const sweepLookbackM15 of [3, 4, 6, 8]) {
  for (const m15CloseEdgeMax of [0.25, 0.35, 0.45]) {
    for (const m5MinBodyRatio of [0.2, 0.35]) {
      for (const m5CloseEdgeMax of [0.25, 0.4]) {
        for (const targetR of [0.8, 1.0, 1.2, 1.3]) {
          const config = { sweepLookbackM15, m15CloseEdgeMax, m5MinBodyRatio, m5CloseEdgeMax, targetR, stopAtrBuffer: 0.15 };
          const train = run(trainM5, m15, h1, h4, config);
          const test = run(testM5, m15, h1, h4, config);
          candidates.push({ config, train, test });
        }
      }
    }
  }
}

const trainDays = marketDayCount(trainM5);
const testDays = marketDayCount(testM5);
const ranking = candidates
  .map(({ config, train, test }) => ({
    config,
    train: { trades: train.trades, winRate: train.winRate, expectancyR: train.expectancyR, netUsd: train.netUsd, perDay: +(train.trades / trainDays).toFixed(2) },
    outOfSample: { trades: test.trades, winRate: test.winRate, expectancyR: test.expectancyR, profitFactor: test.profitFactor, netUsd: test.netUsd, perDay: +(test.trades / testDays).toFixed(2) },
  }))
  .filter((item) => item.train.trades >= 25 && item.outOfSample.trades >= 10)
  .sort((a, b) => b.outOfSample.expectancyR - a.outOfSample.expectancyR || b.outOfSample.winRate - a.outOfSample.winRate)
  .slice(0, 20);

console.log(JSON.stringify({
  period: { start: m5[0]?.time, end: m5.at(-1)?.time, trainDays, testDays, totalCandidates: candidates.length },
  note: "Parameters were selected by out-of-sample expectancy, not win rate alone. Fixed 0.02 lot on $100 disables risk cap for research only.",
  top20: ranking,
}, null, 2));
