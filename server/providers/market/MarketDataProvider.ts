import type {
  DataQuality,
  MarketSnapshot,
  SymbolCode,
} from "../../../types/trading";

export interface SkippedSymbol {
  symbol: string;
  reason: string;
}

export interface MarketDataCollection {
  provider: string;
  timestamp: string;
  dataQuality: DataQuality;
  warnings: string[];
  skippedSymbols: SkippedSymbol[];
  snapshots: MarketSnapshot[];
}

export interface MarketDataProvider {
  readonly name: string;
  getSnapshots(symbols: SymbolCode[]): Promise<MarketDataCollection>;
}
