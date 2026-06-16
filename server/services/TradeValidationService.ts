import type { AiTradeRecommendation, RiskyTradeScenario } from "../../types/ai";
import type { AnalysisPayload } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { parseRiskReward } from "../utils/risk";

export class TradeValidationService {
  validate(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): AiTradeRecommendation {
    this.normalizeSizing(recommendation, payload);
    if (recommendation.decision === "NO_TRADE") {
      return this.normalizeNoTrade(recommendation, payload);
    }
    this.applyQuoteQualityAdjustment(recommendation, payload);
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
      new Set(recommendation.invalid_conditions),
    );
    const reason = `Validation nội bộ đã ép NO_TRADE: ${reasons.join("; ")}.`;

    const riskyTrade =
      recommendation.risky_trade ??
      buildRiskyTradeFromRejectedRecommendation(recommendation, payload);

    return {
      ...recommendation,
      decision: "NO_TRADE",
      direction: "NONE",
      order_type: "MARKET",
      entry_zone: null,
      stop_loss: null,
      take_profit: null,
      risk_reward: null,
      expected_holding_time: null,
      position_sizing: {
        ...recommendation.position_sizing,
        suggested_lot: null,
        estimated_loss_if_sl_hit: null,
      },
      trade_validation_failures: Array.from(new Set(reasons)),
      invalid_conditions: invalidConditions,
      no_trade_reason: recommendation.no_trade_reason
        ? `${recommendation.no_trade_reason} ${reason}`
        : reason,
      risky_trade: riskyTrade,
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
      recommendation.position_sizing.suggested_lot = null;
      recommendation.position_sizing.estimated_loss_if_sl_hit = null;
      return;
    }

    const entry = this.averageEntry(recommendation);
    const stopLoss = recommendation.stop_loss;
    if (!isFinitePositive(entry) || !isFinitePositive(stopLoss)) {
      recommendation.position_sizing.suggested_lot = null;
      recommendation.position_sizing.estimated_loss_if_sl_hit = null;
      return;
    }

    const distance = Math.abs(entry - stopLoss);
    if (distance <= 0) {
      recommendation.position_sizing.suggested_lot = null;
      recommendation.position_sizing.estimated_loss_if_sl_hit = null;
      return;
    }

    const maxLossUsd = payload.maxLossUsdPerTrade;
    const riskMultiplier = confidenceRiskMultiplier(recommendation.confidence);
    const targetLossUsd = maxLossUsd * riskMultiplier;
    const rawLot =
      targetLossUsd / (distance * tradingRules.xauUsdOuncesPerLot);
    const lot = floorToStep(rawLot, tradingRules.lotStep);
    const minLotLoss =
      tradingRules.minLot * distance * tradingRules.xauUsdOuncesPerLot;
    const suggestedLot =
      lot >= tradingRules.minLot
        ? lot
        : minLotLoss <= maxLossUsd
          ? tradingRules.minLot
          : null;
    const estimatedLoss =
      suggestedLot === null
        ? null
        : Number(
            (
              suggestedLot *
              distance *
              tradingRules.xauUsdOuncesPerLot
            ).toFixed(2),
          );

