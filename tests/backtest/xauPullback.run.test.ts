import { describe, expect, it } from "vitest";
import { fetchBacktestCandlesPaged } from "../../server/backtest/backtestData";
import {
  defaultXauIctBacktestConfig,
  runXauIctBacktest,
  type XauBacktestResult,
  type XauBacktestTrade,
  type XauIctBacktestConfig,
} from "../../server/backtest/xauPullbackBacktester";
import type { Candle } from "../../types/trading";

const BRIDGE = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSDm";
/** ~2 tháng lịch: ~60 ngày * ~288 nến M5/ngày giao dịch ≈ 14k–17k; lấy dư. */
const M5_COUNT = Number(process.env.BACKTEST_M5_BARS || 17000);
const M15_COUNT = Number(process.env.BACKTEST_M15_BARS || 6000);
const H1_COUNT = Number(process.env.BACKTEST_H1_BARS || 2000);
const H4_COUNT = Number(process.env.BACKTEST_H4_BARS || 600);

/** Config khớp live auto-bot hiện tại (.env), mode ICT rulebook (thay xau_trend_pullback cũ). */
const liveConfig: XauIctBacktestConfig = {
  ...defaultXauIctBacktestConfig,
  spreadPrice: Number(process.env.BACKTEST_SPREAD_PRICE || 0.3),
  maxHoldBars: Number(process.env.BACKTEST_MAX_HOLD_BARS || 96), // 8h * 12 M5
  cooldownBars: Number(process.env.BACKTEST_COOLDOWN_BARS || 9), // 45'
  breakEvenAtR: 1,
  lot: Number(process.env.BACKTEST_LOT || 0.01),
  accountStartUsd: Number(process.env.BACKTEST_ACCOUNT_SIZE_USD || 200),
  maxLossPercentPerTrade: Number(process.env.BACKTEST_MAX_LOSS_PERCENT || 10),
};

function line(label: string, r: XauBacktestResult): string {
  return [
    label.padEnd(24),
    `sig=${String(r.signalsRaw).padStart(3)}`,
    `capSkip=${String(r.skippedByRiskCap).padStart(3)}`,
    `n=${String(r.trades).padStart(3)}`,
    `win%=${String(r.winRate).padStart(5)}`,
    `expR=${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(3)}`.padEnd(12),
    `PF=${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf"}`.padEnd(9),
    `totR=${r.totalR.toFixed(1)}`.padEnd(11),
    `ddR=${r.maxDrawdownR.toFixed(1)}`.padEnd(10),
    `net$=${r.netUsd.toFixed(2)}`.padEnd(12),
    `ddUsd=${r.maxDrawdownUsd.toFixed(2)}`,
  ].join("  ");
}

function splitByTime(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[],
  config: XauIctBacktestConfig,
  splitPct: number,
) {
  const splitIdx = Math.floor(m5.length * splitPct);
  const splitTime = m5[splitIdx]?.time ?? "";
  const full = runXauIctBacktest(m5, m15, h1, h4, config);
  const isTrades = full.tradeList.filter((t: XauBacktestTrade) => t.entryTime < splitTime);
  const oosTrades = full.tradeList.filter((t: XauBacktestTrade) => t.entryTime >= splitTime);
  return { full, splitTime, isTrades, oosTrades };
}

function statOf(trades: XauBacktestTrade[]) {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const net = trades.reduce((s, t) => s + t.usd, 0);
  return {
    n: trades.length,
    winRate: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0,
    expR: trades.length ? Number((totalR / trades.length).toFixed(3)) : 0,
    totalR: Number(totalR.toFixed(1)),
    net: Number(net.toFixed(2)),
  };
}

function monthlyBuckets(trades: XauBacktestTrade[]) {
  const map = new Map<string, XauBacktestTrade[]>();
  for (const trade of trades) {
    const month = trade.entryTime.slice(0, 7);
    const list = map.get(month) ?? [];
    list.push(trade);
    map.set(month, list);
  }
  return [...map.entries()].map(([month, list]) => ({ month, ...statOf(list) }));
}

