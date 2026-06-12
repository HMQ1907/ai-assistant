import type {
  Candle,
  DataQuality,
  IndicatorReadiness,
  MarketSnapshot,
  SymbolCode,
  Timeframe,
} from "../../../types/trading";
import { TIMEFRAMES } from "../../../types/trading";
import {
  buildTimeframeQuality,
  marketCandleRequestCount,
  parseProviderCandles,
  parseProviderTimestamp,
} from "../../utils/marketDiagnostics";
import type {
  MarketDataCollection,
  MarketDataProvider,
} from "./MarketDataProvider";

const candleOutputSize = String(marketCandleRequestCount);
const minimumCandlesForHighQuality = 200;
const maxQuoteAgeSeconds = 180;
const m5IntervalSeconds = 5 * 60;
const m5FreshnessGraceSeconds = 5 * 60;
const quoteToCandleToleranceRatio = 0.0005;

const timeframeIntervals: Record<Timeframe, string> = {
  M5: "5min",
  M15: "15min",
  H1: "1h",
  H4: "4h",
};

const timeframeDurationMs: Record<Timeframe, number> = {
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  H1: 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
};

const twelveDataSymbols: Record<SymbolCode, string> = {
  XAUUSD: "XAU/USD",
};

interface TimeSeriesResult {
  candles: Candle[];
  diagnostics: ReturnType<typeof parseProviderCandles>["diagnostics"];
}

interface TwelveDataTimeSeriesResponse {
  status?: string;
  message?: string;
  values?: Array<{
    datetime?: string;
    open?: string;
    high?: string;
    low?: string;
    close?: string;
    volume?: string;
  }>;
}

interface TwelveDataQuoteResponse {
  status?: string;
  message?: string;
  symbol?: string;
  close?: string;
  bid?: string;
  ask?: string;
  datetime?: string;
  timestamp?: number;
}

interface TwelveDataPriceResponse {
  status?: string;
  message?: string;
  price?: string;
}

export interface LatestMarketPrice {
  symbol: SymbolCode;
  price: number;
  fetchedAt: string;
}

