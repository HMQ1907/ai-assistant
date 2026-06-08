import type { NewsSnapshot } from "../../types/trading";
import type { NewsProvider } from "../providers/news/NewsProvider";
import { RealNewsProvider } from "../providers/news/RealNewsProvider";

export class NewsService {
  private readonly provider: NewsProvider;

  constructor(
    private readonly options: {
      providerName: string;
      apiKey: string;
      baseUrl: string;
    },
  ) {
    this.provider = this.createProvider(options.providerName);
  }

  async collect(): Promise<NewsSnapshot> {
    return this.provider.getLatestNews();
  }

  private createProvider(providerName: string): NewsProvider {
    switch (providerName) {
      case "newsapi":
        return new RealNewsProvider({
          apiKey: this.options.apiKey,
          baseUrl: this.options.baseUrl,
        });
      default:
        throw new Error(
          `Provider tin tức không được hỗ trợ hoặc chưa cấu hình: ${providerName}`,
        );
    }
  }
}
