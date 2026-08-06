import { defaultXauIctConfig, type XauIctConfig } from "../strategy/ruleStrategy";
import type { XauBacktestTrade } from "./xauPullbackBacktester";

export interface Variant {
  label: string;
  maxHoldBars: number;
  ictConfig: XauIctConfig;
}

/** Lưới tham số ICT rulebook (v0.1, không ATR/OB/FVG) cho sweep và walk-forward. */
export function buildGrid(): Variant[] {
  const minTargetRValues = [1.5, 2.0, 2.5];
  const retestExpiryValues = [5, 8, 12];
  const maxHoldValues = [288, 864]; // 24h / 72h theo nến M5
  const filters: Array<{ tag: string; patch: Partial<XauIctConfig> }> = [
    { tag: "base", patch: {} },
    { tag: "wideZone", patch: { zoneBodyFraction: 0.75 } },
    { tag: "narrowZone", patch: { zoneBodyFraction: 0.3 } },
    { tag: "wideBuffer", patch: { fixedPriceBuffer: 0.4 } },
  ];

  const variants: Variant[] = [];
  for (const minTargetR of minTargetRValues) {
    for (const retestExpiryM5Bars of retestExpiryValues) {
      for (const maxHoldBars of maxHoldValues) {
        for (const filter of filters) {
          variants.push({
            label: `${filter.tag}|r${minTargetR}|retest${retestExpiryM5Bars}|hold${maxHoldBars}`,
            maxHoldBars,
            ictConfig: {
              ...defaultXauIctConfig,
              minTargetR,
              retestExpiryM5Bars,
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

export function tradeStats(trades: XauBacktestTrade[]): TradeStats {
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
