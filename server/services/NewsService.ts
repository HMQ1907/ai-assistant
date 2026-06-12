import type { NewsSnapshot, SymbolCode } from "../../types/trading";
import type { NewsProvider } from "../providers/news/NewsProvider";
import { RealNewsProvider } from "../providers/news/RealNewsProvider";

export class NewsService {
  private readonly provider: NewsProvider;

  constructor(
    private readonly options: {
      providerName: string;
      apiKey: string;
      baseUrl: string;
      maxAgeHours?: number;
    },
  ) {
    this.provider = this.createProvider(options.providerName);
  }

  async collect(symbol: SymbolCode): Promise<NewsSnapshot> {
    return this.provider.getLatestNews(symbol);
  }

  private createProvider(providerName: string): NewsProvider {
    switch (providerName) {
      case "gnews":
        return new RealNewsProvider({
          apiKey: this.options.apiKey,
          baseUrl: this.options.baseUrl,
          ...(this.options.maxAgeHours !== undefined
            ? { maxAgeHours: this.options.maxAgeHours }
            : {}),
        });
      default:
        throw new Error(
          `Provider tin tức không được hỗ trợ hoặc chưa cấu hình: ${providerName}`,
        );
    }
  }
}
