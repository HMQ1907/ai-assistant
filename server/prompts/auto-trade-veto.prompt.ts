import type { AnalysisPayload } from "../../types/trading";
import type { RuleSignal } from "../strategy/ruleStrategy";
import { tradingRules } from "../config/tradingRules";

export interface AutoTradeVetoPromptInput {
  payload: AnalysisPayload;
  signal: RuleSignal;
  entryTimeframe: string;
  conviction: number;
  lot: number;
  minRiskReward: number;
  allowedLots: number[];
}

export function buildAutoTradeVetoPrompt(input: AutoTradeVetoPromptInput): string {
  const symbol = input.payload.symbols[0]?.market.symbol ?? "EURUSD";
  return [
    `You are the final AI veto checker for an automated ${symbol} rules-engine trade.`,
    "The rules engine has already found a deterministic setup. Your job is the final safety and execution check before a real MT5 order is sent.",
    "Return ALLOW only when the proposed rules-engine trade is safe enough to execute as-is.",
    "You are veto-only: do not change direction, entry, stop_loss, take_profit, or lot. If any proposed level is wrong, BLOCK instead of adjusting it.",
    `Minimum accepted reward:risk is 1:${input.minRiskReward}. TP and SL must be based on visible candle structure, swing highs/lows, liquidity zones, or recent support/resistance. Do not use a blind fixed R target.`,
    "",
    "Hard BLOCK only for these reasons:",
    `- Broker quote is stale: quoteAgeSeconds is null or greater than ${tradingRules.maxQuoteAgeSeconds}.`,
    "- Bid/ask/spread is missing, invalid, or execution looks unavailable.",
    "- Market data quality is LOW, critical_errors are present, or recent candles are clearly frozen/abnormal enough to invalidate the setup.",
    "- Proposed direction clearly conflicts with current H4/H1 structure, not just mild ambiguity.",
    "- Proposed MARKET entry is already invalidated by current price action.",
    `- Stop loss or take profit is nonsensical: wrong side, zero/negative risk, TP on wrong side, or R:R below 1:${input.minRiskReward}.`,
    "- Known fresh high-impact news or abnormal volatility makes immediate automated entry unreasonable.",
    "",
    "If ALLOW, adjusted_trade may repeat the proposed trade exactly for reporting, but it must not change any proposed level or lot.",
    `Allowed lots: ${input.allowedLots.join(", ")}. The proposed lot is fixed at ${input.lot}; do not choose a different lot.`,
    "Do NOT widen SL or move TP to make the trade survive. If the structural SL is too wide or TP is not realistically structural, BLOCK.",
    "Do NOT use account size as a blocker; hard risk sizing is enforced by local code after your veto.",
    "Do NOT block for mild uncertainty, imperfect confidence, lack of a textbook retest, or because you would personally prefer to wait. Put those in warnings and still ALLOW only if adjusted_trade is valid.",
    "All user-facing text must be Vietnamese. Only enum values may remain English.",
    "Return only valid JSON. No markdown.",
    "",
    "Proposed rules-engine trade:",
    JSON.stringify({
      symbol,
      entry_timeframe: input.entryTimeframe,
      direction: input.signal.direction,
      order_type: "MARKET",
      entry: input.signal.entry,
      stop_loss: input.signal.stopLoss,
      take_profit: input.signal.takeProfit,
      reason: input.signal.reason,
      conviction: input.conviction,
      proposed_lot: input.lot,
      allowed_lots: input.allowedLots,
      minimum_risk_reward: input.minRiskReward,
    }),
    "",
    "Return JSON matching this schema exactly:",
    JSON.stringify({
      decision: "ALLOW | BLOCK",
      confidence: 0,
      direction_assessment: "ALIGNED | CONFLICTING | UNCLEAR",
      data_status: "OK | STALE | LOW_QUALITY | EXECUTION_BLOCKED",
      adjusted_trade: {
        order_type: "MARKET",
        lot: input.lot,
        entry: input.signal.entry,
        stop_loss: input.signal.stopLoss,
        take_profit: input.signal.takeProfit,
        risk_reward: input.minRiskReward,
        reason: "Vietnamese reason explaining candle structure behind entry, SL and TP.",
      },
      summary: "Vietnamese short summary.",
      blocker_reasons: [],
      warnings: [],
      checklist: [],
      disclaimer:
        "Vietnamese disclaimer that this is an AI veto check, not financial advice.",
    }),
    "",
    `Normalized ${symbol} market payload:`,
    JSON.stringify(input.payload),
  ].join("\n");
}
