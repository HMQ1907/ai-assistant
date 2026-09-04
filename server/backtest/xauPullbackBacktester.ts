import type { Candle } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import {
  defaultXauIctConfig,
  evaluateXauClassicPriceActionSignal,
  evaluateXauIctSignal,
  explainXauIctRejection,
  type XauIctConfig,
  type XauClassicPriceActionConfig,
} from "../strategy/ruleStrategy";
import {
  defaultXauRftpConfig,
  evaluateXauRftpSignal,
  type XauRftpConfig,
} from "../strategy/xauRftpStrategy";

/**
 * Backtester TÁI HIỆN đúng luồng auto-bot mode ICT rulebook (khung vào lệnh M5),
 * thay cho `xau_trend_pullback` cũ đã bị gỡ khỏi ruleStrategy.ts.
 *
 * File này mô phỏng đúng cái AutoTradeRunner đặt lệnh thật:
 *   - Mỗi nến M5 đóng: gọi evaluateXauIctSignal(m5, m15, h1, h4, config) với M15/H1/H4 căn theo thời gian.
 *   - Vào MARKET tại close nến trigger; SL/TP lấy từ chính signal.
 *   - Break-even: chạm +1R -> dời SL về entry (+ đệm spread), đúng moveEligibleOrdersToBreakEven.
 *   - Time-stop: giữ tối đa maxHoldBars nến M5 -> đóng theo close.
 *   - Cooldown: sau khi đóng lệnh, chờ cooldownBars nến M5 mới quét lại.
 *   - 1 lệnh tại một thời điểm.
 *   - Chi phí round-turn (spread+commission) quy theo GIÁ, trừ vào mỗi lệnh.
 * Giải lệnh bằng high/low của nến M5 kế tiếp; cùng nến chạm cả SL/TP -> coi SL trước (thận trọng).
 *
 * newsWindowClear luôn = true trong backtest (không có dữ liệu tin tức lịch sử) —
 * kết quả vì vậy lạc quan hơn live một chút ở đúng những khung giờ tin nóng.
 */
export interface XauIctBacktestConfig {
  spreadPrice: number; // chi phí round-turn theo giá (vd 0.30 USD cho vàng)
  maxHoldBars: number; // số nến M5 tối đa giữ lệnh
  cooldownBars: number; // số nến M5 nghỉ sau khi đóng lệnh
  breakEvenAtR: number; // chạm bao nhiêu R thì dời SL về hòa vốn
  lot: number; // khối lượng cố định để quy ra USD
  accountStartUsd: number; // vốn khởi điểm để vẽ đường equity
  // Bộ lọc risk-cap ĐÚNG như checkAutoRisk() của live: skip lệnh nếu lỗ ước tính
  // (SL distance * lot * ouncesPerLot) > accountSizeUsd * maxLossPercentPerTrade%.
  maxLossPercentPerTrade: number;
  ictConfig: XauIctConfig;
  classicConfig?: XauClassicPriceActionConfig;
  rftpConfig?: XauRftpConfig;
  strategyMode?: "ICT" | "CLASSIC" | "RFTP";
}

export const defaultXauIctBacktestConfig: XauIctBacktestConfig = {
  spreadPrice: 0.3,
  maxHoldBars: 864,
  cooldownBars: 9,
  breakEvenAtR: 1,
  lot: 0.01,
  accountStartUsd: 200,
  maxLossPercentPerTrade: 15,
  ictConfig: defaultXauIctConfig,
  strategyMode: "ICT",
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

/** Đủ cho previous-day + Asia range + lookback chuỗi sweep/displacement/swing confirm. */
const M15_WINDOW = 2_100;
const H4_WINDOW = 200;
const H1_WINDOW = 300;
const M5_MS = 5 * 60_000;
const M15_MS = 15 * 60_000;
const H1_MS = 60 * 60_000;
const H4_MS = 4 * 60 * 60_000;

function tailWindow(candles: Candle[], lastIdx: number, window: number): Candle[] {
  return candles.slice(Math.max(0, lastIdx + 1 - window), lastIdx + 1);
}

export function runXauIctBacktest(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  h4: Candle[] = [],
  config: XauIctBacktestConfig = defaultXauIctBacktestConfig,
): XauBacktestResult {
  const trades: XauBacktestTrade[] = [];
  let open: OpenPosition | null = null;
  let cooldownUntil = -1;
  let m15Idx = 0;
  let h4Idx = 0;
  let h1Idx = 0;
  let signalsRaw = 0;
  let skippedByRiskCap = 0;
  const maxLossUsd = config.accountStartUsd * (config.maxLossPercentPerTrade / 100);
  const debugReasons = process.env.DEBUG_ICT_REASONS === "1";
  const reasonCounts = new Map<string, number>();

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

    // MT5 lưu timestamp là LÚC MỞ nến. Chỉ đưa nến HTF vào engine khi nó đã đóng
    // tại thời điểm nến M5 trigger đóng, tránh lookahead bias trong backtest.
    const triggerCloseMs = Date.parse(bar.time) + M5_MS;
    while (m15Idx + 1 < m15.length && Date.parse(m15[m15Idx + 1]?.time ?? "") + M15_MS <= triggerCloseMs) m15Idx += 1;
    while (h4Idx + 1 < h4.length && Date.parse(h4[h4Idx + 1]?.time ?? "") + H4_MS <= triggerCloseMs) h4Idx += 1;
    while (h1Idx + 1 < h1.length && Date.parse(h1[h1Idx + 1]?.time ?? "") + H1_MS <= triggerCloseMs) h1Idx += 1;
    const m15Slice = tailWindow(m15, m15Idx, M15_WINDOW);
    const h4Slice = tailWindow(h4, h4Idx, H4_WINDOW);
    const h1Slice = h1.length ? tailWindow(h1, h1Idx, H1_WINDOW) : [];
    const m5Slice = tailWindow(m5, i, config.strategyMode === "RFTP" ? 120 : 20);

    const evalOptions = {
      now: new Date(bar.time),
      newsWindowClear: true,
      spreadPrice: config.spreadPrice,
    };
    const signal = config.strategyMode === "RFTP"
      ? evaluateXauRftpSignal(m5Slice, m15Slice, h1Slice, {
          now: new Date(triggerCloseMs),
          newsWindowClear: true,
          spreadPrice: bar.spread ?? config.spreadPrice,
        }, config.rftpConfig ?? defaultXauRftpConfig)
      : config.strategyMode === "CLASSIC"
        ? evaluateXauClassicPriceActionSignal(m5Slice, m15Slice, h1Slice, evalOptions, config.classicConfig)
        : evaluateXauIctSignal(m5Slice, m15Slice, h1Slice, h4Slice, config.ictConfig, evalOptions);
    if (!signal) {
      if (debugReasons) {
        const reason = explainXauIctRejection(m5Slice, m15Slice, h1Slice, h4Slice, config.ictConfig, evalOptions);
        const key = reason.replace(/[-+]?[0-9]+\.?[0-9]*/g, "#").slice(0, 90);
        reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
      }
      continue;
    }

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

  if (debugReasons) {
    const sorted = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    console.log("\n[DEBUG_ICT_REASONS] top lý do NO_TRADE (đã gộp số):");
    for (const [reason, count] of sorted) {
      console.log(`  ${String(count).padStart(6)}x  ${reason}`);
    }
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
  config: XauIctBacktestConfig,
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
  config: XauIctBacktestConfig,
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
  config: XauIctBacktestConfig,
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