describe("XAUUSD ICT rulebook (mode auto-bot thật) - backtest dữ liệu MT5 thật", () => {
  it(
    "đo expectancy ~2 tháng + walk-forward (config live)",
    async () => {
      let m5: Candle[];
      let m15: Candle[];
      let h4: Candle[];
      let h1: Candle[];
      try {
        [m5, m15, h4, h1] = await Promise.all([
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "M5", M5_COUNT),
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "M15", M15_COUNT),
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "H4", H4_COUNT),
          fetchBacktestCandlesPaged(BRIDGE, SYMBOL, "H1", H1_COUNT),
        ]);
      } catch (error) {
        console.warn("[backtest] Không lấy được nến từ bridge -> bỏ qua:", (error as Error).message);
        return;
      }

      console.log(`\n=== DỮ LIỆU (${SYMBOL}) — luồng chính ICT rulebook ===`);
      console.log(`M5 : ${m5.length} nến  ${m5[0]?.time} -> ${m5.at(-1)?.time}`);
      console.log(`M15: ${m15.length} nến  H4: ${h4.length} nến  H1(phụ): ${h1.length} nến`);
      const days =
        (new Date(m5.at(-1)!.time).getTime() - new Date(m5[0]!.time).getTime()) / 86_400_000;
      console.log(`Khoảng M5 ~ ${days.toFixed(1)} ngày lịch (~${(days / 30).toFixed(2)} tháng)`);
      console.log(
        `Live config: lot=${liveConfig.lot}, vốn=$${liveConfig.accountStartUsd}, ` +
          `maxLoss=${liveConfig.maxLossPercentPerTrade}%, hold=${liveConfig.maxHoldBars} M5 bars, ` +
          `cooldown=${liveConfig.cooldownBars} bars, spread=$${liveConfig.spreadPrice}, ` +
          `retestExpiryM5Bars=${liveConfig.ictConfig.retestExpiryM5Bars}`,
      );

      console.log(`\n=== BASELINE theo spread (config live) ===`);
      for (const spread of [0.15, 0.3, 0.5]) {
        const r = runXauIctBacktest(m5, m15, h1, h4, { ...liveConfig, spreadPrice: spread });
        console.log(line(`spread=${spread}`, r));
      }

      console.log(`\n=== ẢNH HƯỞNG RETEST WINDOW (spread=0.3) ===`);
      for (const retestExpiryM5Bars of [5, 8, 12, 20]) {
        const r = runXauIctBacktest(
          m5,
          m15,
          h1,
          h4,
          { ...liveConfig, spreadPrice: 0.3, ictConfig: { ...liveConfig.ictConfig, retestExpiryM5Bars } },
        );
        console.log(line(`retest<=${retestExpiryM5Bars}`, r));
      }

      console.log(`\n=== WALK-FORWARD (spread=0.3, chia 60/40 theo thời gian) ===`);
      const { splitTime, isTrades, oosTrades } = splitByTime(
        m5,
        m15,
        h1,
        h4,
        { ...liveConfig, spreadPrice: 0.3 },
        0.6,
      );
      console.log(`Mốc chia: ${splitTime}`);
      console.log(`In-sample : ${JSON.stringify(statOf(isTrades))}`);
      console.log(`Out-sample: ${JSON.stringify(statOf(oosTrades))}`);

      const base = runXauIctBacktest(m5, m15, h1, h4, { ...liveConfig, spreadPrice: 0.3 });
      const maxRisk = base.tradeList.length
        ? Math.max(...base.tradeList.map((t: XauBacktestTrade) => t.riskUsd))
        : 0;
      const riskCapUsd = (liveConfig.accountStartUsd * liveConfig.maxLossPercentPerTrade) / 100;
      console.log(
        `Risk/lệnh: max=$${maxRisk.toFixed(2)}  (cap ${liveConfig.maxLossPercentPerTrade}% vốn $${liveConfig.accountStartUsd} = $${riskCapUsd} -> ${maxRisk <= riskCapUsd ? "không bind" : "có lệnh bị skip"})`,
      );

      console.log(`\n=== THEO THÁNG ===`);
      for (const row of monthlyBuckets(base.tradeList)) {
        console.log(
          `${row.month}  n=${row.n}  win%=${row.winRate}  expR=${row.expR}  totR=${row.totalR}  net$=${row.net}`,
        );
      }

      console.log(`\n=== QUÉT CAP LỖ/LỆNH tại VỐN $${liveConfig.accountStartUsd} ===`);
      for (const capPct of [5, 8, 10, 12, 15, 18, 20]) {
        const r = runXauIctBacktest(
          m5,
          m15,
          h1,
          h4,
          { ...liveConfig, spreadPrice: 0.3, maxLossPercentPerTrade: capPct },
        );
        const avgRiskUsd = r.tradeList.length
          ? r.tradeList.reduce((s: number, t: XauBacktestTrade) => s + t.riskUsd, 0) / r.tradeList.length
          : 0;
        const retPct =
          ((r.endEquityUsd - liveConfig.accountStartUsd) / liveConfig.accountStartUsd) * 100;
        console.log(
          `cap=${String(capPct).padStart(2)}% ($${(liveConfig.accountStartUsd * capPct / 100).toFixed(0)})  ` +
            `capSkip=${String(r.skippedByRiskCap).padStart(2)}  n=${String(r.trades).padStart(2)}  ` +
            `avgRisk=$${avgRiskUsd.toFixed(1)}(${((avgRiskUsd / liveConfig.accountStartUsd) * 100).toFixed(1)}%)  ` +
            `net$=${r.netUsd.toFixed(2)}  return=${retPct.toFixed(1)}%  ddUsd=${r.maxDrawdownUsd.toFixed(2)}(${((r.maxDrawdownUsd / liveConfig.accountStartUsd) * 100).toFixed(1)}%)`,
        );
      }

      console.log(`\n=== KẾT QUẢ CHÍNH (config live, spread $0.30) ===`);
      console.log(
        JSON.stringify(
          {
            periodDays: Number(days.toFixed(1)),
            periodMonths: Number((days / 30).toFixed(2)),
            from: m5[0]?.time,
            to: m5.at(-1)?.time,
            signalsRaw: base.signalsRaw,
            skippedByRiskCap: base.skippedByRiskCap,
            trades: base.trades,
            wins: base.wins,
            losses: base.losses,
            breakeven: base.breakeven,
            timestop: base.timestop,
            winRate: base.winRate,
            expectancyR: base.expectancyR,
            profitFactor: base.profitFactor,
            totalR: base.totalR,
            maxDrawdownR: base.maxDrawdownR,
            startEquity: liveConfig.accountStartUsd,
            endEquity: base.endEquityUsd,
            netUsd: base.netUsd,
            netPct: Number(
              (
                ((base.endEquityUsd - liveConfig.accountStartUsd) / liveConfig.accountStartUsd) *
                100
              ).toFixed(2),
            ),
            maxDrawdownUsd: base.maxDrawdownUsd,
            recentTrades: base.tradeList.slice(-8),
          },
          null,
          2,
        ),
      );

      console.log(`\n=== ĐÁNH GIÁ ===`);
      const verdict =
        base.trades < 20
          ? `MẪU QUÁ NHỎ (${base.trades} lệnh, ~${days.toFixed(0)} ngày) — chưa đủ để kết luận.`
          : base.expectancyR > 0.05
            ? `Expectancy DƯƠNG (${base.expectancyR}R/lệnh) trên mẫu ~${(days / 30).toFixed(1)} tháng.`
            : base.expectancyR > 0
              ? `Expectancy dương mỏng (${base.expectancyR}R) — chưa đủ bù chi phí/độ trượt thực tế.`
              : `Expectancy ÂM (${base.expectancyR}R/lệnh) — chưa có edge trên mẫu này.`;
      console.log(verdict);

      expect(base.trades).toBeGreaterThanOrEqual(0);
    },
    300_000,
  );
});
