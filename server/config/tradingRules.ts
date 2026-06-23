export const tradingRules = {
  defaultAccountSizeUsd: 200,
  maxLossPercentPerTrade: 15,
  maxDailyLossPercent: 15,
  minConfidence: 65,
  minRiskReward: 1.5,
  // Intraday-swing: vao theo khung H1, giu vai gio, dong trong phien (khong qua dem).
  maxHoldingMinutes: 240,
  maxSpreadPercent: 0.08,
  maxQuoteAgeSeconds: 180,
  maxPendingEntryDistancePercent: 0.3,
  maxPendingEntryAtrMultiplier: 1,
  // SL phai cach entry it nhat bay nhieu lan ATR(H1) — chong "bop SL qua sat de dat RR"
  // khien lenh de bi noise/quet thanh khoan cua vang danh bay.
  minStopLossAtrMultiple: 0.8,
  // Khung quyet dinh chinh (entry/SL/TP ve theo cau truc khung nay).
  decisionTimeframe: "H1",
  biasTimeframe: "H4",
  minLot: 0.01,
  lotStep: 0.01,
  xauUsdOuncesPerLot: 100,
} as const;
