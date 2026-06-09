import type {
  NewsItem,
  NewsSnapshot,
  SymbolCode,
} from "../../../types/trading";
import type { NewsProvider } from "./NewsProvider";

interface GNewsResponse {
  totalArticles?: number;
  articles?: Array<{
    source?: { name?: string; url?: string };
    title?: string;
    description?: string;
    publishedAt?: string;
  }>;
  errors?: string[];
}

const query = [
  "USD",
  "gold",
  "Federal Reserve",
  "CPI",
  "NFP",
  "PPI",
  "PMI",
  "interest rate",
  "treasury yield",
  "geopolitical risk",
].join(" OR ");

export class RealNewsProvider implements NewsProvider {
  readonly name = "gnews";

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      maxAgeHours?: number;
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
      const url = new URL("/api/v4/search", this.options.baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("lang", "en");
      url.searchParams.set("sortby", "publishedAt");
      url.searchParams.set("max", "10");
      url.searchParams.set("apikey", this.options.apiKey);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Provider tin tức trả HTTP ${response.status}.`);
      }
      const json = (await response.json()) as GNewsResponse;
      if (json.errors?.length) {
        throw new Error(json.errors[0] ?? "Provider tin tức trả lỗi.");
      }

      const maxAgeHours = this.maxAgeHours();
      const articles = json.articles ?? [];
      const relevantArticles = articles.flatMap((article) => {
        if (!article.title || !article.publishedAt) return [];
        const text = `${article.title} ${article.description ?? ""}`;
        return isRelevant(text)
          ? [
              {
                article: {
                  title: article.title,
                  source: article.source,
                  publishedAt: article.publishedAt,
                },
                text,
              },
            ]
          : [];
      });
      const freshRelevantArticles = relevantArticles.filter(
        (item) => !isStale(item.article.publishedAt, maxAgeHours),
      );
      const staleRelevantCount =
        relevantArticles.length - freshRelevantArticles.length;
      const items = freshRelevantArticles.flatMap((item): NewsItem[] => {
        return [
          {
            title: item.article.title,
            source: item.article.source?.name ?? "GNews",
            publishedAt: item.article.publishedAt,
            category: categorize(item.text),
            impact: impact(item.text),
            sentiment: sentiment(item.text),
            symbols: symbolsFor(item.text),
          },
        ];
      });
      const status =
        items.length > 0
          ? "AVAILABLE"
          : staleRelevantCount > 0
            ? "STALE"
            : "NO_RELEVANT_DATA";

      return {
        items,
        upcomingEvents: [],
        status,
        provider: this.name,
        updatedAt,
        warnings:
          items.length > 0
            ? [
                "Provider hiện tại không xác nhận lịch CPI, NFP, FOMC hoặc các sự kiện kinh tế mạnh sắp tới.",
              ]
            : [
                status === "STALE"
                  ? "Chỉ nhận được tin liên quan nhưng đã cũ hơn ngưỡng freshness."
                  : "Không nhận được tin tức mới và liên quan trực tiếp đến XAUUSD/USD/Fed/CPI/NFP.",
                "Provider hiện tại không xác nhận lịch CPI, NFP, FOMC hoặc các sự kiện kinh tế mạnh sắp tới.",
              ],
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Không lấy được tin tức thật.";
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

  private maxAgeHours(): number {
    return Number.isFinite(this.options.maxAgeHours)
      ? Math.max(1, Number(this.options.maxAgeHours))
      : 48;
  }
}

function isRelevant(textInput: string): boolean {
  const text = textInput.toLowerCase();
  const relevant =
    /(gold|xau|xauusd|usd|dxy|dollar|federal reserve|\bfed\b|fomc|interest rate|treasury yield|yield|cpi|ppi|inflation|nfp|payroll|unemployment|geopolitical|war|conflict)/;
  const irrelevantCrypto =
    /(staking|token|airdrop|defi|nft|memecoin|blockchain|crypto exchange)/;
  return relevant.test(text) && !irrelevantCrypto.test(text);
}

function isStale(publishedAt: string, maxAgeHours: number): boolean {
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return true;
  const ageHours = (Date.now() - published.getTime()) / 3_600_000;
  return ageHours > maxAgeHours;
}

function categorize(textInput: string): NewsItem["category"] {
  const text = textInput.toLowerCase();
  if (/\bfed\b|federal reserve|fomc/.test(text)) return "FED";
  if (/cpi|inflation/.test(text)) return "CPI";
  if (/nfp|payroll|jobs report/.test(text)) return "NFP";
  if (/ppi/.test(text)) return "PPI";
  if (/pmi/.test(text)) return "PMI";
  if (/rate|yield|treasury/.test(text)) return "RATES";
  if (/war|geopolitical|conflict/.test(text)) return "GEOPOLITICAL";
  if (/gold|xau/.test(text)) return "GOLD";
  return "USD";
}

function impact(textInput: string): NewsItem["impact"] {
  const text = textInput.toLowerCase();
  if (
    /(\bfed\b|federal reserve|fomc|cpi|nfp|payroll|interest rate|treasury yield|war|geopolitical|conflict)/.test(
      text,
    )
  ) {
    return "HIGH";
  }
  if (/(ppi|pmi|inflation|gold|xau|dxy|dollar)/.test(text)) return "MEDIUM";
  return "LOW";
}

function sentiment(textInput: string): NewsItem["sentiment"] {
  const text = textInput.toLowerCase();
  const bullishGold =
    /(rate cut|cuts rates|dovish|weaker dollar|dollar falls|usd falls|yields fall|recession|safe haven|geopolitical|war|conflict|gold rises|gold gains|inflation cools)/;
  const bearishGold =
    /(rate hike|higher rates|hawkish|stronger dollar|dollar rises|usd rises|yields rise|hot inflation|sticky inflation|gold falls|gold drops|risk-on|payrolls beat|jobs beat)/;

  if (bullishGold.test(text) && !bearishGold.test(text)) return "BULLISH";
  if (bearishGold.test(text) && !bullishGold.test(text)) return "BEARISH";
  return "NEUTRAL";
}

function symbolsFor(textInput: string): SymbolCode[] {
  return isRelevant(textInput) ? ["XAUUSD"] : [];
}
