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
} from "../../utils/marketDiagnostics";
import type {
  MarketDataCollection,
  MarketDataProvider,
} from "./MarketDataProvider";

const minimumCandles = 200;
const intervals: Record<Timeframe, string> = {
  M5: "5m",
  M15: "15m",
  H1: "1h",
  H4: "4h",
};

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  ...unknown[],
];

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  closeTime: number;
}

export class BinanceMarketDataProvider implements MarketDataProvider {
  readonly name = "binance";

  constructor(
    private readonly options: {
      baseUrl: string;
      maxQuoteAgeSeconds?: number;
      debug?: boolean;
    },
  ) {
    if (!options.baseUrl) {
      throw new Error("Chưa cấu hình BTC_MARKET_DATA_BASE_URL.");
    }
  }

  async getSnapshots(symbols: SymbolCode[]): Promise<MarketDataCollection> {
    if (symbols.some((symbol) => symbol !== "BTCUSD")) {
      throw new Error("Binance provider này chỉ hỗ trợ BTCUSD.");
    }

    const snapshots = await Promise.all(symbols.map(() => this.getSnapshot()));
    return {
      provider: this.name,
      timestamp: new Date().toISOString(),
      dataQuality: combineQuality(snapshots),
      warnings: snapshots.flatMap((snapshot) => snapshot.data_warnings),
      snapshots,
    };
  }

  private async getSnapshot(): Promise<MarketSnapshot> {
    const candles = {} as Record<Timeframe, Candle[]>;
    const diagnostics = {} as MarketSnapshot["candle_diagnostics"];
    const timeframeQuality = {} as MarketSnapshot["timeframe_quality"];
    const warnings: string[] = [
      "Giá BTCUSD được tham chiếu từ cặp BTCUSDT trên Binance Spot; USDT được dùng làm proxy cho USD.",
    ];

    for (const timeframe of TIMEFRAMES) {
      const rows = await this.fetchJson<BinanceKline[]>(
        this.url("/api/v3/klines", {
          symbol: "BTCUSDT",
          interval: intervals[timeframe],
          limit: String(marketCandleRequestCount),
        }),
      );
      const parsed = parseProviderCandles(
        [...rows].reverse().map((row) => ({
          time: new Date(row[0]).toISOString(),
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5],
        })),
        timeframe,
      );
      candles[timeframe] = parsed.candles;
      diagnostics[timeframe] = parsed.diagnostics;
      if (parsed.candles.length < minimumCandles) {
        warnings.push(
          `${timeframe} chỉ có ${parsed.candles.length}/${minimumCandles} nến hợp lệ.`,
        );
      }
    }

    const ticker = await this.fetchJson<BinanceTicker>(
      this.url("/api/v3/ticker/24hr", { symbol: "BTCUSDT" }),
    );
    const price = positiveNumber(ticker.lastPrice);
    const bid = positiveNumber(ticker.bidPrice);
    const ask = positiveNumber(ticker.askPrice);
    if (price === null) throw new Error("Binance không trả giá BTC hợp lệ.");

    const bidAskStatus =
      bid !== null && ask !== null && ask > bid ? "AVAILABLE" : "UNAVAILABLE";
    const spread =
      bidAskStatus === "AVAILABLE" && bid !== null && ask !== null
        ? Number((ask - bid).toFixed(8))
        : null;
    if (bidAskStatus !== "AVAILABLE") {
      warnings.push("Binance không trả bid/ask BTC hợp lệ.");
    }

    const quoteTime = Number.isFinite(ticker.closeTime)
      ? new Date(ticker.closeTime).toISOString()
      : null;
    const quoteAgeSeconds = quoteTime
      ? Math.max(0, Math.round((Date.now() - Date.parse(quoteTime)) / 1000))
      : null;
    const readiness = buildReadiness(candles);
    for (const timeframe of TIMEFRAMES) {
      timeframeQuality[timeframe] = buildTimeframeQuality(
        timeframe,
        diagnostics[timeframe],
        readiness[timeframe],
      );
    }
    const dataQuality = aggregateQuality(
      timeframeQuality,
      bidAskStatus,
      quoteAgeSeconds,
      this.maxQuoteAgeSeconds(),
    );

    if (this.options.debug) {
      console.info("[market:binance]", {
        symbol: "BTCUSD",
        dataQuality,
        bidAskStatus,
        quoteAgeSeconds,
        timeframeQuality,
      });
    }

    const fetchedAt = new Date().toISOString();
    return {
      symbol: "BTCUSD",
      price,
      bid,
      ask,
      spread,
      bidAskStatus,
      data_quality: dataQuality,
      data_warnings: warnings,
      informational_diagnostics: [],
      critical_errors: [],
      updated_at: quoteTime ?? fetchedAt,
      provider: this.name,
      providerFetchedAt: fetchedAt,
      providerQuoteTime: quoteTime,
      quoteAgeSeconds,
      quoteTimestampReliable: quoteTime !== null,
      candles,
      filtered_candles: Object.fromEntries(
        TIMEFRAMES.map((timeframe) => [
          timeframe,
          diagnostics[timeframe].filteredCount,
        ]),
      ),
      candle_diagnostics: diagnostics,
      timeframe_quality: timeframeQuality,
    };
  }

  private url(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.options.baseUrl);
    Object.entries(params).forEach(([key, value]) =>
      url.searchParams.set(key, value),
    );
    return url.toString();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance trả HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }

  private maxQuoteAgeSeconds(): number {
    return Number.isFinite(this.options.maxQuoteAgeSeconds)
      ? Math.max(1, Number(this.options.maxQuoteAgeSeconds))
      : 180;
  }
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildReadiness(
  candles: Record<Timeframe, Candle[]>,
): Record<Timeframe, IndicatorReadiness> {
  return Object.fromEntries(
    TIMEFRAMES.map((timeframe) => {
      const count = candles[timeframe].length;
      return [
        timeframe,
        {
          ema20: count >= 20,
          ema50: count >= 50,
          ema200: count >= 200,
          rsi14: count > 14,
          atr14: count >= 15,
          macd: count >= 35,
        },
      ];
    }),
  ) as Record<Timeframe, IndicatorReadiness>;
}

function aggregateQuality(
  quality: MarketSnapshot["timeframe_quality"],
  bidAskStatus: MarketSnapshot["bidAskStatus"],
  quoteAgeSeconds: number | null,
  maxQuoteAgeSeconds: number,
): DataQuality {
  if (Object.values(quality).some((item) => item.quality === "LOW")) return "LOW";
  if (
    bidAskStatus !== "AVAILABLE" ||
    quoteAgeSeconds === null ||
    quoteAgeSeconds > maxQuoteAgeSeconds ||
    Object.values(quality).some((item) => item.quality === "MEDIUM")
  ) {
    return "MEDIUM";
  }
  return "HIGH";
}

function combineQuality(snapshots: MarketSnapshot[]): DataQuality {
  if (snapshots.some((snapshot) => snapshot.data_quality === "LOW")) return "LOW";
  if (snapshots.some((snapshot) => snapshot.data_quality === "MEDIUM")) {
    return "MEDIUM";
  }
  return "HIGH";
}
