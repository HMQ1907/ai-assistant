import type {
  DataQuality,
  ResultStatus,
  TradeDecision,
  TradeDirection,
} from "~/types/trading";

// Số chữ số thập phân hiển thị theo từng symbol.
// Vàng (XAUUSD) yết 2 số; cặp forex như EURUSD yết 5 số (pip thứ 4 + point thứ 5).
export function priceDecimals(symbol?: string | null): number {
  if (!symbol) return 2;
  const upper = symbol.toUpperCase();
  if (upper.includes("XAU") || upper.includes("XAG")) return 2;
  if (upper.includes("JPY")) return 3;
  if (upper.includes("BTC") || upper.includes("ETH")) return 2;
  // Mặc định cho cặp forex chính (EURUSD, GBPUSD...): 5 chữ số.
  return 5;
}

export function formatPrice(
  value: number | null | undefined,
  symbol?: string | null,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "Không rõ";
  }
  return value.toFixed(priceDecimals(symbol));
}

export function decisionLabel(value: TradeDecision): string {
  return value === "TRADE" ? "CÓ THỂ GIAO DỊCH" : "KHÔNG NÊN GIAO DỊCH";
}

export function directionLabel(value: TradeDirection): string {
  if (value === "BUY") return "MUA";
  if (value === "SELL") return "BÁN";
  return "KHÔNG CÓ";
}

export function statusLabel(value: ResultStatus): string {
  const labels: Record<ResultStatus, string> = {
    PENDING: "CHƯA CẬP NHẬT",
    WIN: "THẮNG",
    LOSS: "THUA",
    BREAKEVEN: "HÒA VỐN",
    SKIPPED: "BỎ QUA",
  };
  return labels[value];
}

export function dataQualityLabel(value: DataQuality): string {
  if (value === "HIGH") return "TỐT";
  if (value === "MEDIUM") return "TRUNG BÌNH";
  return "THẤP";
}
