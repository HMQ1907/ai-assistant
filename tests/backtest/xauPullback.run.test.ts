import { describe, expect, it } from "vitest";
import { fetchBacktestCandles } from "../../server/backtest/backtestData";
import {
  defaultXauPullbackConfig,
  runXauPullbackBacktest,
  type XauBacktestResult,
  type XauBacktestTrade,
  type XauPullbackBacktestConfig,
} from "../../server/backtest/xauPullbackBacktester";
import type { Candle } from "../../types/trading";

const BRIDGE = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765";
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSDm";
const COUNT = 6000;

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
  config: XauPullbackBacktestConfig,
  splitPct: number,
) {
  const splitIdx = Math.floor(m5.length * splitPct);
  const splitTime = m5[splitIdx]?.time ?? "";
  const full = runXauPullbackBacktest(m5, m15, h1, config);
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

describe("XAUUSD trend-pullback (mode auto-bot thật) - backtest dữ liệu MT5 thật", () => {
  it("đo expectancy + walk-forward", async () => {
    let m5: Candle[];
    let m15: Candle[];
    let h1: Candle[];
    try {
      [m5, m15, h1] = await Promise.all([
        fetchBacktestCandles(BRIDGE, SYMBOL, "M5", COUNT),
        fetchBacktestCandles(BRIDGE, SYMBOL, "M15", COUNT),
        fetchBacktestCandles(BRIDGE, SYMBOL, "H1", COUNT),
      ]);
    } catch (error) {
      console.warn("[backtest] Không lấy được nến từ bridge -> bỏ qua:", (error as Error).message);
      return;
    }

    console.log(`\n=== DỮ LIỆU (${SYMBOL}) ===`);
    console.log(`M5 : ${m5.length} nến  ${m5[0]?.time} -> ${m5.at(-1)?.time}`);
    console.log(`M15: ${m15.length} nến  H1: ${h1.length} nến`);
    const days = (new Date(m5.at(-1)!.time).getTime() - new Date(m5[0]!.time).getTime()) / 86_400_000;
    console.log(`Khoảng M5 ~ ${days.toFixed(1)} ngày lịch`);

    console.log(`\n=== BASELINE theo spread (lot ${defaultXauPullbackConfig.lot}, vốn $${defaultXauPullbackConfig.accountStartUsd}, scalp OFF) ===`);
    for (const spread of [0.15, 0.3, 0.5]) {
      const r = runXauPullbackBacktest(m5, m15, h1, { ...defaultXauPullbackConfig, spreadPrice: spread });
      console.log(line(`spread=${spread}`, r));
    }

    console.log(`\n=== ẢNH HƯỞNG NHÁNH SCALP (spread=0.3) ===`);
    for (const allowScalp of [false, true]) {
      const r = runXauPullbackBacktest(m5, m15, h1, { ...defaultXauPullbackConfig, spreadPrice: 0.3, allowScalp });
      console.log(line(`scalp=${allowScalp}`, r));
    }

    console.log(`\n=== WALK-FORWARD (spread=0.3, scalp OFF, chia 60/40 theo thời gian) ===`);
    const { splitTime, isTrades, oosTrades } = splitByTime(
      m5, m15, h1, { ...defaultXauPullbackConfig, spreadPrice: 0.3 }, 0.6,
    );
    console.log(`Mốc chia: ${splitTime}`);
    console.log(`In-sample : ${JSON.stringify(statOf(isTrades))}`);
    console.log(`Out-sample: ${JSON.stringify(statOf(oosTrades))}`);
    const allTrades = [...isTrades, ...oosTrades];
    const maxRisk = allTrades.length ? Math.max(...allTrades.map((t) => t.riskUsd)) : 0;
    console.log(`Risk/lệnh: max=$${maxRisk.toFixed(2)}  (cap 15% vốn $200 = $30 -> ${maxRisk <= 30 ? "không bind" : "BIND, vài lệnh bị bỏ"})`);

    console.log(`\n=== QUÉT THEO CAP LỖ/LỆNH tại VỐN $200 (spread=0.3, scalp OFF) — tìm mức cap không bóp chết bot ===`);
    for (const capPct of [5, 8, 10, 12, 15, 18, 20]) {
      const r = runXauPullbackBacktest(m5, m15, h1, {
        ...defaultXauPullbackConfig,
        spreadPrice: 0.3,
        accountStartUsd: 200,
        maxLossPercentPerTrade: capPct,
      });
      const avgRiskUsd = r.tradeList.length
        ? r.tradeList.reduce((s, t) => s + t.riskUsd, 0) / r.tradeList.length
        : 0;
      const retPct = ((r.endEquityUsd - 200) / 200) * 100;
      console.log(
        `cap=${String(capPct).padStart(2)}% ($${(200 * capPct / 100).toFixed(0)})  capSkip=${String(r.skippedByRiskCap).padStart(2)}  n=${String(r.trades).padStart(2)}  ` +
        `avgRisk=$${avgRiskUsd.toFixed(1)}(${((avgRiskUsd / 200) * 100).toFixed(1)}%)  ` +
        `net$=${r.netUsd.toFixed(2)}  return=${retPct.toFixed(1)}%  ddUsd=${r.maxDrawdownUsd.toFixed(2)}(${(r.maxDrawdownUsd / 200 * 100).toFixed(1)}%)`,
      );
    }

    const base = runXauPullbackBacktest(m5, m15, h1, { ...defaultXauPullbackConfig, spreadPrice: 0.3 });
    console.log(`\n=== ĐÁNH GIÁ ===`);
    const verdict =
      base.trades < 20
        ? `MẪU QUÁ NHỎ (${base.trades} lệnh, ~${days.toFixed(0)} ngày) — chưa đủ để kết luận.`
        : base.expectancyR > 0.05
          ? `Expectancy DƯƠNG (${base.expectancyR}R/lệnh) trên mẫu này.`
          : base.expectancyR > 0
            ? `Expectancy dương mỏng (${base.expectancyR}R) — chưa đủ bù chi phí/độ trượt thực tế.`
            : `Expectancy ÂM (${base.expectancyR}R/lệnh) — chưa có edge trên mẫu này.`;
    console.log(verdict);

    // Không assert điều kiện lãi/lỗ — test này để ĐO, không phải để pass/fail theo kết quả thị trường.
    expect(base.trades).toBeGreaterThanOrEqual(0);
  });
});
