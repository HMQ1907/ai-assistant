import type { ActiveMt5Order } from "../../types/trading";

/** Lệnh đã khớp — position đang chạy trên MT5. */
export function isOpenMt5Position(order: ActiveMt5Order): boolean {
  return order.state === "FILLED";
}

/** Lệnh chờ — limit/stop chưa khớp. */
export function isPendingMt5Order(order: ActiveMt5Order): boolean {
  return order.state === "PENDING";
}

export function splitActiveMt5Orders(orders: ActiveMt5Order[]): {
  openPositions: ActiveMt5Order[];
  pendingOrders: ActiveMt5Order[];
} {
  const openPositions: ActiveMt5Order[] = [];
  const pendingOrders: ActiveMt5Order[] = [];
  for (const order of orders) {
    if (isOpenMt5Position(order)) openPositions.push(order);
    else if (isPendingMt5Order(order)) pendingOrders.push(order);
  }
  return { openPositions, pendingOrders };
}
