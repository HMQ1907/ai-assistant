import type {
  Candle,
  CandlePatternName,
  CandlePatternSignal,
  Timeframe,
} from "../../types/trading";
import { round } from "./indicators";

export function detectCandlePatterns(
  timeframe: Timeframe,
  candles: Candle[],
): CandlePatternSignal[] {
  const recent = candles.slice(-5);
  const signals: CandlePatternSignal[] = [];

  for (let index = 0; index < recent.length; index += 1) {
    const candle = recent[index];
    if (!candle) continue;
    const previous = recent[index - 1];
    signals.push(...detectSingleCandle(timeframe, candle));
    if (previous) {
      signals.push(...detectEngulfing(timeframe, previous, candle));
    }
  }

  return signals
    .sort((left, right) => strengthScore(right.strength) - strengthScore(left.strength))
    .slice(0, 5);
}

function detectSingleCandle(
  timeframe: Timeframe,
  candle: Candle,
): CandlePatternSignal[] {
  const range = candle.high - candle.low;
  if (range <= 0) return [];

  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const bodyRatio = body / range;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;
  const bullish = candle.close > candle.open;
  const bearish = candle.close < candle.open;
  const signals: CandlePatternSignal[] = [];

  if (bodyRatio <= 0.12) {
    signals.push(
      signal(
        timeframe,
        candle,
        "DOJI",
        "NEUTRAL",
        upperRatio > 0.35 || lowerRatio > 0.35 ? "MEDIUM" : "WEAK",
        "Thân nến rất nhỏ, thể hiện do dự tại vùng giá hiện tại.",
      ),
    );
  }

  if (lowerRatio >= 0.55 && upperRatio <= 0.2 && bodyRatio <= 0.35) {
    signals.push(
      signal(
        timeframe,
        candle,
        "HAMMER",
        "BULLISH",
        lowerRatio >= 0.68 ? "STRONG" : "MEDIUM",
        "Bóng dưới dài cho thấy lực mua đỡ giá sau nhịp giảm trong nến.",
      ),
    );
  }

  if (upperRatio >= 0.55 && lowerRatio <= 0.2 && bodyRatio <= 0.35) {
    signals.push(
      signal(
        timeframe,
        candle,
        "SHOOTING_STAR",
        "BEARISH",
        upperRatio >= 0.68 ? "STRONG" : "MEDIUM",
        "Bóng trên dài cho thấy lực bán từ chối vùng giá cao trong nến.",
      ),
    );
  }

  if (bullish && bodyRatio >= 0.62) {
    signals.push(
      signal(
        timeframe,
        candle,
        "STRONG_BULLISH_BODY",
        "BULLISH",
        bodyRatio >= 0.76 ? "STRONG" : "MEDIUM",
        "Thân nến tăng lớn, thể hiện lực mua chiếm ưu thế.",
      ),
    );
  }

  if (bearish && bodyRatio >= 0.62) {
    signals.push(
      signal(
        timeframe,
        candle,
        "STRONG_BEARISH_BODY",
        "BEARISH",
        bodyRatio >= 0.76 ? "STRONG" : "MEDIUM",
        "Thân nến giảm lớn, thể hiện lực bán chiếm ưu thế.",
      ),
    );
  }

  if (bullish && lowerRatio >= 0.45) {
    signals.push(
      signal(
        timeframe,
        candle,
        "BULLISH_REJECTION",
        "BULLISH",
        lowerRatio >= 0.6 ? "STRONG" : "MEDIUM",
        "Giá bị đẩy xuống nhưng đóng cửa hồi lên, có dấu hiệu từ chối giảm.",
      ),
    );
  }

  if (bearish && upperRatio >= 0.45) {
    signals.push(
      signal(
        timeframe,
        candle,
        "BEARISH_REJECTION",
        "BEARISH",
        upperRatio >= 0.6 ? "STRONG" : "MEDIUM",
        "Giá bị đẩy lên nhưng đóng cửa giảm lại, có dấu hiệu từ chối tăng.",
      ),
    );
  }

  return signals;
}

function detectEngulfing(
  timeframe: Timeframe,
  previous: Candle,
  current: Candle,
): CandlePatternSignal[] {
  const previousBodyHigh = Math.max(previous.open, previous.close);
  const previousBodyLow = Math.min(previous.open, previous.close);
  const currentBodyHigh = Math.max(current.open, current.close);
  const currentBodyLow = Math.min(current.open, current.close);
  const previousBearish = previous.close < previous.open;
  const previousBullish = previous.close > previous.open;
  const currentBullish = current.close > current.open;
  const currentBearish = current.close < current.open;
  const engulfed =
    currentBodyHigh >= previousBodyHigh && currentBodyLow <= previousBodyLow;

  if (!engulfed) return [];

  if (previousBearish && currentBullish) {
    return [
      signal(
        timeframe,
        current,
        "BULLISH_ENGULFING",
        "BULLISH",
        "STRONG",
        "Thân nến tăng bao phủ thân nến giảm trước đó, có tín hiệu đảo chiều tăng ngắn hạn.",
      ),
    ];
  }

  if (previousBullish && currentBearish) {
    return [
      signal(
        timeframe,
        current,
        "BEARISH_ENGULFING",
        "BEARISH",
        "STRONG",
        "Thân nến giảm bao phủ thân nến tăng trước đó, có tín hiệu đảo chiều giảm ngắn hạn.",
      ),
    ];
  }

  return [];
}

function signal(
  timeframe: Timeframe,
  candle: Candle,
  pattern: CandlePatternName,
  direction: CandlePatternSignal["direction"],
  strength: CandlePatternSignal["strength"],
  explanation: string,
): CandlePatternSignal {
  return {
    timeframe,
    pattern,
    candleTime: candle.time,
    direction,
    strength,
    explanation: `${explanation} O:${round(candle.open, 2)} H:${round(candle.high, 2)} L:${round(candle.low, 2)} C:${round(candle.close, 2)}.`,
  };
}

function strengthScore(value: CandlePatternSignal["strength"]): number {
  if (value === "STRONG") return 3;
  if (value === "MEDIUM") return 2;
  return 1;
}
