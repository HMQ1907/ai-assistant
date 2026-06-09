import type {
  Candle,
  CandleDiagnostics,
  CandleFilterReason,
  DataQuality,
  IndicatorReadiness,
  Timeframe,
  TimeframeQuality,
} from "../../types/trading";

export const marketCandleRequestCount = 350;
export const requiredIndicatorCandles = 200;

export interface RawProviderCandle {
  datetime?: string | undefined;
  time?: string | undefined;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
}

export interface ParsedCandleResult {
  candles: Candle[];
  diagnostics: CandleDiagnostics;
}

export function parseProviderCandles(
  values: RawProviderCandle[],
  timeframe: Timeframe,
): ParsedCandleResult {
  const sorted = [...values].reverse();
  const reasons: Partial<Record<CandleFilterReason, number>> = {};
  const valid: Candle[] = [];
  const seenTimestamps = new Set<string>();

  for (const item of sorted) {
    const timestamp = parseProviderTimestamp(item.time ?? item.datetime);
    const open = parseFinitePrice(item.open);
    const high = parseFinitePrice(item.high);
    const low = parseFinitePrice(item.low);
    const close = parseFinitePrice(item.close);
    const volume = Number(item.volume ?? 0);

    if (!timestamp) {
      countReason(reasons, "INVALID_TIMESTAMP");
      continue;
    }
    if (
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      !Number.isFinite(volume)
    ) {
      countReason(reasons, "INVALID_NUMBER");
      continue;
    }
    if (seenTimestamps.has(timestamp)) {
      countReason(reasons, "DUPLICATE_TIMESTAMP");
      continue;
    }
    seenTimestamps.add(timestamp);

    const candle: Candle = {
      time: timestamp,
      open,
      high,
      low,
      close,
      volume,
    };

    if (!hasValidShape(candle)) {
      countReason(reasons, "INVALID_SHAPE");
      continue;
    }

    valid.push(candle);
  }

  const filtered = removeFrozenSequences(valid, timeframe, reasons);

  return {
    candles: filtered,
    diagnostics: {
      requestedCount: marketCandleRequestCount,
      receivedCount: values.length,
      validCount: filtered.length,
      filteredCount: values.length - filtered.length,
      reasons,
      firstRawCandleTime: firstParsedTime(sorted),
      lastRawCandleTime: lastParsedTime(sorted),
      firstValidCandleTime: filtered[0]?.time ?? null,
      lastValidCandleTime: filtered.at(-1)?.time ?? null,
      indicatorDataSufficient: filtered.length >= requiredIndicatorCandles,
    },
  };
}

export function buildTimeframeQuality(
  timeframe: Timeframe,
  diagnostics: CandleDiagnostics,
  readiness: IndicatorReadiness,
): TimeframeQuality {
  const invalidRatio =
    diagnostics.receivedCount === 0
      ? 1
      : diagnostics.filteredCount / diagnostics.receivedCount;
  const reasons: string[] = [];
  const malformed =
    (diagnostics.reasons.INVALID_NUMBER ?? 0) +
    (diagnostics.reasons.INVALID_SHAPE ?? 0) +
    (diagnostics.reasons.INVALID_TIMESTAMP ?? 0);
  const frozen = diagnostics.reasons.FROZEN_SEQUENCE ?? 0;
  const duplicate = diagnostics.reasons.DUPLICATE_TIMESTAMP ?? 0;

  let quality: DataQuality = "HIGH";
  if (!diagnostics.indicatorDataSufficient || !readiness.ema200) {
    quality = "LOW";
    reasons.push(`${timeframe}: không đủ candle sạch để tính indicator bắt buộc.`);
  }
  if (malformed > 0 || duplicate > 0) {
    quality = quality === "LOW" ? "LOW" : "MEDIUM";
    reasons.push(`${timeframe}: có candle lỗi định dạng hoặc timestamp.`);
  }
  if (frozen > 0 && invalidRatio > 0.08) {
    quality = "LOW";
    reasons.push(`${timeframe}: tỷ lệ frozen candle bất thường.`);
  } else if (frozen > 0 || invalidRatio > 0.02) {
    quality = quality === "LOW" ? "LOW" : "MEDIUM";
    reasons.push(`${timeframe}: có cảnh báo candle nhưng vẫn có thể dùng thận trọng.`);
  }

  return {
    timeframe,
    quality,
    validCandleCount: diagnostics.validCount,
    requiredCandleCount: requiredIndicatorCandles,
    invalidRatio: Number(invalidRatio.toFixed(4)),
    indicatorReadiness: readiness,
    reasons,
  };
}

export function parseProviderTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const candidate = withTimezone ? value : `${value}Z`;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isExpectedXauUsdMarketClosed(isoTime: string): boolean {
  const date = new Date(isoTime);
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function removeFrozenSequences(
  candles: Candle[],
  timeframe: Timeframe,
  reasons: Partial<Record<CandleFilterReason, number>>,
): Candle[] {
  const output: Candle[] = [];
  let repeatedRun: Candle[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (!candle) continue;

    if (candle.high === candle.low) {
      countReason(reasons, "ZERO_RANGE");
      continue;
    }

    if (previous && hasSameOhlc(previous, candle)) {
      repeatedRun.push(candle);
      continue;
    }

    flushRepeatedRun(repeatedRun, output, reasons);
    repeatedRun = [];
    output.push(candle);
  }

  flushRepeatedRun(repeatedRun, output, reasons);

  return output.filter((candle) => {
    const range = candle.high - candle.low;
    if (isLowRangeButStandalone(range, timeframe)) {
      return true;
    }
    return true;
  });
}

function flushRepeatedRun(
  repeatedRun: Candle[],
  output: Candle[],
  reasons: Partial<Record<CandleFilterReason, number>>,
): void {
  if (repeatedRun.length === 0) return;
  for (const candle of repeatedRun) {
    countReason(
      reasons,
      isExpectedXauUsdMarketClosed(candle.time)
        ? "EXPECTED_MARKET_CLOSED"
        : repeatedRun.length >= 2
          ? "FROZEN_SEQUENCE"
          : "REPEATED_OHLC",
    );
  }
}

function isLowRangeButStandalone(range: number, timeframe: Timeframe): boolean {
  const minimum = timeframe === "M5" ? 0.05 : timeframe === "M15" ? 0.1 : 0.25;
  return range < minimum;
}

function hasValidShape(candle: Candle): boolean {
  return (
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.high >= candle.low
  );
}

function hasSameOhlc(left: Candle, right: Candle): boolean {
  return (
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close
  );
}

function parseFinitePrice(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function countReason(
  reasons: Partial<Record<CandleFilterReason, number>>,
  reason: CandleFilterReason,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function firstParsedTime(values: RawProviderCandle[]): string | null {
  for (const value of values) {
    const parsed = parseProviderTimestamp(value.time ?? value.datetime);
    if (parsed) return parsed;
  }
  return null;
}

function lastParsedTime(values: RawProviderCandle[]): string | null {
  for (const value of [...values].reverse()) {
    const parsed = parseProviderTimestamp(value.time ?? value.datetime);
    if (parsed) return parsed;
  }
  return null;
}
