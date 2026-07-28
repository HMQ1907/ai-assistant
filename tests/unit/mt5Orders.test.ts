import { describe, expect, it } from "vitest";
import type { ActiveMt5Order } from "../../types/trading";
import { splitActiveMt5Orders } from "../../server/utils/mt5Orders";

function order(state: ActiveMt5Order["state"], ticket: number): ActiveMt5Order {
  return {
    ticket,
    state,
    symbol: "XAUUSDm",
    type: state === "PENDING" ? "BUY_LIMIT" : "MARKET_BUY",
    direction: "BUY",
    volume: 0.02,
    price_open: 4022,
    stop_loss: null,
    take_profit: 4070,
    profit: state === "FILLED" ? -1.5 : null,
    opened_at: "2026-07-28T00:00:00.000Z",
    comment: "",
  };
}

describe("splitActiveMt5Orders", () => {
  it("tách position đang chạy và lệnh chờ", () => {
    const { openPositions, pendingOrders } = splitActiveMt5Orders([
      order("PENDING", 1),
      order("PENDING", 2),
      order("FILLED", 3),
    ]);
    expect(openPositions.map((o) => o.ticket)).toEqual([3]);
    expect(pendingOrders.map((o) => o.ticket)).toEqual([1, 2]);
  });
});
