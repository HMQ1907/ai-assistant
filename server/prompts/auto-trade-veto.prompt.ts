import type { AnalysisPayload } from "../../types/trading";
import type { RuleSignal } from "../strategy/ruleStrategy";
import { tradingRules } from "../config/tradingRules";

export interface AutoTradeVetoPromptInput {
  payload: AnalysisPayload;
  signal: RuleSignal;
  entryTimeframe: string;
  conviction: number;
  lot: number;
}

export function buildAutoTradeVetoPrompt(input: AutoTradeVetoPromptInput): string {
  const symbol = input.payload.symbols[0]?.market.symbol ?? "XAUUSD";
  return [
    `You are the final AI veto checker for an automated ${symbol} rules-engine trade.`,
    "The rules engine has already found a deterministic setup. Your job is NOT to find a better setup, NOT to demand a perfect discretionary trade, and NOT to apply the manual/scanner TRADE vs NO_TRADE rules.",
    "Return ALLOW unless there is a clear, serious blocker that makes this specific proposed trade unsafe or technically invalid right now.",
    "",
    "Hard BLOCK only for these reasons:",
    `- Broker quote is stale: quoteAgeSeconds is null or greater than ${tradingRules.maxQuoteAgeSeconds}.`,
    "- Bid/ask/spread is missing, invalid, or execution looks unavailable.",
    "- Market data quality is LOW, critical_errors are present, or recent candles are clearly frozen/abnormal enough to invalidate the setup.",
    "- Proposed direction clearly conflicts with current H4/H1 structure, not just mild ambiguity.",
    "- Proposed MARKET entry is already invalidated by current price action.",
    "- Stop loss or take profit is nonsensical: wrong side, zero/negative risk, TP on wrong side, or R:R below the configured target by a meaningful margin.",
    "- Known fresh high-impact news or abnormal volatility makes immediate automated entry unreasonable.",
    "",
    "Do NOT block for mild uncertainty, imperfect confidence, lack of a textbook retest, or because you would personally prefer to wait. Put those in warnings and still ALLOW.",
    "Do NOT use lot size, account size, or money management as a blocker. The user configured fixed lots separately.",
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
      lot: input.lot,
    }),
    "",
    "Return JSON matching this schema exactly:",
    JSON.stringify({
      decision: "ALLOW | BLOCK",
      confidence: 0,
      direction_assessment: "ALIGNED | CONFLICTING | UNCLEAR",
      data_status: "OK | STALE | LOW_QUALITY | EXECUTION_BLOCKED",
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
