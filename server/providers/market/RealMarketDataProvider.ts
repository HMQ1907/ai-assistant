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

const timeframeIntervals: Record<Timeframe, string> = {
  M5: "5min",
  M15: "15min",
  H1: "1h",
  H4: "4h",
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

    const quote = await this.getQuote(providerSymbol);
    const price = parseNumber(quote.close);
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
    const quoteTime = parseProviderTimestamp(quote.datetime);
    const quoteAgeSeconds = quoteTime
      ? Math.max(0, Math.round((Date.now() - new Date(quoteTime).getTime()) / 1000))
      : null;
    const quoteTimestampReliable = quoteTime !== null;
    if (!quoteTimestampReliable) {
      warnings.push("Quote timestamp không đáng tin cậy hoặc chỉ là date-only.");
    } else if (quoteAgeSeconds !== null && quoteAgeSeconds > this.maxQuoteAgeSeconds()) {
      warnings.push(`Quote stale ${quoteAgeSeconds}s, vượt ngưỡng ${this.maxQuoteAgeSeconds()}s.`);
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
        quoteAgeSeconds,
        quoteTimestampReliable,
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
      updated_at: quote.datetime
        ? (quoteTime ?? providerFetchedAt)
        : providerFetchedAt,
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
      apikey: this.options.apiKey,
    });
    const json = await this.fetchJson<TwelveDataTimeSeriesResponse>(url);
    if (json.status === "error") {
      throw new Error(
        json.message || `Twelve Data không hỗ trợ ${symbol} ${timeframe}.`,
      );
    }
    const values = json.values ?? [];

    return parseProviderCandles(
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
  }

  private async getQuote(symbol: string): Promise<TwelveDataQuoteResponse> {
    const json = await this.fetchJson<TwelveDataQuoteResponse>(
      this.url("/quote", {
        symbol,
        apikey: this.options.apiKey,
      }),
    );
    if (json.status === "error") {
      throw new Error(json.message || `Không lấy được quote cho ${symbol}.`);
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
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Provider trả HTTP ${response.status}.`);
    return (await response.json()) as T;
  }

  private maxQuoteAgeSeconds(): number {
    return Number.isFinite(this.options.maxQuoteAgeSeconds)
      ? Math.max(1, Number(this.options.maxQuoteAgeSeconds))
      : maxQuoteAgeSeconds;
  }
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

function formatReasons(
  reasons: Partial<Record<string, number>>,
): string {
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
  timeframeQuality: Record<Timeframe, MarketSnapshot["timeframe_quality"][Timeframe]>;
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
    (input.quoteAgeSeconds !== null && input.quoteAgeSeconds > input.maxQuoteAgeSeconds) ||
    Object.values(input.timeframeQuality).some((item) => item.quality === "MEDIUM")
  ) {
    return "MEDIUM";
  }
  return "HIGH";
}
