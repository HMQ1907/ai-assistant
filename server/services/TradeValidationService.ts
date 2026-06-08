import type { AiTradeRecommendation } from '../../types/ai'
import { tradingRules } from '../config/tradingRules'
import { parseRiskReward } from '../utils/risk'

export class TradeValidationService {
  validate(recommendation: AiTradeRecommendation): AiTradeRecommendation {
    const reasons = this.findInvalidReasons(recommendation)
    if (reasons.length === 0) return recommendation

    const invalidConditions = Array.from(new Set([...recommendation.invalid_conditions, ...reasons]))
    const reason = `Local validation forced NO_TRADE: ${reasons.join('; ')}.`

    return {
      ...recommendation,
      decision: 'NO_TRADE',
      direction: 'NONE',
      invalid_conditions: invalidConditions,
      no_trade_reason: recommendation.no_trade_reason ? `${recommendation.no_trade_reason} ${reason}` : reason
    }
  }

  private findInvalidReasons(recommendation: AiTradeRecommendation): string[] {
    const reasons: string[] = []
    const entry = this.averageEntry(recommendation)
    const riskReward = parseRiskReward(recommendation.risk_reward)

    if (recommendation.confidence < tradingRules.minConfidence) {
      reasons.push(`confidence ${recommendation.confidence} is below ${tradingRules.minConfidence}`)
    }

    if (riskReward < tradingRules.minRiskReward) {
      reasons.push(`risk_reward ${recommendation.risk_reward} is below 1:${tradingRules.minRiskReward}`)
    }

    if (recommendation.decision === 'TRADE' && recommendation.direction === 'NONE') {
      reasons.push('decision is TRADE but direction is NONE')
    }

    if (recommendation.entry_zone.from === 0 || recommendation.entry_zone.to === 0 || entry === 0) {
      reasons.push('entry is 0')
    }

    if (recommendation.stop_loss === 0) reasons.push('stop_loss is 0')
    if (recommendation.take_profit === 0) reasons.push('take_profit is 0')

    if (recommendation.direction === 'BUY') {
      if (recommendation.stop_loss >= entry) reasons.push('BUY stop_loss is greater than or equal to entry')
      if (recommendation.take_profit <= entry) reasons.push('BUY take_profit is less than or equal to entry')
    }

    if (recommendation.direction === 'SELL') {
      if (recommendation.stop_loss <= entry) reasons.push('SELL stop_loss is less than or equal to entry')
      if (recommendation.take_profit >= entry) reasons.push('SELL take_profit is greater than or equal to entry')
    }

    return reasons
  }

  private averageEntry(recommendation: AiTradeRecommendation): number {
    return Number(((recommendation.entry_zone.from + recommendation.entry_zone.to) / 2).toFixed(6))
  }
}
