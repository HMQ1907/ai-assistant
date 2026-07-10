import type { Candle } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { evaluateXauTrendPullbackSignal } from "../strategy/ruleStrategy";

/**
 * Backtester TÁI HIỆN đúng luồng auto-bot mode `xau_trend_pullback` (khung vào lệnh M5).
 *
 * Khác với backtester.ts (chỉ chạy evaluateRuleSignal H1), file này mô phỏng đúng
 * cái AutoTradeRunner đang đặt lệnh thật:
 *   - Mỗi nến M5 đóng: gọi evaluateXauTrendPullbackSignal(m5, m15, h1) với M15/H1 căn theo thời gian.
 *   - Vào MARKET tại close nến trigger; SL/TP lấy từ chính signal.
 *   - Break-even: chạm +1R -> dời SL về entry (+ đệm spread), đúng moveEligibleOrdersToBreakEven.
 *   - Time-stop: giữ tối đa maxHoldBars nến M5 (72h) -> đóng theo close.
 *   - Cooldown: sau khi đóng lệnh, chờ cooldownBars nến M5 (45') mới quét lại.
 *   - 1 lệnh tại một thời điểm.
 *   - Chi phí round-turn (spread+commission) quy theo GIÁ, trừ vào mỗi lệnh.
 * Giải lệnh bằng high/low của nến M5 kế tiếp; cùng nến chạm cả SL/TP -> coi SL trước (thận trọng).
 */
export interface XauPullbackBacktestConfig {
  spreadPrice: number; // chi phí round-turn theo giá (vd 0.30 USD cho vàng)
  maxHoldBars: number; // số nến M5 tối đa giữ lệnh (72h = 864)
  cooldownBars: number; // số nến M5 nghỉ sau khi đóng lệnh (45' = 9)
  breakEvenAtR: number; // chạm bao nhiêu R thì dời SL về hòa vốn
  allowScalp: boolean; // bật nhánh momentum-scalp dự phòng hay không
  lot: number; // khối lượng cố định để quy ra USD
  accountStartUsd: number; // vốn khởi điểm để vẽ đường equity
  // Bộ lọc risk-cap ĐÚNG như checkAutoRisk() của live: skip lệnh nếu lỗ ước tính
  // (SL distance * lot * ouncesPerLot) > accountSizeUsd * maxLossPercentPerTrade%.
  maxLossPercentPerTrade: number;
}

export const defaultXauPullbackConfig: XauPullbackBacktestConfig = {
  spreadPrice: 0.3,
  maxHoldBars: 864,
  cooldownBars: 9,
  breakEvenAtR: 1,
  allowScalp: false,
  lot: 0.01,
  accountStartUsd: 200,
  maxLossPercentPerTrade: 15,
};

export interface XauBacktestTrade {
  direction: "BUY" | "SELL";
  entryTime: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitTime: string;
  exitPrice: number;
  outcome: "WIN" | "LOSS" | "BREAKEVEN" | "TIMESTOP";
  rMultiple: number; // đã trừ chi phí spread
  usd: number; // lãi/lỗ USD với lot cố định
  riskUsd: number; // rủi ro USD của lệnh (SL distance * lot * oz)
  holdBars: number;
}

export interface XauBacktestResult {
  bars: number;
  firstTime: string;
  lastTime: string;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  timestop: number;
  signalsRaw: number; // số tín hiệu thô trước bộ lọc risk-cap
  skippedByRiskCap: number; // số tín hiệu bị bỏ vì SL quá rộng so với cap (giống live)
  winRate: number; // % trên (wins+losses)
  expectancyR: number; // R trung bình mỗi lệnh — chỉ số quan trọng nhất
  avgWinR: number;
  avgLossR: number;
  profitFactor: number;
  totalR: number;
  maxDrawdownR: number;
  netUsd: number;
  endEquityUsd: number;
  maxDrawdownUsd: number;
  tradeList: XauBacktestTrade[];
}

interface OpenPosition {
  direction: "BUY" | "SELL";
  entryIndex: number;
  entryTime: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  risk: number;
  movedToBreakEven: boolean;
}

