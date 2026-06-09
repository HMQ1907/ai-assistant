import type {
  Candle,
  DataQuality,
  MarketSnapshot,
  SymbolCode,
  Timeframe,
} from "../../../types/trading";
import { TIMEFRAMES } from "../../../types/trading";
import type {
  MarketDataCollection,
  MarketDataProvider,
} from "./MarketDataProvider";

const candleOutputSize = "250";
const minimumCandlesForHighQuality = 200;
const duplicatePriceTolerance = 0.0001;

const timeframeIntervals: Record<Timeframe, string> = {
  M5: "5min",
  M15: "15min",
  H1: "1h",
  H4: "4h",
};

const twelveDataSymbols: Record<SymbolCode, string> = {
  XAUUSD: "XAU/USD",
};

const minimumRangeByTimeframe: Record<Timeframe, number> = {
  M5: 0.1,
  M15: 0.2,
  H1: 0.5,
  H4: 0.5,
};

interface TimeSeriesResult {
  candles: Candle[];
  filteredOut: number;
  warnings: string[];
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
            `${symbol}: dữ liệu candle không đủ (${snapshot.data_warnings.join("; ")}), AI sẽ trả NO_TRADE.`,
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
    const candles = {} as Record<Timeframe, Candle[]>;
    const filteredCandles: Partial<Record<Timeframe, number>> = {};

    for (const timeframe of TIMEFRAMES) {
      const series = await this.getTimeSeries(providerSymbol, timeframe);
      candles[timeframe] = series.candles;
      filteredCandles[timeframe] = series.filteredOut;
      warnings.push(...series.warnings);

      if (series.candles.length === 0) {
        throw new Error(`${timeframe} không có candles thật từ provider.`);
      }
      if (series.candles.length < minimumCandlesForHighQuality) {
        warnings.push(
          `${timeframe} chỉ có ${series.candles.length} candles, cần tối thiểu ${minimumCandlesForHighQuality}.`,
        );
      }
    }

    const quote = await this.getQuote(providerSymbol);
    const price = parseNumber(quote.close);
    if (!price) throw new Error("Không có giá realtime hợp lệ từ quote.");

    let bid = parseNumber(quote.bid);
    let ask = parseNumber(quote.ask);
    let spread = 0.3;
    if (bid === undefined || ask === undefined || ask <= bid) {
      bid = price;
      ask = price + spread;
    } else {
      spread = ask - bid;
    }

    const snapshot: MarketSnapshot = {
      symbol,
      price,
      spread,
      data_quality: warnings.length > 0 ? "LOW" : "HIGH",
      data_warnings: warnings,
      updated_at: quote.datetime
        ? new Date(quote.datetime).toISOString()
        : new Date().toISOString(),
      provider: this.name,
      candles,
      filtered_candles: filteredCandles,
    };
    if (bid !== undefined) snapshot.bid = bid;
    if (ask !== undefined) snapshot.ask = ask;
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

    const candles = values
      .map((item) => ({
        time: item.datetime ? new Date(item.datetime).toISOString() : "",
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
        volume: Number(item.volume ?? 0),
      }))
      .filter(
        (item) =>
          item.time &&
          [item.open, item.high, item.low, item.close].every(Number.isFinite),
      )
      .reverse();

    return filterProviderCandles(candles, timeframe);
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
}

function combineCollectionQuality(snapshots: MarketSnapshot[]): DataQuality {
  if (snapshots.some((snapshot) => snapshot.data_quality === "LOW")) {
    return "LOW";
  }
  return "HIGH";
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function filterProviderCandles(
  candles: Candle[],
  timeframe: Timeframe,
): TimeSeriesResult {
  const minimumRange = minimumRangeByTimeframe[timeframe];
  const filtered: Candle[] = [];
  let filteredOut = 0;

  for (const candle of candles) {
    if (!hasValidShape(candle)) {
      filteredOut += 1;
      continue;
    }

    const previous = filtered.at(-1);
    const range = candle.high - candle.low;
    const hasFrozenRange = range < minimumRange;
    const isRepeated = previous ? hasSameOhlc(previous, candle) : false;

    if (hasFrozenRange || isRepeated) {
      filteredOut += 1;
      continue;
    }

    filtered.push(candle);
  }

  const warnings =
    filteredOut > 0
      ? [
          `${timeframe}: đã loại ${filteredOut}/${candles.length} candles có range bất thường hoặc bị lặp từ provider.`,
        ]
      : [];

  return {
    candles: filtered,
    filteredOut,
    warnings,
  };
}

function hasValidShape(candle: Candle): boolean {
  const tolerance = 0.0001;
  return (
    candle.high >= candle.low &&
    candle.open <= candle.high + tolerance &&
    candle.open >= candle.low - tolerance &&
    candle.close <= candle.high + tolerance &&
    candle.close >= candle.low - tolerance
  );
}

function hasSameOhlc(left: Candle, right: Candle): boolean {
  return (
    isClose(left.open, right.open) &&
    isClose(left.high, right.high) &&
    isClose(left.low, right.low) &&
    isClose(left.close, right.close)
  );
}

function isClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= duplicatePriceTolerance;
}
