import { SYMBOLS } from "../../types/trading";
import type { SymbolCode } from "../../types/trading";
import { RealMarketDataProvider } from "../providers/market/RealMarketDataProvider";
import type {
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

  private createProvider(providerName: string): MarketDataProvider {
    switch (providerName) {
      case "twelvedata":
        return new RealMarketDataProvider({
          apiKey: this.options.apiKey,
          baseUrl: this.options.baseUrl,
        });
      default:
        throw new Error(
          `Provider dữ liệu thị trường không được hỗ trợ hoặc chưa cấu hình: ${providerName}`,
        );
    }
  }
}