export function runXauPullbackBacktest(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  config: XauPullbackBacktestConfig = defaultXauPullbackConfig,
): XauBacktestResult {
  const trades: XauBacktestTrade[] = [];
  let open: OpenPosition | null = null;
  let cooldownUntil = -1;
  let m15Idx = 0;
  let h1Idx = 0;
  let signalsRaw = 0;
  let skippedByRiskCap = 0;
  const maxLossUsd = config.accountStartUsd * (config.maxLossPercentPerTrade / 100);

  for (let i = 0; i < m5.length; i += 1) {
    const bar = m5[i];
    if (!bar) continue;

    // Đóng vị thế đang mở trước khi xét tín hiệu mới.
    if (open) {
      const holdBars = i - open.entryIndex;
      const resolved = resolveOpen(open, bar, config);
      if (resolved) {
        trades.push(buildTrade(open, bar, resolved, holdBars, config));
        cooldownUntil = i + config.cooldownBars;
        open = null;
      } else if (holdBars >= config.maxHoldBars) {
        trades.push(
          buildTrade(open, bar, { outcome: "TIMESTOP", exitPrice: bar.close }, holdBars, config),
        );
        cooldownUntil = i + config.cooldownBars;
        open = null;
      }
      continue;
    }

    if (i <= cooldownUntil) continue;

    // Căn M15/H1 tới thời điểm nến M5 hiện tại (chỉ dùng nến đã đóng <= bar.time).
    while (m15Idx + 1 < m15.length && (m15[m15Idx + 1]?.time ?? "") <= bar.time) m15Idx += 1;
    while (h1Idx + 1 < h1.length && (h1[h1Idx + 1]?.time ?? "") <= bar.time) h1Idx += 1;
    const m15Slice = m15.slice(0, m15Idx + 1);
    const h1Slice = h1.slice(0, h1Idx + 1);
    if (h1Slice.length < 220 || m15Slice.length < 220) continue;

    const signal = evaluateXauTrendPullbackSignal(
      m5.slice(0, i + 1),
      m15Slice,
      h1Slice,
      { allowScalp: config.allowScalp },
    );
    if (!signal) continue;

    const risk =
      signal.direction === "BUY"
        ? signal.entry - signal.stopLoss
        : signal.stopLoss - signal.entry;
    if (!Number.isFinite(risk) || risk <= 0) continue;
    signalsRaw += 1;

    // Bộ lọc risk-cap ĐÚNG như checkAutoRisk() của live.
    const estLossUsd = risk * config.lot * tradingRules.xauUsdOuncesPerLot;
    if (estLossUsd > maxLossUsd) {
      skippedByRiskCap += 1;
      continue;
    }

    open = {
      direction: signal.direction,
      entryIndex: i,
      entryTime: bar.time,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      risk,
      movedToBreakEven: false,
    };
  }

  return summarize(m5, trades, config, signalsRaw, skippedByRiskCap);
}

interface Resolution {
  outcome: XauBacktestTrade["outcome"];
  exitPrice: number;
}

function resolveOpen(
  open: OpenPosition,
  bar: Candle,
  config: XauPullbackBacktestConfig,
): Resolution | null {
  const buffer = config.spreadPrice; // đệm hòa vốn ~ spread, giống spreadBuffer() live
  if (open.direction === "BUY") {
    // Cùng nến chạm cả SL/TP -> SL trước (thận trọng).
    if (bar.low <= open.stopLoss) {
      return {
        outcome: open.movedToBreakEven ? "BREAKEVEN" : "LOSS",
        exitPrice: open.stopLoss,
      };
    }
    if (bar.high >= open.takeProfit) return { outcome: "WIN", exitPrice: open.takeProfit };
    if (!open.movedToBreakEven && bar.high >= open.entry + config.breakEvenAtR * open.risk) {
      open.stopLoss = open.entry + buffer;
      open.movedToBreakEven = true;
    }
  } else {
    if (bar.high >= open.stopLoss) {
      return {
        outcome: open.movedToBreakEven ? "BREAKEVEN" : "LOSS",
        exitPrice: open.stopLoss,
      };
    }
    if (bar.low <= open.takeProfit) return { outcome: "WIN", exitPrice: open.takeProfit };
    if (!open.movedToBreakEven && bar.low <= open.entry - config.breakEvenAtR * open.risk) {
      open.stopLoss = open.entry - buffer;
      open.movedToBreakEven = true;
    }
  }

  return null;
}

