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

// GNews yêu cầu cụm nhiều từ phải bọc trong nháy kép, nếu không sẽ trả HTTP 400
// (query syntax error). Ký tự "/" (vd EUR/USD) cũng gây lỗi cú pháp nên bỏ đi,
// đã có "EURUSD" và "euro" thay thế.
const query = [
  "USD",
  "EURUSD",
  "euro",
  "ECB",
  "gold",
  '"Federal Reserve"',
  "CPI",
  "NFP",
  "PPI",
  "PMI",
  '"interest rate"',
  '"treasury yield"',
  '"geopolitical risk"',
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
        if (response.status === 429) {
          throw new Error(
            "Provider tin tức trả HTTP 429 (vượt giới hạn request của gói GNews).",
          );
        }
        const body = await response.text().catch(() => "");
        throw new Error(
          `Provider tin tức trả HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}.`,
        );
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
      // Khử trùng lặp theo title chuẩn hóa (GNews hay trả cùng tin từ nhiều nguồn).
      const seenTitles = new Set<string>();
      const uniqueArticles = freshRelevantArticles.filter((item) => {
        const key = normalizeTitle(item.article.title);
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });
      const items = uniqueArticles.flatMap((item): NewsItem[] => {
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

// Chuẩn hóa title để khử trùng lặp: bỏ dấu câu, gộp khoảng trắng, lowercase.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Tín hiệu macro/tài chính mạnh: chỉ cần xuất hiện là đủ liên quan tới XAUUSD/EURUSD.
const STRONG_MACRO =
  /(xau\b|xauusd|eurusd|eur\/usd|\becb\b|\bfed\b|federal reserve|fomc|interest rate|rate cut|rate hike|treasury yield|bond yield|\bcpi\b|\bppi\b|\bnfp\b|nonfarm|non-farm|payroll|\bpmi\b|inflation|dxy|dollar index|monetary policy|central bank)/;

// "gold" và một số từ rộng chỉ tính là liên quan khi đi kèm ngữ cảnh thị trường/giao dịch,
// nếu không sẽ lọt tin rác (gold medalist, gold heist/scam, gold jewellery...).
const BROAD_TERMS = /(gold|euro|\busd\b|geopolitical|war|conflict|safe haven)/;
const MARKET_CONTEXT =
  /(price|prices|trade|trading|trader|market|markets|spot|futures|ounce|bullion|rally|rallies|surge|plunge|fall|falls|drop|rise|rises|gain|gains|outlook|forecast|analyst|investor|investors|haven|hedge|reserve|reserves|demand|safe[- ]haven)/;

// Ngữ cảnh phi tài chính dùng chung từ khóa nhưng không liên quan tới giá vàng/USD.
const NON_FINANCIAL =
  /(medal|medalist|olympic|heist|robbery|robber|theft|stolen|steal|scam|fraud|cheat|jewellery|jewelry|jeweller|ice cream|golf|fairway|hole-in-one|wedding|ring|necklace|coast|recipe|slogan|election|festival)/;

function isRelevant(textInput: string): boolean {
  const text = textInput.toLowerCase();
  const irrelevantCrypto =
    /(staking|token|airdrop|defi|\bnft\b|memecoin|blockchain|crypto exchange)/;
  if (irrelevantCrypto.test(text)) return false;
  if (NON_FINANCIAL.test(text)) return false;

  // Tín hiệu macro mạnh -> nhận ngay.
  if (STRONG_MACRO.test(text)) return true;
  // Từ rộng (gold/euro/usd...) -> chỉ nhận khi có thêm ngữ cảnh thị trường.
  return BROAD_TERMS.test(text) && MARKET_CONTEXT.test(text);
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
  if (/ecb|euro/.test(text)) return "USD";
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
  if (!isRelevant(textInput)) return [];
  const text = textInput.toLowerCase();
  const symbols: SymbolCode[] = [];
  if (/gold|xau|xauusd|geopolitical|war|conflict/.test(text)) {
    symbols.push("XAUUSD");
  }
  if (/eurusd|eur\/usd|euro|ecb|usd|dxy|dollar|\bfed\b|fomc|cpi|nfp|ppi|pmi|inflation|payroll|unemployment|rate|yield/.test(text)) {
    symbols.push("EURUSD");
  }
  return symbols.length ? symbols : ["XAUUSD", "EURUSD"];
}
