import type { BacktestTrade } from "./backtester";
import {
  defaultRuleStrategyConfig,
  type RuleStrategyConfig,
} from "../strategy/ruleStrategy";

export interface Variant {
  label: string;
  maxHoldBars: number;
  strategy: RuleStrategyConfig;
}

/** Lưới tham số chung cho sweep và walk-forward. */
export function buildGrid(): Variant[] {
  const minRiskRewardValues = [1.5, 1.8, 2.0];
  const emaFastValues = [20, 34];
  const maxHoldValues = [48, 72];
  const filters: Array<{ tag: string; patch: Partial<RuleStrategyConfig> }> = [
    { tag: "base", patch: {} },
    { tag: "rsi", patch: { useRsiFilter: true } },
    { tag: "structure", patch: { biasMode: "STRUCTURE" } },
    { tag: "engulfing", patch: { confirmMode: "ENGULFING" } },
  ];

  const variants: Variant[] = [];
  for (const rrTarget of minRiskRewardValues) {
    for (const emaFast of emaFastValues) {
      for (const maxHoldBars of maxHoldValues) {
        for (const filter of filters) {
          variants.push({
            label: `${filter.tag}|rr${rrTarget}|ema${emaFast}|hold${maxHoldBars}`,
            maxHoldBars,
            strategy: {
              ...defaultRuleStrategyConfig,
              rrTarget,
              emaFast,
              ...filter.patch,
            },
          });
        }
      }
    }
  }
  return variants;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyR: number;
  totalR: number;
  profitFactor: number;
}

export function tradeStats(trades: BacktestTrade[]): TradeStats {
  const wins = trades.filter((trade) => trade.outcome === "WIN");
  const losses = trades.filter((trade) => trade.outcome === "LOSS");
  const totalR = trades.reduce((sum, trade) => sum + trade.rMultiple, 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.rMultiple, 0));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length + losses.length > 0
      ? round((wins.length / (wins.length + losses.length)) * 100)
      : 0,
    expectancyR: trades.length > 0 ? round(totalR / trades.length) : 0,
    totalR: round(totalR),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : value;
}
