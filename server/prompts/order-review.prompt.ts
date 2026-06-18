import type {
  AnalysisHistoryRecord,
  AnalysisPayload,
} from "../../types/trading";

export interface OrderReviewPromptInput {
  history: AnalysisHistoryRecord;
  latestPayload: AnalysisPayload;
  actualEntry: number | null;
  actualExit: number | null;
  actualProfitLoss: number | null;
  actualOrderPlacedAt: string | null;
  userNote: string;
  resultStatus: string;
}

export function buildOrderReviewPrompt(input: OrderReviewPromptInput): string {
  const symbol = input.history.symbol === "EURUSD" ? "EURUSD" : "XAUUSD";
  return JSON.stringify(
    {
      task: `Review an existing manual ${symbol} trade recommendation using the latest market data. Determine whether the pending order was likely filled, invalidated, should remain unchanged, should be cancelled, whether SL or TP should be adjusted, or whether an already-open position should be closed manually.`,
      mandatory_rules: [
        "This is a read-only trading assistant. Never place, modify, cancel, or execute any order.",
        "Return one strict JSON object only. Do not use Markdown or add text outside JSON.",
        "All user-facing content MUST be written in Vietnamese.",
        "Only enum values, symbols, and technical abbreviations may remain in English.",
        "Do not recommend increasing risk, widening SL to avoid a loss, martingale, DCA into a losing position, or revenge trading.",
        "Use the original recommendation together with the latest candles, indicators, price, and news.",
        "Review BOTH scenarios when present: the main recommendation and ai_result.risky_trade. Do not ignore risky_trade.",
        "Return scenario_reviews with one item for MAIN_RECOMMENDATION and one item for RISKY_TRADE when risky_trade exists and enabled is true.",
        "If the main recommendation is NO_TRADE or has no valid entry/SL/TP, still include MAIN_RECOMMENDATION with available=false and explain that there is no executable main order to manage.",
        "For any scenario with available=false, set confidence to 0 and use entry_zone=null, stop_loss=null, take_profit=null. Do not assign a high confidence to a scenario that has no executable order.",
        "For RISKY_TRADE, use ai_result.risky_trade.entry_zone, stop_loss, take_profit, order_type, entry_conditions and cancel_conditions as the exact scenario being checked.",
        "The top-level recommended_action should summarize the safest overall action across both scenarios; scenario_reviews must contain the separate action for each scenario.",
        "If actual_order_placed_at is supplied, use it as the real Exness order placement time. Compare latest candles after that timestamp to judge whether entry was touched, whether cancellation conditions happened before fill, and whether the setup is still valid.",
        "If actual_order_placed_at is missing, state that fill and invalidation timing is uncertain and ask the user to verify the Exness order placement time manually.",
        "If execution data is unavailable, never claim with certainty that an order was filled. Use LIKELY_FILLED or UNCLEAR.",
        "If the user supplied actual_entry, treat the position as filled unless the other supplied fields clearly contradict it.",
        "If actual_exit is present or result_status is WIN, LOSS, or BREAKEVEN, select TRADE_COMPLETED and do not suggest any further order-management action.",
        "Only suggest moving SL when it reduces or controls risk and the new level is technically valid.",
        "Only suggest moving TP when market structure materially changed. Explain the exact reason.",
        "When evidence is insufficient, select WAIT or KEEP_ORDER and clearly state what must be checked manually on Exness.",
      ],
      output_schema: {
        symbol: symbol,
        reviewed_history_id: input.history.id,
        current_price: 0,
        order_status_assessment:
          "LIKELY_NOT_FILLED | LIKELY_FILLED | ALREADY_INVALIDATED | UNCLEAR",
        recommended_action:
          "KEEP_ORDER | CANCEL_ORDER | MOVE_SL | MOVE_TP | MOVE_SL_TP | WAIT | CLOSE_MANUALLY | TRADE_COMPLETED",
        confidence: "number from 0 to 100",
        summary: "Vietnamese summary",
        fill_assessment: "Vietnamese fill-status assessment",
        action_reason: "Vietnamese reason for the recommended action",
        stop_loss_plan: {
          keep_current: true,
          suggested_stop_loss: null,
          reason: "Vietnamese explanation",
        },
        take_profit_plan: {
          keep_current: true,
          suggested_take_profit: null,
          reason: "Vietnamese explanation",
        },
        cancellation_conditions: ["Vietnamese cancellation condition"],
        risk_warnings: ["Vietnamese risk warning"],
        next_check_minutes: "integer from 1 to 240",
        checklist: ["Vietnamese manual check on Exness"],
        scenario_reviews: [
          {
            scenario: "MAIN_RECOMMENDATION | RISKY_TRADE",
            title: "Vietnamese scenario title",
            available: true,
            order_status_assessment:
              "LIKELY_NOT_FILLED | LIKELY_FILLED | ALREADY_INVALIDATED | UNCLEAR",
            recommended_action:
              "KEEP_ORDER | CANCEL_ORDER | MOVE_SL | MOVE_TP | MOVE_SL_TP | WAIT | CLOSE_MANUALLY | TRADE_COMPLETED",
            confidence:
              "number from 0 to 100; must be 0 when available is false",
            summary: "Vietnamese scenario-specific summary",
            fill_assessment: "Vietnamese scenario-specific fill assessment",
            action_reason: "Vietnamese scenario-specific action reason",
            entry_zone: { from: 0, to: 0 },
            stop_loss: 0,
            take_profit: 0,
            cancellation_conditions: ["Vietnamese cancellation condition"],
            risk_warnings: ["Vietnamese risk warning"],
            checklist: ["Vietnamese manual check for this scenario"],
          },
        ],
        disclaimer:
          "Đây là gợi ý phân tích từ AI, không phải lời khuyên tài chính. Người dùng tự chịu trách nhiệm với quyết định giao dịch.",
      },
      original_recommendation: {
        id: input.history.id,
        created_at: input.history.created_at,
        decision: input.history.decision,
        direction: input.history.direction,
        confidence: input.history.confidence,
        entry_from: input.history.entry_from,
        entry_to: input.history.entry_to,
        stop_loss: input.history.stop_loss,
        take_profit: input.history.take_profit,
        ai_result: input.history.parsed_result,
      },
      user_trade_state: {
        result_status: input.resultStatus,
        actual_order_placed_at: input.actualOrderPlacedAt,
        actual_entry: input.actualEntry,
        actual_exit: input.actualExit,
        actual_profit_loss: input.actualProfitLoss,
        user_note: input.userNote,
      },
      latest_market_payload: input.latestPayload,
    },
    null,
    2,
  );
}
