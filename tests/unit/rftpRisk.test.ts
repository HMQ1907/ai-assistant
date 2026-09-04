import { describe, expect, it } from "vitest";
import { countConsecutiveLossesToday } from "../../server/services/AutoTradeRunner";
import type { ClosedMt5Deal } from "../../server/services/Mt5OrderService";

function deal(time: string, netProfit: number): ClosedMt5Deal {
  return { ticket: 1, position_id: 1, symbol: "XAUUSDm", time, net_profit: netProfit, comment: "auto-m5" };
}

describe("RFTP daily consecutive-loss kill switch", () => {
  it("counts only the latest consecutive losing exits in the configured day", () => {
    const deals = [
      deal("2026-08-13T02:00:00.000Z", 1),
      deal("2026-08-13T03:00:00.000Z", -1),
      deal("2026-08-13T04:00:00.000Z", -1),
      deal("2026-08-13T05:00:00.000Z", -1),
    ];
    expect(countConsecutiveLossesToday(deals, "Asia/Saigon", new Date("2026-08-13T06:00:00.000Z"))).toBe(3);
  });

  it("resets the streak after a non-losing exit", () => {
    const deals = [
      deal("2026-08-13T03:00:00.000Z", -1),
      deal("2026-08-13T04:00:00.000Z", 0.2),
      deal("2026-08-13T05:00:00.000Z", -1),
    ];
    expect(countConsecutiveLossesToday(deals, "Asia/Saigon", new Date("2026-08-13T06:00:00.000Z"))).toBe(1);
  });
});
