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

const timeframeIntervals: Record<Timeframe, string> = {
  M5: "5min",
  M15: "15min",
  H1: "1h",
  H4: "4h",
};

const twelveDataSymbols: Record<SymbolCode, string> = {
  XAUUSD: "XAU/USD",
};

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
      throw new Error("Chưa cấu hình MARKET_DATA_API_KEY cho dữ liệu thị trường thật.");
    }
    if (!options.baseUrl) {
      throw new Error("Chưa cấu hình MARKET_DATA_BASE_URL cho dữ liệu thị trường thật.");
    }
  }

  async getSnapshots(symbols: SymbolCode[]): Promise<MarketDataCollection> {
    const timestamp = new Date().toISOString();
    const warnings: string[] = [];
    const snapshots: MarketSnapshot[] = [];

    for (const symbol of symbols) {
      try {
        const snapshot = await this.getSnapshot(symbol);
        // Vẫn đưa vào snapshots dù LOW quality; TradeValidationService sẽ
        // tự force NO_TRADE. Provider chỉ throw khi thiếu dữ liệu thật bắt buộc.
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

    for (const timeframe of TIMEFRAMES) {
      const series = await this.getTimeSeries(providerSymbol, timeframe);
      candles[timeframe] = series;
      if (
        (timeframe === "M5" || timeframe === "M15" || timeframe === "H1") &&
        series.length === 0
      ) {
        throw new Error(`${timeframe} không có candles thật từ provider.`);
      }
      if (
        (timeframe === "M5" || timeframe === "M15" || timeframe === "H1") &&
        series.length < 100
      ) {
        warnings.push(
          `${timeframe} chỉ có ${series.length} candles, cần tối thiểu 100.`,
        );
      }
    }

    const quote = await this.getQuote(providerSymbol);
    const price = parseNumber(quote.close);
    if (!price) throw new Error("Không có giá realtime hợp lệ từ quote.");

    const bid = parseNumber(quote.bid);
    const ask = parseNumber(quote.ask);
    if (bid === undefined || ask === undefined || ask <= bid) {
      throw new Error("Provider không trả bid/ask/spread hợp lệ.");
    }
    const spread = ask - bid;

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
    };
    if (bid !== undefined) snapshot.bid = bid;
    if (ask !== undefined) snapshot.ask = ask;
    return snapshot;
  }

  private async getTimeSeries(
    symbol: string,
    timeframe: Timeframe,
  ): Promise<Candle[]> {
    const url = this.url("/time_series", {
      symbol,
      interval: timeframeIntervals[timeframe],
      outputsize: "120",
      apikey: this.options.apiKey,
    });
    const json = await this.fetchJson<TwelveDataTimeSeriesResponse>(url);
    if (json.status === "error")
      throw new Error(
        json.message || `Twelve Data không hỗ trợ ${symbol} ${timeframe}.`,
      );
    const values = json.values ?? [];

    return values
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
  }

  private async getQuote(symbol: string): Promise<TwelveDataQuoteResponse> {
    const json = await this.fetchJson<TwelveDataQuoteResponse>(
      this.url("/quote", {
        symbol,
        apikey: this.options.apiKey,
      }),
    );
    if (json.status === "error")
      throw new Error(json.message || `Không lấy được quote cho ${symbol}.`);
    return json;
  }

  private url(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return url.toString();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Provider trả HTTP ${response.status}.`);
    return (await response.json()) as T;
  }
}

function combineCollectionQuality(snapshots: MarketSnapshot[]): DataQuality {
  if (snapshots.some((snapshot) => snapshot.data_quality === "LOW"))
    return "LOW";
  return "HIGH";
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
