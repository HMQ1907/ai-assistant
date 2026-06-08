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
      (item) => item.market.symbol === "XAUUSD",
    );

    if (recommendation.symbol !== "XAUUSD") {
      reasons.push("AI trả symbol khác XAUUSD");
    }

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

    if (isFinitePositive(entry) && isFinitePositive(recommendation.stop_loss)) {
      const distance = Math.abs(entry - recommendation.stop_loss);
      if (distance > 0) {
        // 1 lot XAUUSD = 100 ounces
        const minLotLoss = 0.01 * distance * 100;
        if (minLotLoss > tradingRules.maxLossUsdPerTrade) {
          reasons.push(
            `Khoảng cách SL (${distance.toFixed(2)} USD) quá xa. Kể cả với volume nhỏ nhất (0.01 lot), mức lỗ dự kiến sẽ là $${minLotLoss.toFixed(2)} USD, vượt quá giới hạn $${tradingRules.maxLossUsdPerTrade} USD.`
          );
        } else {
          const calculatedLot = tradingRules.maxLossUsdPerTrade / (distance * 100);
          let lotSize = Number(calculatedLot.toFixed(2));
          let realLoss = Number((lotSize * distance * 100).toFixed(2));
          if (realLoss > tradingRules.maxLossUsdPerTrade) {
            lotSize = Number((Math.floor(calculatedLot * 100) / 100).toFixed(2));
            realLoss = Number((lotSize * distance * 100).toFixed(2));
          }

          // Ghi đè thông tin chính xác toán học
          recommendation.position_sizing.estimated_loss_if_sl_hit = realLoss;
          recommendation.position_sizing.position_sizing_explanation = 
            `Volume khuyến nghị: ${lotSize} lot (1 lot = 100 oz). Mức lỗ thực tế khi chạm SL (${recommendation.stop_loss}) tại Entry TB (${entry.toFixed(2)}) là $${realLoss} USD (tối đa cho phép: $${tradingRules.maxLossUsdPerTrade} USD).`;
        }
      }
    } else {
      reasons.push("Giá trị entry hoặc stop_loss không hợp lệ để tính toán volume");
    }
    if (
      recommendation.position_sizing.account_size_usd !==
      tradingRules.accountSizeUsd
    ) {
      reasons.push(
        `account_size_usd ${recommendation.position_sizing.account_size_usd} khác cấu hình ${tradingRules.accountSizeUsd}`,
      );
    }
    if (
      recommendation.position_sizing.max_loss_usd !==
      tradingRules.maxLossUsdPerTrade
    ) {
      reasons.push(
        `max_loss_usd ${recommendation.position_sizing.max_loss_usd} khác cấu hình ${tradingRules.maxLossUsdPerTrade}`,
      );
    }

    if (payload?.dataQuality === "LOW") {
      reasons.push("data_quality tổng thể là LOW");
    }

    if (payload && !selectedSymbol) {
      reasons.push("không có dữ liệu realtime hợp lệ cho XAUUSD");
    }

    if (selectedSymbol?.market.data_quality === "LOW") {
      reasons.push("XAUUSD có data_quality LOW");
    }

    if (selectedSymbol && selectedSymbol.market.spread > 0) {
      const spreadPercent =
        (selectedSymbol.market.spread /
          Math.max(selectedSymbol.market.price, 0.00001)) *
        100;
      if (spreadPercent > tradingRules.maxSpreadPercent) {
        reasons.push(
          `XAUUSD có spread ${spreadPercent.toFixed(4)}% cao hơn ngưỡng ${tradingRules.maxSpreadPercent}%`,
        );
      }
    }

    if (selectedSymbol && selectedSymbol.market.price <= 0) {
      reasons.push("XAUUSD không có giá realtime hợp lệ");
    }

    if (
      recommendation.decision === "TRADE" &&
      recommendation.direction === "NONE"
    ) {
      reasons.push("decision là TRADE nhưng direction là NONE");
    }

    if (!isFinitePositive(recommendation.entry_zone.from)) {
      reasons.push("entry_zone.from không hợp lệ");
    }
    if (!isFinitePositive(recommendation.entry_zone.to)) {
      reasons.push("entry_zone.to không hợp lệ");
    }
    if (!isFinitePositive(entry)) {
      reasons.push("entry trung bình không hợp lệ");
    }
    if (recommendation.entry_zone.from > recommendation.entry_zone.to) {
      reasons.push("entry_zone.from lớn hơn entry_zone.to");
    }
    if (!isFinitePositive(recommendation.stop_loss)) {
      reasons.push("stop_loss không hợp lệ");
    }
    if (!isFinitePositive(recommendation.take_profit)) {
      reasons.push("take_profit không hợp lệ");
    }

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

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
