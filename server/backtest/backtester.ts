import type { Candle } from "../../types/trading";
import {
  defaultRuleStrategyConfig,
  evaluateRuleSignal,
  type RuleStrategyConfig,
} from "../strategy/ruleStrategy";

export interface BacktestConfig {
  strategy: RuleStrategyConfig;
  maxHoldBars: number; // số nến H1 tối đa giữ lệnh trước khi đóng theo giá đóng cửa
  startIndex: number; // bỏ qua các nến đầu để indicator đủ dữ liệu
  spreadPrice: number; // chi phí round-turn theo GIÁ (spread+commission), trừ vào mỗi lệnh
}

export const defaultBacktestConfig: BacktestConfig = {
  strategy: defaultRuleStrategyConfig,
  maxHoldBars: 48,
  startIndex: 210,
  spreadPrice: 0,
};

export interface BacktestTrade {
  direction: "BUY" | "SELL";
  entryTime: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitTime: string;
  exitPrice: number;
  outcome: "WIN" | "LOSS" | "EXPIRED";
  rMultiple: number; // lời/lỗ tính theo bội số rủi ro (1R = khoảng entry->SL)
}

export interface BacktestResult {
  symbol: string;
  bars: number;
  trades: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number; // % trên (wins+losses)
  expectancyR: number; // R trung bình mỗi lệnh — chỉ số quan trọng nhất
  avgWinR: number;
  avgLossR: number;
  profitFactor: number; // tổng R thắng / |tổng R thua|
  totalR: number;
  maxDrawdownR: number;
  tradeList: BacktestTrade[];
}

/**
 * Chạy method tất định qua chuỗi nến H1 (bias lấy từ H4 căn theo thời gian).
 * Mỗi lần chỉ 1 lệnh. Giải lệnh bằng high/low của các nến H1 kế tiếp
 * (cùng nến chạm cả SL/TP -> coi SL trước, thận trọng).
 */
export function runBacktest(
  symbol: string,
  entryCandles: Candle[],
  biasCandles: Candle[],
  config: BacktestConfig = defaultBacktestConfig,
  intermediateCandles?: Candle[],
): BacktestResult {
  const trades: BacktestTrade[] = [];
  let open: {
    direction: "BUY" | "SELL";
    entryIndex: number;
    entryTime: string;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    risk: number;
  } | null = null;

  let biasIdx = 0;
  let interIdx = 0;

  for (let i = config.startIndex; i < entryCandles.length; i += 1) {
    const bar = entryCandles[i];
    if (!bar) continue;

    if (open) {
      const resolved = resolveBar(open, bar);
      if (resolved || i - open.entryIndex >= config.maxHoldBars) {
        const outcome: BacktestTrade["outcome"] = resolved ?? "EXPIRED";
        const exitPrice =
          outcome === "WIN"
            ? open.takeProfit
            : outcome === "LOSS"
              ? open.stopLoss
              : bar.close;
        // R ròng = R thô trừ chi phí round-turn (spread/commission) quy theo rủi ro.
        const costR = open.risk > 0 ? config.spreadPrice / open.risk : 0;
        const rMultiple = computeR(open, exitPrice) - costR;
        trades.push({
          direction: open.direction,
          entryTime: open.entryTime,
          entry: open.entry,
          stopLoss: open.stopLoss,
          takeProfit: open.takeProfit,
          exitTime: bar.time,
          exitPrice: round(exitPrice),
          outcome,
          rMultiple: round(rMultiple),
        });
        open = null;
      }
      continue;
    }

    // Flat: căn bias (và intermediate) tới thời điểm nến entry hiện tại rồi đánh giá.
    while (biasIdx + 1 < biasCandles.length && (biasCandles[biasIdx + 1]?.time ?? "") <= bar.time) {
      biasIdx += 1;
    }
    const biasSlice = biasCandles.slice(0, biasIdx + 1);

    let interSlice: Candle[] | undefined;
    if (intermediateCandles && intermediateCandles.length > 0) {
      while (
        interIdx + 1 < intermediateCandles.length &&
        (intermediateCandles[interIdx + 1]?.time ?? "") <= bar.time
      ) {
        interIdx += 1;
      }
      interSlice = intermediateCandles.slice(0, interIdx + 1);
    }

    const signal = evaluateRuleSignal(
      entryCandles.slice(0, i + 1),
      biasSlice,
      config.strategy,
      interSlice,
    );
    if (!signal) continue;

    const risk =
      signal.direction === "BUY"
        ? signal.entry - signal.stopLoss
        : signal.stopLoss - signal.entry;
    if (risk <= 0) continue;

    open = {
      direction: signal.direction,
      entryIndex: i,
      entryTime: bar.time,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      risk,
    };
  }

  return summarize(symbol, entryCandles.length, trades);
}

function resolveBar(
  open: { direction: "BUY" | "SELL"; stopLoss: number; takeProfit: number },
  bar: Candle,
): "WIN" | "LOSS" | null {
  if (open.direction === "BUY") {
    const hitSl = bar.low <= open.stopLoss;
    const hitTp = bar.high >= open.takeProfit;
    if (hitSl) return "LOSS"; // cùng nến chạm cả 2 -> SL trước (thận trọng)
    if (hitTp) return "WIN";
    return null;
  }
  const hitSl = bar.high >= open.stopLoss;
  const hitTp = bar.low <= open.takeProfit;
  if (hitSl) return "LOSS";
  if (hitTp) return "WIN";
  return null;
}

function computeR(
  open: { direction: "BUY" | "SELL"; entry: number; risk: number },
  exitPrice: number,
): number {
  const move =
    open.direction === "BUY" ? exitPrice - open.entry : open.entry - exitPrice;
  return move / open.risk;
}

function summarize(
  symbol: string,
  bars: number,
  trades: BacktestTrade[],
): BacktestResult {
  const wins = trades.filter((trade) => trade.outcome === "WIN");
  const losses = trades.filter((trade) => trade.outcome === "LOSS");
  const expired = trades.filter((trade) => trade.outcome === "EXPIRED");
  const totalR = sum(trades.map((trade) => trade.rMultiple));
  const grossWin = sum(wins.map((trade) => trade.rMultiple));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.rMultiple)));

  // Drawdown theo đường cong R cộng dồn.
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const trade of trades) {
    equity += trade.rMultiple;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  return {
    symbol,
    bars,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    winRate: pct(wins.length, wins.length + losses.length),
    expectancyR: round(trades.length ? totalR / trades.length : 0),
    avgWinR: round(wins.length ? grossWin / wins.length : 0),
    avgLossR: round(losses.length ? -grossLoss / losses.length : 0),
    profitFactor:
      grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
    totalR: round(totalR),
    maxDrawdownR: round(maxDd),
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
  return Number.isFinite(value) ? Number(value.toFixed(3)) : value;
}
