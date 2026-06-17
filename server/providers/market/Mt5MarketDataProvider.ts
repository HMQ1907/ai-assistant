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
  LatestMarketPrice,
  MarketDataCollection,
  MarketDataProvider,
} from "./MarketDataProvider";

interface Mt5BridgeCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Mt5BridgeSnapshot {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  spread: number;
  spread_points: number;
  digits: number;
  time: string;
  time_msc: number;
  provider: string;
  candles: Record<Timeframe, Mt5BridgeCandle[]>;
}

const defaultMaxQuoteAgeSeconds = 180;

export class Mt5MarketDataProvider implements MarketDataProvider {
  readonly name = "mt5-exness";

  constructor(
    private readonly options: {
      bridgeUrl: string;
      symbol: string;
      maxQuoteAgeSeconds?: number;
      debug?: boolean;
    },
  ) {
    if (!options.bridgeUrl) {
      throw new Error("Chua cau hinh MT5_BRIDGE_URL.");
    }
    if (!options.symbol) {
      throw new Error("Chua cau hinh MT5_SYMBOL.");
    }
  }

  async getSnapshots(symbols: SymbolCode[]): Promise<MarketDataCollection> {
    const snapshots = await Promise.all(
      symbols.map((symbol) => this.getSnapshot(symbol)),
    );
    const timestamp = new Date().toISOString();
    const warnings = snapshots.flatMap((snapshot) =>
      snapshot.data_warnings.map((warning) => `${snapshot.symbol}: ${warning}`),
    );

    return {
      provider: this.name,
      timestamp,
      dataQuality: combineCollectionQuality(snapshots),
      warnings,
      snapshots,
    };
  }

