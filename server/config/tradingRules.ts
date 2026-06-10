export const tradingRules = {
  defaultAccountSizeUsd: 200,
  maxLossPercentPerTrade: 15,
  maxDailyLossPercent: 15,
  minConfidence: 65,
  minRiskReward: 1.5,
  maxHoldingMinutes: 60,
  maxSpreadPercent: 0.08,
  minLot: 0.01,
  lotStep: 0.01,
  xauUsdOuncesPerLot: 100,
  btcUnitsPerQuantity: 1,
  btcMinQuantity: 0.00001,
  btcQuantityStep: 0.00001,
} as const;

export function instrumentSizing(symbol: "XAUUSD" | "BTCUSD") {
  return symbol === "BTCUSD"
    ? {
        contractSize: tradingRules.btcUnitsPerQuantity,
        minQuantity: tradingRules.btcMinQuantity,
        quantityStep: tradingRules.btcQuantityStep,
        quantityLabel: "BTC",
      }
    : {
        contractSize: tradingRules.xauUsdOuncesPerLot,
        minQuantity: tradingRules.minLot,
        quantityStep: tradingRules.lotStep,
        quantityLabel: "lot",
      };
}
