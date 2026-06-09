export const tradingRules = {
  defaultAccountSizeUsd: 70,
  maxLossPercentPerTrade: 15,
  maxDailyLossPercent: 15,
  minConfidence: 70,
  minRiskReward: 1.5,
  maxHoldingMinutes: 60,
  maxSpreadPercent: 0.08,
  minLot: 0.01,
  lotStep: 0.01,
  xauUsdOuncesPerLot: 100,
} as const;