export class RealMarketDataProvider implements MarketDataProvider {
  readonly name = "twelvedata";

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      maxQuoteAgeSeconds?: number;
      debug?: boolean;
    },
  ) {
    if (!options.apiKey) {
      throw new Error(
        "Chưa cấu hình MARKET_DATA_API_KEY cho dữ liệu thị trường thật.",
      );
    }
    if (!options.baseUrl) {
      throw new Error(
        "Chưa cấu hình MARKET_DATA_BASE_URL cho dữ liệu thị trường thật.",
      );
    }
  }

  async getSnapshots(symbols: SymbolCode[]): Promise<MarketDataCollection> {
    const timestamp = new Date().toISOString();
    const warnings: string[] = [];
    const snapshots: MarketSnapshot[] = [];

    for (const symbol of symbols) {
      try {
        const snapshot = await this.getSnapshot(symbol);
        if (snapshot.data_quality === "LOW") {
          warnings.push(
            `${symbol}: dữ liệu thị trường bị đánh dấu LOW (${snapshot.data_warnings.join("; ")}).`,
          );
        }
        snapshots.push(snapshot);
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : "Không lấy được dữ liệu thị trường.";
        warnings.push(`${symbol}: ${reason}`);
      }
    }

    if (snapshots.length === 0) {
      throw new Error(
        "Không lấy được dữ liệu realtime hợp lệ cho XAUUSD từ provider thật.",
      );
    }

    return {
      provider: this.name,
      timestamp,
      dataQuality: combineCollectionQuality(snapshots),
      warnings,
      snapshots,
    };
  }

  async getLatestPrice(symbol: SymbolCode): Promise<LatestMarketPrice> {
    const priceResponse = await this.getPrice(twelveDataSymbols[symbol]);
    const price = parseNumber(priceResponse.price);
    if (!price) {
      throw new Error("Không có giá XAUUSD hợp lệ từ provider.");
    }
    return {
      symbol,
      price,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async getSnapshot(symbol: SymbolCode): Promise<MarketSnapshot> {
    const providerSymbol = twelveDataSymbols[symbol];
    const warnings: string[] = [];
    const informationalDiagnostics: string[] = [];
    const criticalErrors: string[] = [];
    const candles = {} as Record<Timeframe, Candle[]>;
    const filteredCandles: Partial<Record<Timeframe, number>> = {};
    const candleDiagnostics = {} as MarketSnapshot["candle_diagnostics"];
    const timeframeQuality = {} as MarketSnapshot["timeframe_quality"];

    for (const timeframe of TIMEFRAMES) {
      const series = await this.getTimeSeries(providerSymbol, timeframe);
      candles[timeframe] = series.candles;
      filteredCandles[timeframe] = series.diagnostics.filteredCount;
      candleDiagnostics[timeframe] = series.diagnostics;

      if (series.candles.length === 0) {
        throw new Error(`${timeframe} không có candles thật từ provider.`);
      }
      if (series.candles.length < minimumCandlesForHighQuality) {
        warnings.push(
          `${timeframe} chỉ có ${series.candles.length} candles, cần tối thiểu ${minimumCandlesForHighQuality}.`,
        );
      }
      if (series.diagnostics.filteredCount > 0) {
        informationalDiagnostics.push(
          `${timeframe}: đã loại ${series.diagnostics.filteredCount}/${series.diagnostics.receivedCount} candle. Lý do: ${formatReasons(series.diagnostics.reasons)}.`,
        );
      }
    }

    const [quote, priceResponse] = await Promise.all([
      this.getQuote(providerSymbol),
      this.getPrice(providerSymbol),
    ]);
    const price = parseNumber(priceResponse.price);
    if (!price) throw new Error("Không có giá realtime hợp lệ từ quote.");

    let bid = parseNumber(quote.bid);
    let ask = parseNumber(quote.ask);
    let spread: number | null = null;
    let bidAskStatus: MarketSnapshot["bidAskStatus"] = "UNAVAILABLE";
    if (bid !== undefined && ask !== undefined && ask > bid) {
      spread = Number((ask - bid).toFixed(6));
      bidAskStatus = "AVAILABLE";
    } else if (bid !== undefined || ask !== undefined) {
      bidAskStatus = "INVALID";
      warnings.push("Bid/ask provider không hợp lệ, không tự dựng spread.");
    } else {
      warnings.push("Provider không trả bid/ask thật, không tự dựng spread.");
    }

    const providerFetchedAt = new Date().toISOString();
    const providerQuoteTime =
      parseUnixTimestamp(quote.timestamp) ??
      parseProviderTimestamp(quote.datetime);
    const providerQuoteAgeSeconds = ageInSeconds(providerQuoteTime);
    const m5FallbackTime = resolveM5FallbackTime(price, candles.M5.at(-1));
    const useM5Fallback =
      (providerQuoteAgeSeconds === null ||
        providerQuoteAgeSeconds > this.maxQuoteAgeSeconds()) &&
      m5FallbackTime !== null;
    const quoteTime = useM5Fallback ? m5FallbackTime : providerQuoteTime;
    const quoteAgeSeconds = ageInSeconds(quoteTime);
    const quoteTimestampReliable = quoteTime !== null;
    if (useM5Fallback) {
      informationalDiagnostics.push(
        "Timestamp /quote không đồng bộ; freshness được xác thực bằng nến M5 mới nhất khớp với giá quote.",
      );
    }
    if (!quoteTimestampReliable) {
      warnings.push(
        "Quote timestamp không đáng tin cậy hoặc chỉ là date-only.",
      );
    } else if (
      quoteAgeSeconds !== null &&
      quoteAgeSeconds > this.maxQuoteAgeSeconds()
    ) {
      warnings.push(
        `Quote stale ${quoteAgeSeconds}s, vượt ngưỡng ${this.maxQuoteAgeSeconds()}s.`,
      );
    }

    const indicatorReadiness = buildBasicReadiness(candles);
    for (const timeframe of TIMEFRAMES) {
      timeframeQuality[timeframe] = buildTimeframeQuality(
        timeframe,
        candleDiagnostics[timeframe],
        indicatorReadiness[timeframe],
      );
    }
    const dataQuality = aggregateMarketQuality({
      timeframeQuality,
      bidAskStatus,
      quoteTimestampReliable,
      quoteAgeSeconds,
      maxQuoteAgeSeconds: this.maxQuoteAgeSeconds(),
      criticalErrors,
    });

    if (this.options.debug) {
      console.info("[market:twelvedata]", {
        symbol,
        bidAskStatus,
        providerQuoteTime,
        providerQuoteAgeSeconds,
        quoteTime,
        quoteAgeSeconds,
        quoteTimestampReliable,
        usedM5TimestampFallback: useM5Fallback,
        timeframeQuality,
        candleDiagnostics,
      });
    }

    const snapshot: MarketSnapshot = {
      symbol,
      price,
      bid: bidAskStatus === "AVAILABLE" ? (bid ?? null) : null,
      ask: bidAskStatus === "AVAILABLE" ? (ask ?? null) : null,
      spread,
      bidAskStatus,
      data_quality: dataQuality,
      data_warnings: warnings,
      informational_diagnostics: informationalDiagnostics,
      critical_errors: criticalErrors,
      updated_at: quoteTime ?? providerFetchedAt,
      provider: this.name,
      providerFetchedAt,
      providerQuoteTime: quoteTime,
      quoteAgeSeconds,
      quoteTimestampReliable,
      candles,
      filtered_candles: filteredCandles,
      candle_diagnostics: candleDiagnostics,
      timeframe_quality: timeframeQuality,
    };
    return snapshot;
  }

  private async getTimeSeries(
    symbol: string,
    timeframe: Timeframe,
  ): Promise<TimeSeriesResult> {
    const url = this.url("/time_series", {
      symbol,
      interval: timeframeIntervals[timeframe],
      outputsize: candleOutputSize,
      timezone: "UTC", // Bắt buộc trả múi giờ UTC đồng nhất
      apikey: this.options.apiKey,
    });
    const json = await this.fetchJson<TwelveDataTimeSeriesResponse>(url);
    if (json.status === "error") {
      throw new Error(
        json.message || `Twelve Data không hỗ trợ ${symbol} ${timeframe}.`,
      );
    }
    const values = json.values ?? [];

    const parsed = parseProviderCandles(
      values.map((item) => ({
        time: item.datetime,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
      })),
      timeframe,
    );

    return removeIncompleteCandles(parsed, timeframe);
  }

  private async getQuote(symbol: string): Promise<TwelveDataQuoteResponse> {
    const json = await this.fetchJson<TwelveDataQuoteResponse>(
      this.url("/quote", {
        symbol,
        timezone: "UTC",
        apikey: this.options.apiKey,
      }),
    );
    if (json.status === "error") {
      throw new Error(json.message || `Không lấy được quote cho ${symbol}.`);
    }
    return json;
  }

  private async getPrice(symbol: string): Promise<TwelveDataPriceResponse> {
    const json = await this.fetchJson<TwelveDataPriceResponse>(
      this.url("/price", {
        symbol,
        apikey: this.options.apiKey,
      }),
    );
    if (json.status === "error") {
      throw new Error(
        json.message || `Twelve Data không trả giá cho ${symbol}.`,
      );
    }
    return json;
  }

  private url(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Provider trả HTTP ${response.status}.`);
    return (await response.json()) as T;
  }

  private maxQuoteAgeSeconds(): number {
    return Number.isFinite(this.options.maxQuoteAgeSeconds)
      ? Math.max(1, Number(this.options.maxQuoteAgeSeconds))
      : maxQuoteAgeSeconds;
  }
}

function removeIncompleteCandles(
  result: ReturnType<typeof parseProviderCandles>,
  timeframe: Timeframe,
): TimeSeriesResult {
  const now = Date.now();
  const candles = result.candles.filter((candle) => {
    const start = new Date(candle.time).getTime();
    return Number.isFinite(start) && start + timeframeDurationMs[timeframe] <= now;
  });
  const removed = result.candles.length - candles.length;

  if (removed > 0) {
    result.diagnostics.reasons.INCOMPLETE_CANDLE =
      (result.diagnostics.reasons.INCOMPLETE_CANDLE ?? 0) + removed;
  }

  return {
    candles,
    diagnostics: {
      ...result.diagnostics,
      validCount: candles.length,
      filteredCount: result.diagnostics.filteredCount + removed,
      lastValidCandleTime: candles.at(-1)?.time ?? null,
      indicatorDataSufficient: candles.length >= minimumCandlesForHighQuality,
    },
  };
}

function combineCollectionQuality(snapshots: MarketSnapshot[]): DataQuality {
  if (snapshots.some((snapshot) => snapshot.data_quality === "LOW")) {
    return "MEDIUM";
  }
  if (snapshots.some((snapshot) => snapshot.data_quality === "MEDIUM")) {
    return "MEDIUM";
  }
  return "HIGH";
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseUnixTimestamp(value: number | undefined): string | null {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ageInSeconds(isoTime: string | null): number | null {
  if (!isoTime) return null;
  const timestamp = new Date(isoTime).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 1000));
}

function resolveM5FallbackTime(
  quotePrice: number,
  latestCandle: Candle | undefined,
): string | null {
  if (!latestCandle || !pricesAreConsistent(quotePrice, latestCandle)) {
    return null;
  }

  const candleStartMs = new Date(latestCandle.time).getTime();
  if (!Number.isFinite(candleStartMs)) return null;

  const nowMs = Date.now();
  const candleAgeSeconds = Math.max(
    0,
    Math.round((nowMs - candleStartMs) / 1000),
  );
  if (candleAgeSeconds > m5IntervalSeconds + m5FreshnessGraceSeconds) {
    return null;
  }

  const effectiveTimeMs = Math.min(
    nowMs,
    candleStartMs + m5IntervalSeconds * 1000,
  );
  return new Date(effectiveTimeMs).toISOString();
}

function pricesAreConsistent(quotePrice: number, candle: Candle): boolean {
  const tolerance = Math.max(0.1, quotePrice * quoteToCandleToleranceRatio);
  return (
    quotePrice >= candle.low - tolerance &&
    quotePrice <= candle.high + tolerance
  );
}

function formatReasons(reasons: Partial<Record<string, number>>): string {
  const entries = Object.entries(reasons);
  return entries.length
    ? entries.map(([reason, count]) => `${reason}=${count}`).join(", ")
    : "không có";
}

function buildBasicReadiness(
  candles: Record<Timeframe, Candle[]>,
): Record<Timeframe, IndicatorReadiness> {
  const result = {} as Record<Timeframe, IndicatorReadiness>;
  for (const timeframe of TIMEFRAMES) {
    const length = candles[timeframe].length;
    result[timeframe] = {
      ema20: length >= 20,
      ema50: length >= 50,
      ema200: length >= 200,
      rsi14: length > 14,
      atr14: length >= 15,
      macd: length >= 35,
    };
  }
  return result;
}

function aggregateMarketQuality(input: {
  timeframeQuality: Record<
    Timeframe,
    MarketSnapshot["timeframe_quality"][Timeframe]
  >;
  bidAskStatus: MarketSnapshot["bidAskStatus"];
  quoteTimestampReliable: boolean;
  quoteAgeSeconds: number | null;
  maxQuoteAgeSeconds: number;
  criticalErrors: string[];
}): DataQuality {
  if (
    input.criticalErrors.length > 0 ||
    Object.values(input.timeframeQuality).some((item) => item.quality === "LOW")
  ) {
    return "LOW";
  }
  if (
    input.bidAskStatus !== "AVAILABLE" ||
    !input.quoteTimestampReliable ||
    (input.quoteAgeSeconds !== null &&
      input.quoteAgeSeconds > input.maxQuoteAgeSeconds) ||
    Object.values(input.timeframeQuality).some(
      (item) => item.quality === "MEDIUM",
    )
  ) {
    return "MEDIUM";
  }
  return "HIGH";
}