  async getLatestPrice(symbol: SymbolCode): Promise<LatestMarketPrice> {
    const response = await this.fetchSnapshot();
    this.assertSymbol(symbol, response.symbol);
    if (!isFinitePositive(response.price)) {
      throw new Error(`MT5 bridge khong tra gia ${symbol} hop le.`);
    }
    return {
      symbol,
      price: response.price,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async getSnapshot(symbol: SymbolCode): Promise<MarketSnapshot> {
    const response = await this.fetchSnapshot();
    this.assertSymbol(symbol, response.symbol);

    const providerFetchedAt = new Date().toISOString();
    const quoteTime = normalizeIsoTime(response.time);
    const quoteAgeSeconds = ageInSeconds(quoteTime);
    const warnings: string[] = [];
    const informationalDiagnostics: string[] = [];
    const criticalErrors: string[] = [];
    const candles = {} as Record<Timeframe, Candle[]>;
    const filteredCandles: Partial<Record<Timeframe, number>> = {};
    const candleDiagnostics = {} as MarketSnapshot["candle_diagnostics"];
    const timeframeQuality = {} as MarketSnapshot["timeframe_quality"];

    for (const timeframe of TIMEFRAMES) {
      const rawCandles = response.candles?.[timeframe] ?? [];
      // The bridge returns oldest -> newest. The shared parser expects newest -> oldest.
      const parsed = parseProviderCandles(
        [...rawCandles].reverse().map((candle) => ({
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        })),
        timeframe,
      );
      candles[timeframe] = parsed.candles;
      filteredCandles[timeframe] = parsed.diagnostics.filteredCount;
      candleDiagnostics[timeframe] = parsed.diagnostics;

      if (parsed.candles.length === 0) {
        criticalErrors.push(`${timeframe}: MT5 bridge khong tra candle hop le.`);
      }
      if (parsed.diagnostics.filteredCount > 0) {
        informationalDiagnostics.push(
          `${timeframe}: da loc ${parsed.diagnostics.filteredCount}/${parsed.diagnostics.receivedCount} candle MT5 khong hop le.`,
        );
      }
    }

    const readiness = buildBasicReadiness(candles);
    for (const timeframe of TIMEFRAMES) {
      timeframeQuality[timeframe] = buildTimeframeQuality(
        timeframe,
        candleDiagnostics[timeframe],
        readiness[timeframe],
      );
    }

    const bidAskAvailable =
      isFinitePositive(response.bid) &&
      isFinitePositive(response.ask) &&
      response.ask > response.bid;
    const bidAskStatus: MarketSnapshot["bidAskStatus"] = bidAskAvailable
      ? "AVAILABLE"
      : "INVALID";
    if (!bidAskAvailable) {
      criticalErrors.push("MT5 bridge tra bid/ask khong hop le.");
    }
    if (!isFinitePositive(response.price)) {
      criticalErrors.push("MT5 bridge tra price khong hop le.");
    }
    if (!quoteTime) {
      criticalErrors.push("MT5 bridge tra timestamp quote khong hop le.");
    } else if (
      quoteAgeSeconds !== null &&
      quoteAgeSeconds > this.maxQuoteAgeSeconds()
    ) {
      warnings.push(
        `Quote MT5 da cu ${quoteAgeSeconds}s, vuot nguong ${this.maxQuoteAgeSeconds()}s.`,
      );
    }

    const dataQuality = aggregateMarketQuality({
      timeframeQuality,
      quoteAgeSeconds,
      maxQuoteAgeSeconds: this.maxQuoteAgeSeconds(),
      criticalErrors,
    });
    const spread = bidAskAvailable
      ? Number((response.ask - response.bid).toFixed(response.digits || 6))
      : null;

    if (this.options.debug) {
      console.info("[market:mt5]", {
        requestedSymbol: symbol,
        providerSymbol: response.symbol,
        quoteTime,
        quoteAgeSeconds,
        spread,
        spreadPoints: response.spread_points,
        timeframeQuality,
        candleDiagnostics,
      });
    }

    return {
      symbol,
      price: response.price,
      bid: bidAskAvailable ? response.bid : null,
      ask: bidAskAvailable ? response.ask : null,
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
      quoteTimestampReliable: quoteTime !== null,
      candles,
      filtered_candles: filteredCandles,
      candle_diagnostics: candleDiagnostics,
      timeframe_quality: timeframeQuality,
    };
  }

  private async fetchSnapshot(): Promise<Mt5BridgeSnapshot> {
    const url = new URL("/snapshot", this.options.bridgeUrl);
    url.searchParams.set("symbol", this.options.symbol);
    url.searchParams.set("count", String(marketCandleRequestCount));

    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(
        `Khong ket noi duoc MT5 bridge tai ${this.options.bridgeUrl}: ${reason}`,
      );
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `MT5 bridge tra HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }
    return (await response.json()) as Mt5BridgeSnapshot;
  }

  private assertSymbol(symbol: SymbolCode, providerSymbol: string): void {
    if (providerSymbol !== this.options.symbol) {
      throw new Error(
        `MT5 bridge tra symbol ${providerSymbol}, mong doi ${this.options.symbol} cho ${symbol}.`,
      );
    }
  }

  private maxQuoteAgeSeconds(): number {
    return Number.isFinite(this.options.maxQuoteAgeSeconds)
      ? Math.max(1, Number(this.options.maxQuoteAgeSeconds))
      : defaultMaxQuoteAgeSeconds;
  }
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
  timeframeQuality: MarketSnapshot["timeframe_quality"];
  quoteAgeSeconds: number | null;
  maxQuoteAgeSeconds: number;
  criticalErrors: string[];
}): DataQuality {
  if (
    input.criticalErrors.length > 0 ||
    input.quoteAgeSeconds === null ||
    input.quoteAgeSeconds > input.maxQuoteAgeSeconds ||
    Object.values(input.timeframeQuality).some((item) => item.quality === "LOW")
  ) {
    return "LOW";
  }
  if (
    Object.values(input.timeframeQuality).some(
      (item) => item.quality === "MEDIUM",
    )
  ) {
    return "MEDIUM";
  }
  return "HIGH";
}

function combineCollectionQuality(snapshots: MarketSnapshot[]): DataQuality {
  if (snapshots.some((snapshot) => snapshot.data_quality === "LOW")) {
    return "LOW";
  }
  if (snapshots.some((snapshot) => snapshot.data_quality === "MEDIUM")) {
    return "MEDIUM";
  }
  return "HIGH";
}

function normalizeIsoTime(value: string): string | null {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function ageInSeconds(isoTime: string | null): number | null {
  if (!isoTime) return null;
  const timestamp = new Date(isoTime).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 1000));
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