function buildTrade(
  open: OpenPosition,
  bar: Candle,
  resolution: Resolution,
  holdBars: number,
  config: XauPullbackBacktestConfig,
): XauBacktestTrade {
  const move =
    open.direction === "BUY"
      ? resolution.exitPrice - open.entry
      : open.entry - resolution.exitPrice;
  const costR = open.risk > 0 ? config.spreadPrice / open.risk : 0;
  const rMultiple = move / open.risk - costR;
  const usd = rMultiple * open.risk * config.lot * tradingRules.xauUsdOuncesPerLot;
  return {
    direction: open.direction,
    entryTime: open.entryTime,
    entry: round(open.entry),
    stopLoss: round(open.stopLoss),
    takeProfit: round(open.takeProfit),
    exitTime: bar.time,
    exitPrice: round(resolution.exitPrice),
    outcome: resolution.outcome,
    rMultiple: round(rMultiple),
    usd: Number(usd.toFixed(2)),
    riskUsd: Number((open.risk * config.lot * tradingRules.xauUsdOuncesPerLot).toFixed(2)),
    holdBars,
  };
}

function summarize(
  m5: Candle[],
  trades: XauBacktestTrade[],
  config: XauPullbackBacktestConfig,
  signalsRaw: number,
  skippedByRiskCap: number,
): XauBacktestResult {
  const wins = trades.filter((t) => t.outcome === "WIN");
  const losses = trades.filter((t) => t.outcome === "LOSS");
  const breakeven = trades.filter((t) => t.outcome === "BREAKEVEN");
  const timestop = trades.filter((t) => t.outcome === "TIMESTOP");
  const totalR = sum(trades.map((t) => t.rMultiple));
  const grossWin = sum(trades.filter((t) => t.rMultiple > 0).map((t) => t.rMultiple));
  const grossLoss = Math.abs(sum(trades.filter((t) => t.rMultiple < 0).map((t) => t.rMultiple)));

  let equityR = 0;
  let peakR = 0;
  let maxDdR = 0;
  let equityUsd = config.accountStartUsd;
  let peakUsd = config.accountStartUsd;
  let maxDdUsd = 0;
  for (const t of trades) {
    equityR += t.rMultiple;
    peakR = Math.max(peakR, equityR);
    maxDdR = Math.max(maxDdR, peakR - equityR);
    equityUsd += t.usd;
    peakUsd = Math.max(peakUsd, equityUsd);
    maxDdUsd = Math.max(maxDdUsd, peakUsd - equityUsd);
  }

  return {
    bars: m5.length,
    firstTime: m5[0]?.time ?? "",
    lastTime: m5.at(-1)?.time ?? "",
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    timestop: timestop.length,
    signalsRaw,
    skippedByRiskCap,
    winRate: pct(wins.length, wins.length + losses.length),
    expectancyR: round(trades.length ? totalR / trades.length : 0),
    avgWinR: round(wins.length ? grossWin / Math.max(1, trades.filter((t) => t.rMultiple > 0).length) : 0),
    avgLossR: round(losses.length ? -grossLoss / Math.max(1, trades.filter((t) => t.rMultiple < 0).length) : 0),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
    totalR: round(totalR),
    maxDrawdownR: round(maxDdR),
    netUsd: Number((equityUsd - config.accountStartUsd).toFixed(2)),
    endEquityUsd: Number(equityUsd.toFixed(2)),
    maxDrawdownUsd: Number(maxDdUsd.toFixed(2)),
    tradeList: trades,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function round(value: number): number {
  if (!Number.isFinite(value)) return value;
  const digits = Math.abs(value) >= 100 ? 3 : 5;
  return Number(value.toFixed(digits));
}
