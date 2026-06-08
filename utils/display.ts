import type {
  DataQuality,
  ResultStatus,
  TradeDecision,
  TradeDirection,
} from "~/types/trading";

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
