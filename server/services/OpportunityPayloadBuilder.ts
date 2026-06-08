import type { AnalysisPayload, IndicatorSnapshot, MarketSnapshot, NewsSnapshot } from '../../types/trading'
import { tradingRules } from '../config/tradingRules'

export class OpportunityPayloadBuilder {
  build(market: MarketSnapshot[], indicators: IndicatorSnapshot[], news: NewsSnapshot): AnalysisPayload {
    return {
      generatedAt: new Date().toISOString(),
      accountSizeUsd: tradingRules.accountSizeUsd,
      symbols: market.map((snapshot) => {
        const indicator = indicators.find((item) => item.symbol === snapshot.symbol)
        if (!indicator) throw new Error(`Missing indicators for ${snapshot.symbol}`)
        return { market: snapshot, indicators: indicator }
      }),
      news,
      rules: [
        'Manual trading assistant only. Do not execute trades.',
        'Return TRADE only when setup is clear and safe; otherwise return NO_TRADE.',
        `If confidence < ${tradingRules.minConfidence}, return NO_TRADE.`,
        `If risk reward < 1:${tradingRules.minRiskReward}, return NO_TRADE.`,
        'If high-impact event is within 30 minutes, prefer NO_TRADE.',
        'If spread is too high or market is sideway/choppy, return NO_TRADE.',
        'Never recommend martingale, loss DCA, all-in, or increasing lot after losing.',
        `Risk per trade must use configured riskPercent ${tradingRules.riskPercent}% and accountSizeUsd ${tradingRules.accountSizeUsd}.`,
        `Expected holding time should not exceed ${tradingRules.maxHoldingMinutes} minutes.`
      ]
    }
  }
}