    recommendation.position_sizing.suggested_lot = suggestedLot;
    recommendation.position_sizing.estimated_loss_if_sl_hit = estimatedLoss;
    recommendation.position_sizing.position_sizing_explanation =
      suggestedLot !== null && suggestedLot > 0
        ? `Lot gợi ý: ${suggestedLot.toFixed(2)} lot. Công thức XAUUSD: lot * khoảng cách Entry-SL (${distance.toFixed(2)} USD) * 100 oz = khoảng $${estimatedLoss} nếu chạm SL. Giới hạn lỗ hiện tại là ${payload.maxLossPercentPerTrade}% vốn ($${maxLossUsd}).`
        : `Không gợi ý lot vì với khoảng cách Entry-SL ${distance.toFixed(2)} USD, lot tối thiểu ${tradingRules.minLot.toFixed(2)} có thể không phù hợp với giới hạn lỗ hoặc setup chưa đủ điều kiện.`;
  }

  private normalizeNoTrade(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): AiTradeRecommendation {
    if (payload) {
      recommendation.current_price =
        payload.symbols.find((item) => item.market.symbol === "XAUUSD")?.market
          .price ?? recommendation.current_price;
    }
    return {
      ...recommendation,
      decision: "NO_TRADE",
      direction: "NONE",
      order_type: "MARKET",
      entry_zone: null,
      stop_loss: null,
      take_profit: null,
      risk_reward: null,
      expected_holding_time: null,
      invalid_conditions: Array.from(new Set(recommendation.invalid_conditions)),
      no_trade_reasons:
        recommendation.no_trade_reasons?.length
          ? recommendation.no_trade_reasons
          : recommendation.no_trade_reason
            ? [recommendation.no_trade_reason]
            : ["Không có setup giao dịch hợp lệ."],
      conditions_to_recheck:
        recommendation.conditions_to_recheck?.length
          ? recommendation.conditions_to_recheck
          : ["Phân tích lại khi dữ liệu thị trường, quote và indicator đã đạt yêu cầu."],
      trade_validation_failures: sanitizeAiValidationFailures(
        recommendation.trade_validation_failures ?? [],
      ),
    };
  }

  private findInvalidReasons(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): string[] {
    const reasons: string[] = [];
    const entry = this.averageEntry(recommendation);
    const riskReward = parseRiskReward(recommendation.risk_reward ?? "");
    const selectedSymbol = payload?.symbols.find(
      (item) => item.market.symbol === "XAUUSD",
    );
    if (recommendation.symbol !== "XAUUSD") {
      reasons.push("AI trả symbol khác XAUUSD");
    }

    if (riskReward < tradingRules.minRiskReward) {
      reasons.push(
        `risk_reward ${recommendation.risk_reward} thấp hơn 1:${tradingRules.minRiskReward}`,
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

    if (selectedSymbol && selectedSymbol.market.spread !== null) {
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
      selectedSymbol &&
      recommendation.direction === "SELL" &&
      hasStrongRegimeShift(selectedSymbol, "BULLISH")
    ) {
      reasons.push(
        "SELL bị chặn vì nến đã đóng cho thấy động lượng tăng mạnh và phá cấu trúc ngắn hạn",
      );
    }

    if (
      selectedSymbol &&
      recommendation.direction === "BUY" &&
      hasStrongRegimeShift(selectedSymbol, "BEARISH")
    ) {
      reasons.push(
        "BUY bị chặn vì nến đã đóng cho thấy động lượng giảm mạnh và phá cấu trúc ngắn hạn",
      );
    }

    if (
      recommendation.decision === "TRADE" &&
      recommendation.direction === "NONE"
    ) {
      reasons.push("decision là TRADE nhưng direction là NONE");
    }

    if (!recommendation.entry_zone) {
      reasons.push("entry_zone không hợp lệ");
    } else if (!isFinitePositive(recommendation.entry_zone.from)) {
      reasons.push("entry_zone.from không hợp lệ");
    }
    if (recommendation.entry_zone && !isFinitePositive(recommendation.entry_zone.to)) {
      reasons.push("entry_zone.to không hợp lệ");
    }
    if (!isFinitePositive(entry)) {
      reasons.push("entry trung bình không hợp lệ");
    }
    if (
      recommendation.entry_zone &&
      recommendation.entry_zone.from > recommendation.entry_zone.to
    ) {
      reasons.push("entry_zone.from lớn hơn entry_zone.to");
    }
    if (!isFinitePositive(recommendation.stop_loss)) {
      reasons.push("stop_loss không hợp lệ");
    }
    if (!isFinitePositive(recommendation.take_profit)) {
      reasons.push("take_profit không hợp lệ");
    }

    if (recommendation.direction === "BUY") {
      if (
        recommendation.stop_loss !== null &&
        recommendation.stop_loss >= entry
      ) {
        reasons.push("BUY có stop_loss lớn hơn hoặc bằng entry");
      }
      if (
        recommendation.take_profit !== null &&
        recommendation.take_profit <= entry
      ) {
        reasons.push("BUY có take_profit nhỏ hơn hoặc bằng entry");
      }
    }

    if (recommendation.direction === "SELL") {
      if (
        recommendation.stop_loss !== null &&
        recommendation.stop_loss <= entry
      ) {
        reasons.push("SELL có stop_loss nhỏ hơn hoặc bằng entry");
      }
      if (
        recommendation.take_profit !== null &&
        recommendation.take_profit >= entry
      ) {
        reasons.push("SELL có take_profit lớn hơn hoặc bằng entry");
      }
    }

    reasons.push(...this.orderTypeReasons(recommendation, selectedSymbol, entry));

    return reasons;
  }

  private orderTypeReasons(
    recommendation: AiTradeRecommendation,
    selectedSymbol: PayloadSymbol | undefined,
    entry: number,
  ): string[] {
    if (recommendation.decision !== "TRADE") return [];

    const reasons: string[] = [];
    const { order_type: orderType, direction } = recommendation;

    const expectedDirection: Record<
      Exclude<typeof orderType, "MARKET">,
      "BUY" | "SELL"
    > = {
      BUY_LIMIT: "BUY",
      BUY_STOP: "BUY",
      SELL_LIMIT: "SELL",
      SELL_STOP: "SELL",
    };

    if (orderType !== "MARKET" && expectedDirection[orderType] !== direction) {
      reasons.push(
        `order_type ${orderType} không khớp direction ${direction}`,
      );
    }

    const currentPrice = selectedSymbol?.market.price;
    if (!isFinitePositive(currentPrice) || !isFinitePositive(entry)) {
      return reasons;
    }

    // Dung sai nhỏ để entry sát giá hiện tại không bị bắt lỗi nhầm vị trí.
    const tolerance = Math.max(currentPrice * 0.0002, 0.05);

    if (orderType === "BUY_LIMIT" && entry > currentPrice + tolerance) {
      reasons.push("BUY_LIMIT nhưng entry_zone nằm trên giá hiện tại");
    }
    if (orderType === "SELL_LIMIT" && entry < currentPrice - tolerance) {
      reasons.push("SELL_LIMIT nhưng entry_zone nằm dưới giá hiện tại");
    }
    if (orderType === "BUY_STOP" && entry < currentPrice - tolerance) {
      reasons.push("BUY_STOP nhưng entry_zone nằm dưới giá hiện tại");
    }
    if (orderType === "SELL_STOP" && entry > currentPrice + tolerance) {
      reasons.push("SELL_STOP nhưng entry_zone nằm trên giá hiện tại");
    }

    return reasons;
  }

  private averageEntry(recommendation: AiTradeRecommendation): number {
    if (!recommendation.entry_zone) return 0;
    return Number(
      (
        (recommendation.entry_zone.from + recommendation.entry_zone.to) /
        2
      ).toFixed(6),
    );
  }

  private applyQuoteQualityAdjustment(
    recommendation: AiTradeRecommendation,
    payload?: AnalysisPayload,
  ): void {
    const selectedSymbol = payload?.symbols.find(
      (item) => item.market.symbol === "XAUUSD",
    );
    if (
      !selectedSymbol ||
      selectedSymbol.market.bidAskStatus === "AVAILABLE" ||
      !canAnalyzeWithoutBidAsk(selectedSymbol)
    ) {
      return;
    }

    const warning =
      "Lưu ý: provider không trả bid/ask/spread thật; phân tích vẫn dựa trên giá hiện tại và dữ liệu nến sạch. Hãy kiểm tra spread trên sàn trước khi tự vào lệnh.";
    recommendation.market_context = appendSentence(
      recommendation.market_context,
      warning,
    );
    recommendation.risk_factors = Array.from(
      new Set([
        ...recommendation.risk_factors,
        "Quote quality: thiếu bid/ask/spread thật từ provider, cần kiểm tra spread trên sàn trước khi tự vào lệnh.",
      ]),
    );
  }
}

function hasStrongRegimeShift(
  symbol: PayloadSymbol,
  direction: "BULLISH" | "BEARISH",
): boolean {
  const timeframes = symbol.indicators.timeframes;
  const market = symbol.market.recent_candles;
  const h1Break = breaksRecentStructure(market.H1, direction, 6);
  const m15Break = breaksRecentStructure(market.M15, direction, 8);
  const h1Impulse = hasDirectionalImpulse(market.H1, direction);
  const m15Impulse = hasDirectionalImpulse(market.M15, direction);

  const m5Momentum = timeframes.M5.momentumScore;
  const m15Momentum = timeframes.M15.momentumScore;

  if (direction === "BULLISH") {
    const momentumExpanding =
      m5Momentum !== null &&
      m15Momentum !== null &&
      m5Momentum >= 65 &&
      m15Momentum >= 60;
    return (
      (h1Break && h1Impulse) ||
      (m15Break && m15Impulse && momentumExpanding)
    );
  }

  const momentumExpanding =
    m5Momentum !== null &&
    m15Momentum !== null &&
    m5Momentum <= 35 &&
    m15Momentum <= 40;
  return (
    (h1Break && h1Impulse) ||
    (m15Break && m15Impulse && momentumExpanding)
  );
}

function breaksRecentStructure(
  candles: PayloadSymbol["market"]["recent_candles"]["H1"],
  direction: "BULLISH" | "BEARISH",
  lookback: number,
): boolean {
  const latest = candles.at(-1);
  const previous = candles.slice(-(lookback + 1), -1);
  if (!latest || previous.length < Math.min(3, lookback)) return false;

  if (direction === "BULLISH") {
    return latest.close > Math.max(...previous.map((candle) => candle.high));
  }
  return latest.close < Math.min(...previous.map((candle) => candle.low));
}

function hasDirectionalImpulse(
  candles: PayloadSymbol["market"]["recent_candles"]["H1"],
  direction: "BULLISH" | "BEARISH",
): boolean {
  const latest = candles.at(-1);
  if (!latest) return false;
  const range = latest.high - latest.low;
  if (range <= 0) return false;

  const bodyRatio = Math.abs(latest.close - latest.open) / range;
  const directional =
    direction === "BULLISH"
      ? latest.close > latest.open
      : latest.close < latest.open;
  return directional && bodyRatio >= 0.55;
}

function confidenceRiskMultiplier(confidence: number): number {
  if (confidence >= 90) return 1;
  if (confidence >= 80) return 0.75;
  return 0.5;
}

function floorToStep(value: number, step: number): number {
  return Number((Math.floor(value / step) * step).toFixed(2));
}

function isFinitePositive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

type PayloadSymbol = AnalysisPayload["symbols"][number];

function canAnalyzeWithoutBidAsk(symbol: PayloadSymbol): boolean {
  if (symbol.market.bidAskStatus === "AVAILABLE") return false;
  if (symbol.market.data_quality === "LOW") return false;
  if (symbol.market.price <= 0) return false;

  return Object.values(symbol.market.timeframe_quality).every(
    (item) =>
      item.quality !== "LOW" &&
      item.validCandleCount >= item.requiredCandleCount &&
      Object.values(item.indicatorReadiness).every(Boolean),
  );
}

function appendSentence(text: string, sentence: string): string {
  return text.includes(sentence) ? text : `${text} ${sentence}`.trim();
}

function buildRiskyTradeFromRejectedRecommendation(
  recommendation: AiTradeRecommendation,
  payload?: AnalysisPayload,
): RiskyTradeScenario | null {
  if (
    recommendation.decision !== "TRADE" ||
    recommendation.direction === "NONE" ||
    !recommendation.entry_zone ||
    !isFinitePositive(recommendation.entry_zone.from) ||
    !isFinitePositive(recommendation.entry_zone.to) ||
    !isFinitePositive(recommendation.stop_loss) ||
    !isFinitePositive(recommendation.take_profit)
  ) {
    return null;
  }

  const entry = Number(
    (
      (recommendation.entry_zone.from + recommendation.entry_zone.to) /
      2
    ).toFixed(6),
  );
  const currentPrice =
    payload?.symbols.find((item) => item.market.symbol === "XAUUSD")?.market
      .price ?? recommendation.current_price;
  const distance = Math.abs(entry - recommendation.stop_loss);
  const minLotLoss = Number(
    (
      tradingRules.minLot *
      distance *
      tradingRules.xauUsdOuncesPerLot
    ).toFixed(2),
  );
  const maxLossUsd =
    payload?.maxLossUsdPerTrade ?? recommendation.position_sizing.max_loss_usd;
  const suggestedLot =
    minLotLoss <= maxLossUsd
      ? tradingRules.minLot
      : recommendation.position_sizing.suggested_lot;

  return {
    enabled: true,
    title: "Trade mạo hiểm",
    direction: recommendation.direction,
    order_type: inferOrderType(recommendation.direction, entry, currentPrice),
    estimated_win_probability: Math.max(
      0,
      Math.min(100, recommendation.confidence),
    ),
    entry_zone: recommendation.entry_zone,
    stop_loss: recommendation.stop_loss,
    take_profit: recommendation.take_profit,
    risk_reward: recommendation.risk_reward ?? "Không rõ",
    suggested_lot: suggestedLot,
    estimated_loss_if_sl_hit:
      suggestedLot === null
        ? recommendation.position_sizing.estimated_loss_if_sl_hit
        : Number(
            (
              suggestedLot *
              distance *
              tradingRules.xauUsdOuncesPerLot
            ).toFixed(2),
          ),
    reason:
      "Setup này bị validation chính ép NO_TRADE, nhưng vẫn được giữ lại như kịch bản mạo hiểm có điều kiện để người dùng tự cân nhắc thủ công.",
    entry_conditions: recommendation.pre_entry_checklist.length
      ? recommendation.pre_entry_checklist
      : [
          "Chỉ cân nhắc khi giá chạm vùng entry và có nến xác nhận trên M5/M15.",
          "Kiểm tra spread thực tế trên sàn trước khi đặt lệnh.",
        ],
    cancel_conditions: recommendation.invalid_conditions.length
      ? recommendation.invalid_conditions
      : [
          "Hủy kèo nếu giá phá vùng vô hiệu trước khi khớp entry.",
          "Hủy kèo nếu H1/H4 đổi cấu trúc ngược lại setup.",
        ],
    warning:
      "Đây là trade mạo hiểm do AI đánh giá lại từ setup bị validation từ chối, không phải khuyến nghị chính.",
  };
}

function inferOrderType(
  direction: "BUY" | "SELL",
  entry: number,
  currentPrice: number,
): RiskyTradeScenario["order_type"] {
  if (direction === "BUY") {
    return entry < currentPrice ? "BUY_LIMIT" : "BUY_STOP";
  }
  return entry > currentPrice ? "SELL_LIMIT" : "SELL_STOP";
}

function sanitizeAiValidationFailures(failures: string[]): string[] {
  const quoteOnlyPatterns = [
    /bid/i,
    /ask/i,
    /spread/i,
    /quote/i,
    /MISSING_REALTIME_SPREAD/i,
  ];

  return Array.from(
    new Set(
      failures.filter(
        (failure) =>
          !quoteOnlyPatterns.some((pattern) => pattern.test(failure)),
      ),
    ),
  );
}
