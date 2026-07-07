import type {
  ActiveMt5Order,
  AnalysisHistoryRecord,
  AnalysisPayload,
} from "../../types/trading";

export interface ActiveOrderReviewPromptInput {
  order: ActiveMt5Order;
  latestPayload: AnalysisPayload;
  matchingHistory: AnalysisHistoryRecord | null;
}

export function buildActiveOrderReviewPrompt(
  input: ActiveOrderReviewPromptInput,
): string {
  const symbol = input.latestPayload.symbols[0]?.market.symbol ?? "EURUSD";
  return JSON.stringify(
    {
      task:
        `Review one currently active MT5 ${symbol} order or position. Decide whether it should be kept, cancelled/closed, or whether SL/TP should be moved. The local bot may execute your recommended action, so be precise and conservative.`,
      mandatory_rules: [
        "Return one strict JSON object only. Do not use Markdown or add text outside JSON.",
        "All user-facing content MUST be written in Vietnamese.",
        "Only enum values, symbols, and technical abbreviations may remain in English.",
        "Use the live MT5 order state as the source of truth.",
        "If state is PENDING, choose between KEEP_ORDER, CANCEL_ORDER, WAIT, MOVE_SL, MOVE_TP, or MOVE_SL_TP.",
        "If state is FILLED, choose between KEEP_ORDER, CLOSE_MANUALLY, WAIT, MOVE_SL, MOVE_TP, or MOVE_SL_TP.",
        "Recommend CANCEL_ORDER only when a pending order is clearly stale, invalidated, or no longer has a realistic path to entry.",
        "Recommend CLOSE_MANUALLY only when the open position is clearly invalidated, protecting floating profit is materially better than waiting, or current market structure makes the original trade thesis wrong.",
        "Only suggest moving SL if the new stop loss reduces risk or locks profit and is technically valid.",
        "Never suggest widening SL to avoid a loss, martingale, DCA, increasing lot, or revenge trading.",
        "Only suggest moving TP when market structure materially changed. Explain the exact reason.",
        "If evidence is insufficient, select WAIT or KEEP_ORDER and list what should be checked manually.",
      ],
      output_schema: {
        symbol,
        reviewed_history_id: String(input.order.ticket),
        current_price: 0,
        order_status_assessment:
          "LIKELY_NOT_FILLED | LIKELY_FILLED | ALREADY_INVALIDATED | UNCLEAR",
        recommended_action:
          "KEEP_ORDER | CANCEL_ORDER | MOVE_SL | MOVE_TP | MOVE_SL_TP | WAIT | CLOSE_MANUALLY | TRADE_COMPLETED",
        confidence: "number from 0 to 100",
        summary: "Vietnamese summary",
        fill_assessment: "Vietnamese order status assessment",
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
        checklist: ["Vietnamese manual check on Exness/MT5"],
        disclaimer:
          "Đây là gợi ý phân tích từ AI, không phải lời khuyên tài chính. Người dùng tự chịu trách nhiệm với quyết định giao dịch.",
      },
      active_mt5_order: input.order,
      matching_history: input.matchingHistory
        ? {
            id: input.matchingHistory.id,
            created_at: input.matchingHistory.created_at,
            decision: input.matchingHistory.decision,
            direction: input.matchingHistory.direction,
            confidence: input.matchingHistory.confidence,
            entry_from: input.matchingHistory.entry_from,
            entry_to: input.matchingHistory.entry_to,
            stop_loss: input.matchingHistory.stop_loss,
            take_profit: input.matchingHistory.take_profit,
            ai_result: input.matchingHistory.parsed_result,
          }
        : null,
      latest_market_payload: input.latestPayload,
    },
    null,
    2,
  );
}
