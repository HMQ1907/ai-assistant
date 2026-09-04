import { fetchBacktestCandlesPaged } from "../server/backtest/backtestData";
import {
  defaultXauIctBacktestConfig,
  runXauIctBacktest,
} from "../server/backtest/xauPullbackBacktester";
import { defaultXauRftpConfig } from "../server/strategy/xauRftpStrategy";

const bridgeUrl = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const symbol = process.env.MT5_SYMBOL || "XAUUSDm";
const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000);
const [allM5, m15, h1] = await Promise.all([
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M5", 32_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "M15", 12_000),
  fetchBacktestCandlesPaged(bridgeUrl, symbol, "H1", 4_000),
]);
const m5 = allM5.filter((item) => new Date(item.time) >= cutoff);
const marketDays = new Set(m5.map((item) => item.time.slice(0, 10))).size;
const common = {
  ...defaultXauIctBacktestConfig,
  strategyMode: "RFTP" as const,
  accountStartUsd: 100,
  lot: 0.01,
  spreadPrice: 0.4, // $0.30 spread + $0.10 slippage allowance
  breakEvenAtR: 99, // Model A: fixed 1.8R, no premature break-even
  maxHoldBars: 96,
  cooldownBars: 0,
  rftpConfig: defaultXauRftpConfig,
};
const research = runXauIctBacktest(m5, m15, h1, [], {
  ...common,
  maxLossPercentPerTrade: 1_000,
});
const safeRisk = runXauIctBacktest(m5, m15, h1, [], {
  ...common,
  maxLossPercentPerTrade: 0.5,
});
const buyOnly = runXauIctBacktest(m5, m15, h1, [], {
  ...common,
  maxLossPercentPerTrade: 1_000,
  rftpConfig: { ...defaultXauRftpConfig, allowSell: false },
});
const buyLondonOnly = runXauIctBacktest(m5, m15, h1, [], {
  ...common,
  maxLossPercentPerTrade: 1_000,
  rftpConfig: {
    ...defaultXauRftpConfig,
    allowSell: false,
    sessionStartUtcMinutes: 7 * 60,
    sessionEndUtcMinutes: 12 * 60,
  },
});
const buyAllDay = runXauIctBacktest(m5, m15, h1, [], {
  ...common,
  maxLossPercentPerTrade: 1_000,
  rftpConfig: {
    ...defaultXauRftpConfig,
    allowSell: false,
    sessionStartUtcMinutes: 0,
    sessionEndUtcMinutes: 24 * 60,
  },
});
const compact = (result: typeof research) => ({
  trades: result.trades,
  signalsRaw: result.signalsRaw,
  skippedByRiskCap: result.skippedByRiskCap,
  wins: result.wins,
  losses: result.losses,
  winRate: result.winRate,
  expectancyR: result.expectancyR,
  profitFactor: result.profitFactor,
  totalR: result.totalR,
  maxDrawdownR: result.maxDrawdownR,
  netUsd: result.netUsd,
  endEquityUsd: result.endEquityUsd,
  maxDrawdownUsd: result.maxDrawdownUsd,
  tradesPerDay: +(result.trades / marketDays).toFixed(3),
});

function segment(trades: typeof research.tradeList) {
  const totalR = trades.reduce((sum, trade) => sum + trade.rMultiple, 0);
  const grossWin = trades.filter((trade) => trade.rMultiple > 0).reduce((sum, trade) => sum + trade.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.rMultiple < 0).reduce((sum, trade) => sum + trade.rMultiple, 0));
  const wins = trades.filter((trade) => trade.outcome === "WIN").length;
  const losses = trades.filter((trade) => trade.outcome === "LOSS").length;
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: wins + losses ? +((wins / (wins + losses)) * 100).toFixed(2) : 0,
    expectancyR: trades.length ? +(totalR / trades.length).toFixed(4) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(3) : 0,
    totalR: +totalR.toFixed(3),
    netUsd: +trades.reduce((sum, trade) => sum + trade.usd, 0).toFixed(2),
  };
}

const byDirection = {
  BUY: segment(research.tradeList.filter((trade) => trade.direction === "BUY")),
  SELL: segment(research.tradeList.filter((trade) => trade.direction === "SELL")),
};
const byUtcSession = {
  LONDON: segment(research.tradeList.filter((trade) => {
    const hour = new Date(trade.entryTime).getUTCHours();
    return hour >= 7 && hour < 12;
  })),
  OVERLAP_NY: segment(research.tradeList.filter((trade) => {
    const hour = new Date(trade.entryTime).getUTCHours();
    return hour >= 12 && hour < 17;
  })),
};
const byMonth = Object.fromEntries(
  [...new Set(research.tradeList.map((trade) => trade.entryTime.slice(0, 7)))].map((month) => [
    month,
    segment(research.tradeList.filter((trade) => trade.entryTime.startsWith(month))),
  ]),
);
console.log(JSON.stringify({
  period: { first: m5[0]?.time, last: m5.at(-1)?.time, marketDays, m5Bars: m5.length, m15Bars: m15.length },
  assumptions: { account: 100, lot: 0.01, targetR: defaultXauRftpConfig.targetR, spreadAndSlippagePrice: 0.4, newsHistory: "unavailable; not simulated" },
  researchNoRiskCap: compact(research),
  byDirection,
  byUtcSession,
  byMonth,
  productionRiskCap0_5Percent: compact(safeRisk),
  rerunVariants: {
    buyOnlyFullSession: compact(buyOnly),
    buyOnlyLondon0700To1200Utc: compact(buyLondonOnly),
    buyOnlyAllDay: compact(buyAllDay),
  },
}, null, 2));
