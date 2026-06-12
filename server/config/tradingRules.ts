export const tradingRules = {
  defaultAccountSizeUsd: 200,
  maxLossPercentPerTrade: 15,
  maxDailyLossPercent: 15,
  minConfidence: 65,
  minRiskReward: 1.5,
  maxHoldingMinutes: 60,
  minLot: 0.01,
  lotStep: 0.01,
} as const;
