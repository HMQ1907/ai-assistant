import type {
  NewsItem,
  NewsSnapshot,
  SymbolCode,
} from "../../../types/trading";
import type { NewsProvider } from "./NewsProvider";

interface NewsApiResponse {
  status?: string;
  message?: string;
  articles?: Array<{
    source?: { name?: string };
    title?: string;
    description?: string;
    publishedAt?: string;
  }>;
}

const query = [
  "USD",
  "gold",
  "XAUUSD",
  "Federal Reserve",
  "CPI",
  "NFP",
  "PPI",
  "PMI",
  "interest rate",
  "geopolitical risk",
].join(" OR ");

export class RealNewsProvider implements NewsProvider {
  readonly name = "newsapi";

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
    },
  ) {
    if (!options.apiKey) {
      throw new Error("Chưa cấu hình NEWS_API_KEY cho tin tức thật.");
    }
    if (!options.baseUrl) {
      throw new Error("Chưa cấu hình NEWS_BASE_URL cho tin tức thật.");
    }
  }

  async getLatestNews(): Promise<NewsSnapshot> {
    const updatedAt = new Date().toISOString();
    try {
      const url = new URL("/v2/everything", this.options.baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("language", "en");
      url.searchParams.set("sortBy", "publishedAt");
      url.searchParams.set("pageSize", "30");
      url.searchParams.set("apiKey", this.options.apiKey);

      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Provider tin tức trả HTTP ${response.status}.`);
      const json = (await response.json()) as NewsApiResponse;
      if (json.status === "error")
        throw new Error(json.message || "Provider tin tức trả lỗi.");

      const items = (json.articles ?? []).flatMap((article): NewsItem[] => {
        if (!article.title || !article.publishedAt) return [];
        return [
          {
            title: article.title,
            source: article.source?.name ?? "Provider tin tức",
            publishedAt: article.publishedAt,
            category: categorize(article.title, article.description ?? ""),
            impact: impact(article.title, article.description ?? ""),
            sentiment: "NEUTRAL",
            symbols: symbolsFor(article.title, article.description ?? ""),
          },
        ];
      });

      return {
        items,
        upcomingEvents: [],
        status: items.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
        provider: this.name,
        updatedAt,
        warnings:
          items.length > 0
            ? ["Provider hiện tại không hỗ trợ lịch tin mạnh sắp tới."]
            : ["Không nhận được tin tức hợp lệ từ provider."],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Không lấy được tin tức thật.";
      console.warn(`[news:${this.name}] ${message}`);
      return {
        items: [],
        upcomingEvents: [],
        status: "UNAVAILABLE",
        provider: this.name,
        updatedAt,
        warnings: [message],
      };
    }
  }
}

function categorize(title: string, description: string): NewsItem["category"] {
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes("fed") || text.includes("federal reserve")) return "FED";
  if (text.includes("cpi") || text.includes("inflation")) return "CPI";
  if (text.includes("nfp") || text.includes("payroll")) return "NFP";
  if (text.includes("ppi")) return "PPI";
  if (text.includes("pmi")) return "PMI";
  if (text.includes("rate")) return "RATES";
  if (text.includes("war") || text.includes("geopolitical"))
    return "GEOPOLITICAL";
  if (text.includes("gold") || text.includes("xau")) return "GOLD";
  return "USD";
}

function impact(title: string, description: string): NewsItem["impact"] {
  const text = `${title} ${description}`.toLowerCase();
  if (/(fed|federal reserve|cpi|nfp|payroll|rate|war|geopolitical)/.test(text))
    return "HIGH";
  if (/(ppi|pmi|inflation|gold|xau)/.test(text)) return "MEDIUM";
  return "LOW";
}

function symbolsFor(title: string, description: string): SymbolCode[] {
  const text = `${title} ${description}`.toLowerCase();
  if (/(gold|xau|usd|fed|cpi|nfp|ppi|pmi|rate|geopolitical)/.test(text)) {
    return ["XAUUSD"];
  }
  return [];
}
