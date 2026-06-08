import type { AiTradeRecommendation } from "../../types/ai";
import type { AnalysisPayload } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { parseRiskReward } from "../utils/risk";

export class TradeValidationService {
  validate(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): AiTradeRecommendation {
    const reasons = this.findInvalidReasons(recommendation, payload);
    if (reasons.length === 0) return recommendation;

    const invalidConditions = Array.from(
      new Set([...recommendation.invalid_conditions, ...reasons]),
    );
    const reason = `Validation nội bộ đã ép NO_TRADE: ${reasons.join("; ")}.`;

    return {
      ...recommendation,
      decision: "NO_TRADE",
      direction: "NONE",
      invalid_conditions: invalidConditions,
      no_trade_reason: recommendation.no_trade_reason
        ? `${recommendation.no_trade_reason} ${reason}`
        : reason,
    };
  }

  private findInvalidReasons(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): string[] {
    const reasons: string[] = [];
    const entry = this.averageEntry(recommendation);
    const riskReward = parseRiskReward(recommendation.risk_reward);
    const selectedSymbol = payload?.symbols.find(
      (item) => item.market.symbol === recommendation.symbol,
    );

    if (recommendation.confidence < tradingRules.minConfidence) {
      reasons.push(
        `confidence ${recommendation.confidence} thấp hơn ngưỡng ${tradingRules.minConfidence}`,
      );
    }

    if (riskReward < tradingRules.minRiskReward) {
      reasons.push(
        `risk_reward ${recommendation.risk_reward} thấp hơn 1:${tradingRules.minRiskReward}`,
      );
    }

    if (payload?.dataQuality === "LOW") {
      reasons.push("data_quality tổng thể là LOW");
    }

    if (
      payload?.newsDataStatus === "UNAVAILABLE" &&
      recommendation.decision === "TRADE"
    ) {
      reasons.push("news_data_status là UNAVAILABLE");
    }

    if (payload && !selectedSymbol && recommendation.decision === "TRADE") {
      reasons.push("symbol được chọn không có dữ liệu realtime hợp lệ");
    }

    if (selectedSymbol?.market.data_quality === "LOW") {
      reasons.push(`${recommendation.symbol} có data_quality LOW`);
    }

    if (selectedSymbol && selectedSymbol.market.spread > 0) {
      const spreadPercent =
        (selectedSymbol.market.spread /
          Math.max(selectedSymbol.market.price, 0.00001)) *
        100;
      if (spreadPercent > tradingRules.maxSpreadPercent) {
        reasons.push(
          `${recommendation.symbol} có spread ${spreadPercent.toFixed(4)}% cao hơn ngưỡng ${tradingRules.maxSpreadPercent}%`,
        );
      }
    }

    if (selectedSymbol && selectedSymbol.market.price <= 0) {
      reasons.push(`${recommendation.symbol} không có giá realtime hợp lệ`);
    }

    if (
      recommendation.decision === "TRADE" &&
      recommendation.direction === "NONE"
    ) {
      reasons.push("decision là TRADE nhưng direction là NONE");
    }

    if (
      recommendation.entry_zone.from === 0 ||
      recommendation.entry_zone.to === 0 ||
      entry === 0
    ) {
      reasons.push("entry bằng 0");
    }

    if (recommendation.stop_loss === 0) reasons.push("stop_loss bằng 0");
    if (recommendation.take_profit === 0) reasons.push("take_profit bằng 0");

    if (recommendation.direction === "BUY") {
      if (recommendation.stop_loss >= entry)
        reasons.push("BUY có stop_loss lớn hơn hoặc bằng entry");
      if (recommendation.take_profit <= entry)
        reasons.push("BUY có take_profit nhỏ hơn hoặc bằng entry");
    }

    if (recommendation.direction === "SELL") {
      if (recommendation.stop_loss <= entry)
        reasons.push("SELL có stop_loss nhỏ hơn hoặc bằng entry");
      if (recommendation.take_profit >= entry)
        reasons.push("SELL có take_profit lớn hơn hoặc bằng entry");
    }

    return reasons;
  }

  private averageEntry(recommendation: AiTradeRecommendation): number {
    return Number(
      (
        (recommendation.entry_zone.from + recommendation.entry_zone.to) /
        2
      ).toFixed(6),
    );
  }
}
