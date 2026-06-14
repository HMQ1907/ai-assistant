import type {
  DataQuality,
  MarketSnapshot,
  SymbolCode,
} from "../../../types/trading";

export interface MarketDataCollection {
  provider: string;
  timestamp: string;
  dataQuality: DataQuality;
  warnings: string[];
  snapshots: MarketSnapshot[];
}

export interface LatestMarketPrice {
  symbol: SymbolCode;
  price: number;
  fetchedAt: string;
}

export interface MarketDataProvider {
  readonly name: string;
  getSnapshots(symbols: SymbolCode[]): Promise<MarketDataCollection>;
  getLatestPrice?(symbol: SymbolCode): Promise<LatestMarketPrice>;
}
