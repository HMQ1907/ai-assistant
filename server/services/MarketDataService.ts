import { SYMBOLS } from "../../types/trading";
import type { SymbolCode } from "../../types/trading";
import { Mt5MarketDataProvider } from "../providers/market/Mt5MarketDataProvider";
import { RealMarketDataProvider } from "../providers/market/RealMarketDataProvider";
import type {
  LatestMarketPrice,
  MarketDataCollection,
  MarketDataProvider,
} from "../providers/market/MarketDataProvider";

export class MarketDataService {
  private readonly provider: MarketDataProvider;

  constructor(
    private readonly options: {
      providerName: string;
      apiKey: string;
      baseUrl: string;
      mt5BridgeUrl?: string;
      mt5Symbol?: string;
      maxQuoteAgeSeconds?: number;
      debug?: boolean;
    },
  ) {
    this.provider = this.createProvider(options.providerName);
  }

  getDefaultSymbols(): SymbolCode[] {
    return [...SYMBOLS];
  }

  async collectAll(
    symbols: SymbolCode[] = this.getDefaultSymbols(),
  ): Promise<MarketDataCollection> {
    return this.provider.getSnapshots(symbols);
  }

  async getLatestPrice(symbol: SymbolCode = "EURUSD"): Promise<LatestMarketPrice> {
    if (!this.provider.getLatestPrice) {
      throw new Error("Provider hiện tại không hỗ trợ lấy giá riêng lẻ.");
    }
    return this.provider.getLatestPrice(symbol);
  }

  private createProvider(providerName: string): MarketDataProvider {
    switch (providerName) {
      case "twelvedata":
        return new RealMarketDataProvider({
          apiKey: this.options.apiKey,
          baseUrl: this.options.baseUrl,
          ...(this.options.maxQuoteAgeSeconds !== undefined
            ? { maxQuoteAgeSeconds: this.options.maxQuoteAgeSeconds }
            : {}),
          ...(this.options.debug !== undefined
            ? { debug: this.options.debug }
            : {}),
        });
      case "mt5":
        return new Mt5MarketDataProvider({
          bridgeUrl: this.options.mt5BridgeUrl ?? "",
          symbol: this.options.mt5Symbol ?? "EURUSD",
          ...(this.options.maxQuoteAgeSeconds !== undefined
            ? { maxQuoteAgeSeconds: this.options.maxQuoteAgeSeconds }
            : {}),
          ...(this.options.debug !== undefined
            ? { debug: this.options.debug }
            : {}),
        });
      default:
        throw new Error(
          `Provider dữ liệu thị trường không được hỗ trợ hoặc chưa cấu hình: ${providerName}`,
        );
    }
  }
}
