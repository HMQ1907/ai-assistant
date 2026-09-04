import { describe, expect, it } from "vitest";
import type { AiTradeRecommendation } from "../../types/ai";
import { formatTelegramMarketAlert } from "../../server/services/TradeScannerService";

describe("Telegram market alert", () => {
  it("uses BUY NOW and includes executable entry, SL, TP and RR", () => {
    const recommendation = {
      direction: "BUY",
      entry_zone: { from: 3_350.2, to: 3_350.2 },
      current_price: 3_350.2,
      stop_loss: 3_345.2,
      take_profit: 3_360.2,
      risk_reward: "1:2.00",
      trade_reason: "M15 trend and M5 pullback confirmed",
      summary: "BUY",
      invalid_conditions: [],
      risk_factors: [],
    } as unknown as AiTradeRecommendation;

    const message = formatTelegramMarketAlert(recommendation, "signal-1");
    expect(message).toContain("XAUUSD — BUY NOW");
    expect(message).toContain("Entry market: 3350.2");
    expect(message).toContain("SL: 3345.2");
    expect(message).toContain("TP: 3360.2");
    expect(message).toContain("RR: 1:2.00");
    expect(message).toContain("Ước tính 0.01 lot: SL -$5.00 / TP +$10.00");
    expect(message).toContain("quá 1 nến M5");
  });
});
