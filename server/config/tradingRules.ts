export const tradingRules = {
  // Auto-bot micro account ($200): lot tối thiểu 0.01, risk/ngày siết chặt qua ENV.
  defaultAccountSizeUsd: 200,
  maxLossPercentPerTrade: 10,
  maxDailyLossPercent: 5,
  minConfidence: 65,
  minRiskReward: 1.5,
  // Trend-pullback intraday: bias H1, entry M5, đóng trong phiên.
  maxHoldingMinutes: 240,
  maxSpreadPercent: 0.08,
  maxQuoteAgeSeconds: 180,
  maxPendingEntryDistancePercent: 0.3,
  maxPendingEntryAtrMultiplier: 1,
  // SL phai cach entry it nhat bay nhieu lan ATR(H1) — chong "bop SL qua sat de dat RR"
  // khien lenh de bi noise/quet thanh khoan cua vang danh bay.
  // 2026-07: nang 0.8 -> 1.0 vi du lieu outcome thuc te cho thay 5/7 lenh thua
  // la SL bi quet xong gia van chay dung huong toi TP (auto_swept_then_reversed).
  minStopLossAtrMultiple: 1.0,
  // Khung quyet dinh chinh (entry/SL/TP ve theo cau truc khung nay).
  decisionTimeframe: "H1",
  biasTimeframe: "H4",
  minLot: 0.01,
  lotStep: 0.01,
  xauUsdOuncesPerLot: 100,
} as const;
