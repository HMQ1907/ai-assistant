export function parseRiskReward(value: string): number {
  const match = value.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/)
  if (!match) return 0
  const risk = Number(match[1])
  const reward = Number(match[2])
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0) return 0
  return reward / risk
}

export function maxLoss(accountSizeUsd: number, riskPercent: number): number {
  return Number(((accountSizeUsd * riskPercent) / 100).toFixed(2))
}
