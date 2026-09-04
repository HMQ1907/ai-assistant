import { fetchBacktestCandlesPaged } from "../server/backtest/backtestData";
import {
  defaultXauMicroScalpBacktestConfig,
  runXauMicroScalpBacktest,
} from "../server/backtest/xauMicroScalpBacktester";

const bridgeUrl = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const symbol = process.env.MT5_SYMBOL || "XAUUSDm";
const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000);
const [allM1, m5, m15, h1, h4] = await Promise.all([
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M1", 140_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M5", 32_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M15", 12_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H1", 4_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H4", 1_200),
]);
const m1 = allM1.filter((candle) => new Date(candle.time) >= cutoff);
const result = runXauMicroScalpBacktest(m1, m5, m15, h1, h4, {
  ...defaultXauMicroScalpBacktestConfig,
  accountStartUsd: 100,
  lot: 0.01,
  maxLossPercentPerTrade: 15,
  scalpConfig: {
    ...defaultXauMicroScalpBacktestConfig.scalpConfig,
    rrTarget: 1.5,
    strongRr: 1.5,
    minRr: 1.5,
    tpStructureMinRr: 1.5,
  },
});
const marketDays = new Set(m1.map((candle) => candle.time.slice(0, 10))).size;
const risks = result.tradeList.map((trade) => trade.riskUsd);
console.log(JSON.stringify({
  assumptions: { accountStartUsd: 100, lot: 0.01, maxLossUsd: 15, minRr: 1.5, tradeWindow: defaultXauMicroScalpBacktestConfig.tradeWindows },
  data: { m1Bars: m1.length, first: m1[0]?.time, last: m1.at(-1)?.time, marketDays },
  result: { ...result, tradeList: undefined },
  averageTradesPerDay: +(result.trades / marketDays).toFixed(3),
  riskUsd: { average: +(risks.reduce((sum, risk) => sum + risk, 0) / Math.max(1, risks.length)).toFixed(2), max: +Math.max(0, ...risks).toFixed(2) },
}, null, 2));
