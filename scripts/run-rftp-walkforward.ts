import { fetchBacktestCandlesPaged } from "../server/backtest/backtestData";
import {
  defaultXauIctBacktestConfig,
  runXauIctBacktest,
  type XauBacktestTrade,
} from "../server/backtest/xauPullbackBacktester";
import { defaultXauRftpConfig } from "../server/strategy/xauRftpStrategy";

const bridgeUrl = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const symbol = process.env.MT5_SYMBOL || "XAUUSDm";
const periodStart = new Date(Date.now() - 90 * 24 * 60 * 60_000);
const testStart = new Date(Date.now() - 30 * 24 * 60 * 60_000);
const [allM5, m15, h1] = await Promise.all([
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M5", 32_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M15", 12_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H1", 4_000),
]);
const m5 = allM5.filter((item) => new Date(item.time) >= periodStart);

const sessions = [
  { name: "ASIA_2200_0700", start: 22 * 60, end: 7 * 60 },
  { name: "LONDON_0700_1200", start: 7 * 60, end: 12 * 60 },
  { name: "US_1200_2100", start: 12 * 60, end: 21 * 60 },
  { name: "LONDON_US_0700_2100", start: 7 * 60, end: 21 * 60 },
  { name: "ALL_DAY", start: 0, end: 24 * 60 },
] as const;
const directions = [
  { name: "BUY", allowBuy: true, allowSell: false },
  { name: "SELL", allowBuy: false, allowSell: true },
  { name: "BOTH", allowBuy: true, allowSell: true },
] as const;
const targetRs = [1.5, 1.8, 2.0, 2.2] as const;

type Metrics = ReturnType<typeof metrics>;
interface CandidateResult {
  session: string;
  direction: string;
  targetR: number;
  train: Metrics;
  test: Metrics;
  full: Metrics;
  trainScore: number;
}

const results: CandidateResult[] = [];
for (const session of sessions) {
  for (const direction of directions) {
    for (const targetR of targetRs) {
      const result = runXauIctBacktest(m5, m15, h1, [], {
        ...defaultXauIctBacktestConfig,
        strategyMode: "RFTP",
        accountStartUsd: 100,
        lot: 0.01,
        spreadPrice: 0.4,
        breakEvenAtR: 99,
        maxHoldBars: 96,
        cooldownBars: 0,
        maxLossPercentPerTrade: 1_000,
        rftpConfig: {
          ...defaultXauRftpConfig,
          allowBuy: direction.allowBuy,
          allowSell: direction.allowSell,
          targetR,
          sessionStartUtcMinutes: session.start,
          sessionEndUtcMinutes: session.end,
        },
      });
      const trainTrades = result.tradeList.filter((trade) => new Date(trade.entryTime) < testStart);
      const testTrades = result.tradeList.filter((trade) => new Date(trade.entryTime) >= testStart);
      const train = metrics(trainTrades);
      results.push({
        session: session.name,
        direction: direction.name,
        targetR,
        train,
        test: metrics(testTrades),
        full: metrics(result.tradeList),
        // Penalise tiny samples while ranking on training data only.
        trainScore: train.trades >= 15 ? train.expectancyR - 0.5 * train.standardErrorR : -999,
      });
    }
  }
}

const ranked = results
  .filter((item) => item.train.trades >= 15)
  .sort((left, right) => right.trainScore - left.trainScore);
const deployable = ranked.filter((item) =>
  item.test.trades >= 8 &&
  item.train.expectancyR > 0 && item.train.profitFactor > 1 &&
  item.test.expectancyR > 0 && item.test.profitFactor > 1 &&
  item.train.netUsd > 0 && item.train.usdProfitFactor > 1 &&
  item.test.netUsd > 0 && item.test.usdProfitFactor > 1,
);

console.log(JSON.stringify({
  methodology: {
    selection: "Ranked only on first 60 calendar days; last 30 days held out for acceptance",
    minimums: "train >= 15 trades; test >= 8 trades; positive expectancy and PF > 1 in both",
    costs: "0.40 XAU price units round-turn; fixed 0.01 lot; no historical news blackout",
  },
  period: {
    first: m5[0]?.time,
    testStart: testStart.toISOString(),
    last: m5.at(-1)?.time,
    bars: m5.length,
  },
  testedCandidates: results.length,
  selectedByTrain: ranked.slice(0, 5),
  deployable: deployable.slice(0, 10),
}, null, 2));

function metrics(trades: XauBacktestTrade[]) {
  const values = trades.map((trade) => trade.rMultiple);
  const totalR = values.reduce((sum, value) => sum + value, 0);
  const grossWin = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const expectancyR = values.length ? totalR / values.length : 0;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - expectancyR) ** 2, 0) / (values.length - 1)
    : 0;
  const wins = values.filter((value) => value > 0).length;
  const usdValues = trades.map((trade) => trade.usd);
  const usdGrossWin = usdValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const usdGrossLoss = Math.abs(usdValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    trades: values.length,
    wins,
    losses: values.filter((value) => value < 0).length,
    winRate: values.length ? round((wins / values.length) * 100) : 0,
    expectancyR: round(expectancyR),
    standardErrorR: round(values.length ? Math.sqrt(variance / values.length) : 0),
    profitFactor: grossLoss ? round(grossWin / grossLoss) : grossWin > 0 ? 999 : 0,
    totalR: round(totalR),
    netUsd: round(usdValues.reduce((sum, value) => sum + value, 0)),
    usdProfitFactor: usdGrossLoss ? round(usdGrossWin / usdGrossLoss) : usdGrossWin > 0 ? 999 : 0,
    avgUsd: round(usdValues.length ? usdValues.reduce((sum, value) => sum + value, 0) / usdValues.length : 0),
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
