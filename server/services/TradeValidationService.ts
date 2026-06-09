import type { AiTradeRecommendation } from "../../types/ai";
import type { AnalysisPayload } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { parseRiskReward } from "../utils/risk";

export class TradeValidationService {
  validate(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): AiTradeRecommendation {
    this.normalizeSizing(recommendation, payload);
    const reasons = this.findInvalidReasons(recommendation, payload);

    if (payload) {
      const selectedSymbol = payload.symbols.find(
        (item) => item.market.symbol === "XAUUSD",
      );
      if (selectedSymbol) {
        recommendation.current_price = selectedSymbol.market.price;
      }
    }

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

  private normalizeSizing(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): void {
    if (!payload) return;
    recommendation.position_sizing.account_size_usd = payload.accountSizeUsd;
    recommendation.position_sizing.max_loss_usd = payload.maxLossUsdPerTrade;
    recommendation.position_sizing.max_loss_percent =
      payload.maxLossPercentPerTrade;

    if (recommendation.decision !== "TRADE") {
      recommendation.position_sizing.suggested_lot = 0;
      recommendation.position_sizing.estimated_loss_if_sl_hit = 0;
      return;
    }

    const entry = this.averageEntry(recommendation);
    if (!isFinitePositive(entry) || !isFinitePositive(recommendation.stop_loss)) {
      recommendation.position_sizing.suggested_lot = 0;
      recommendation.position_sizing.estimated_loss_if_sl_hit = 0;
      return;
    }

    const distance = Math.abs(entry - recommendation.stop_loss);
    if (distance <= 0) {
      recommendation.position_sizing.suggested_lot = 0;
      recommendation.position_sizing.estimated_loss_if_sl_hit = 0;
      return;
    }

    const maxLossUsd = payload.maxLossUsdPerTrade;
    const riskMultiplier = confidenceRiskMultiplier(recommendation.confidence);
    const targetLossUsd = maxLossUsd * riskMultiplier;
    const rawLot =
      targetLossUsd / (distance * tradingRules.xauUsdOuncesPerLot);
    const lot = floorToStep(rawLot, tradingRules.lotStep);
    const suggestedLot = lot >= tradingRules.minLot ? lot : 0;
    const estimatedLoss = Number(
      (
        suggestedLot *
        distance *
        tradingRules.xauUsdOuncesPerLot
      ).toFixed(2),
    );

    recommendation.position_sizing.suggested_lot = suggestedLot;
    recommendation.position_sizing.estimated_loss_if_sl_hit = estimatedLoss;
    recommendation.position_sizing.position_sizing_explanation =
      suggestedLot > 0
        ? `Lot gợi ý: ${suggestedLot.toFixed(2)} lot. Công thức XAUUSD: lot * khoảng cách Entry-SL (${distance.toFixed(2)} USD) * 100 oz = khoảng $${estimatedLoss} nếu chạm SL. Giới hạn lỗ hiện tại là ${payload.maxLossPercentPerTrade}% vốn ($${maxLossUsd}).`
        : `Không gợi ý lot vì với khoảng cách Entry-SL ${distance.toFixed(2)} USD, lot tối thiểu ${tradingRules.minLot.toFixed(2)} có thể không phù hợp với giới hạn lỗ hoặc setup chưa đủ điều kiện.`;
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
    const maxLossUsd =
      payload?.maxLossUsdPerTrade ?? recommendation.position_sizing.max_loss_usd;

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

    if (recommendation.position_sizing.estimated_loss_if_sl_hit > maxLossUsd) {
      reasons.push(
        `estimated_loss_if_sl_hit ${recommendation.position_sizing.estimated_loss_if_sl_hit} USD vượt giới hạn ${maxLossUsd} USD`,
      );
    }

    if (
      recommendation.decision === "TRADE" &&
      recommendation.position_sizing.suggested_lot < tradingRules.minLot
    ) {
      reasons.push(
        `TRADE nhưng suggested_lot thấp hơn lot tối thiểu ${tradingRules.minLot.toFixed(2)}`,
      );
    }

    if (isFinitePositive(entry) && isFinitePositive(recommendation.stop_loss)) {
      const distance = Math.abs(entry - recommendation.stop_loss);
      const minLotLoss =
        tradingRules.minLot * distance * tradingRules.xauUsdOuncesPerLot;
      if (recommendation.decision === "TRADE" && minLotLoss > maxLossUsd) {
        reasons.push(
          `Khoảng cách SL (${distance.toFixed(2)} USD) quá xa. Với lot tối thiểu ${tradingRules.minLot.toFixed(2)}, mức lỗ dự kiến là $${minLotLoss.toFixed(2)}, vượt giới hạn $${maxLossUsd}.`,
        );
      }
    } else {
      reasons.push(
        "Giá trị entry hoặc stop_loss không hợp lệ để tính toán volume",
      );
    }

    if (payload) {
      if (recommendation.position_sizing.account_size_usd !== payload.accountSizeUsd) {
        reasons.push(
          `account_size_usd ${recommendation.position_sizing.account_size_usd} khác vốn hiện tại ${payload.accountSizeUsd}`,
        );
      }
      if (recommendation.position_sizing.max_loss_usd !== payload.maxLossUsdPerTrade) {
        reasons.push(
          `max_loss_usd ${recommendation.position_sizing.max_loss_usd} khác giới hạn ${payload.maxLossUsdPerTrade}`,
        );
      }
      if (
        recommendation.position_sizing.max_loss_percent !==
        payload.maxLossPercentPerTrade
      ) {
        reasons.push(
          `max_loss_percent ${recommendation.position_sizing.max_loss_percent} khác giới hạn ${payload.maxLossPercentPerTrade}`,
        );
      }
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
      if (recommendation.stop_loss >= entry) {
        reasons.push("BUY có stop_loss lớn hơn hoặc bằng entry");
      }
      if (recommendation.take_profit <= entry) {
        reasons.push("BUY có take_profit nhỏ hơn hoặc bằng entry");
      }
    }

    if (recommendation.direction === "SELL") {
      if (recommendation.stop_loss <= entry) {
        reasons.push("SELL có stop_loss nhỏ hơn hoặc bằng entry");
      }
      if (recommendation.take_profit >= entry) {
        reasons.push("SELL có take_profit lớn hơn hoặc bằng entry");
      }
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

function confidenceRiskMultiplier(confidence: number): number {
  if (confidence >= 90) return 1;
  if (confidence >= 80) return 0.75;
  return 0.5;
}

function floorToStep(value: number, step: number): number {
  return Number((Math.floor(value / step) * step).toFixed(2));
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
