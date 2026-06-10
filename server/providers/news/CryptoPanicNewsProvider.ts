import type { NewsItem, NewsSnapshot } from "../../../types/trading";
import type { NewsProvider } from "./NewsProvider";

interface CryptoPanicResponse {
  results?: Array<{
    title?: string;
    published_at?: string;
    source?: { title?: string; domain?: string };
  }>;
}

export class CryptoPanicNewsProvider implements NewsProvider {
  readonly name = "cryptopanic";

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      maxAgeHours?: number;
    },
  ) {
    if (!options.apiKey) throw new Error("Chưa cấu hình BTC_NEWS_API_KEY.");
    if (!options.baseUrl) throw new Error("Chưa cấu hình BTC_NEWS_BASE_URL.");
  }

  async getLatestNews(): Promise<NewsSnapshot> {
    const updatedAt = new Date().toISOString();
    try {
      const url = new URL("/api/v1/posts/", this.options.baseUrl);
      url.searchParams.set("auth_token", this.options.apiKey);
      url.searchParams.set("currencies", "BTC");
      url.searchParams.set("kind", "news");
      url.searchParams.set("public", "true");

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`CryptoPanic trả HTTP ${response.status}.`);
      }
      const json = (await response.json()) as CryptoPanicResponse;
      const relevant = (json.results ?? []).filter(
        (item) => item.title && item.published_at,
      );
      const fresh = relevant.filter(
        (item) => !isStale(item.published_at ?? "", this.maxAgeHours()),
      );
      const items = fresh.slice(0, 15).map((item): NewsItem => {
        const title = item.title ?? "";
        return {
          title,
          source: item.source?.title ?? item.source?.domain ?? "CryptoPanic",
          publishedAt: item.published_at ?? updatedAt,
          category: categorize(title),
          impact: impact(title),
          sentiment: sentiment(title),
          symbols: ["BTCUSD"],
        };
      });
      const status =
        items.length > 0
          ? "AVAILABLE"
          : relevant.length > 0
            ? "STALE"
            : "NO_RELEVANT_DATA";

      return {
        items,
        upcomingEvents: [],
        status,
        provider: this.name,
        updatedAt,
        warnings:
          status === "AVAILABLE"
            ? []
            : [
                status === "STALE"
                  ? "Tin BTC nhận được đã cũ hơn ngưỡng freshness."
                  : "Không nhận được tin BTC phù hợp từ CryptoPanic.",
              ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Không lấy được tin BTC.";
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

function isStale(value: string, maxAgeHours: number): boolean {
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) ||
    (Date.now() - timestamp) / 3_600_000 > maxAgeHours;
}

function categorize(title: string): NewsItem["category"] {
  const text = title.toLowerCase();
  if (/etf|exchange-traded fund/.test(text)) return "ETF";
  if (/sec|regulat|law|ban|policy/.test(text)) return "REGULATION";
  if (/fed|rate|inflation|cpi/.test(text)) return "RATES";
  return /bitcoin|\bbtc\b/.test(text) ? "BTC" : "CRYPTO";
}

function impact(title: string): NewsItem["impact"] {
  return /etf|sec|fed|rate|inflation|hack|liquidat|regulat|ban|treasury/i.test(
    title,
  )
    ? "HIGH"
    : "MEDIUM";
}

function sentiment(title: string): NewsItem["sentiment"] {
  const bullish = /approve|approval|inflow|adoption|surge|rally|gain|buy|bull/i;
  const bearish = /reject|outflow|hack|ban|drop|fall|sell|bear|liquidat|crash/i;
  if (bullish.test(title) && !bearish.test(title)) return "BULLISH";
  if (bearish.test(title) && !bullish.test(title)) return "BEARISH";
  return "NEUTRAL";
}
