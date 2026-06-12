import type { NewsSnapshot, SymbolCode } from "../../../types/trading";

export interface NewsProvider {
  readonly name: string;
  /** Lấy tin tức liên quan tới một symbol cụ thể (vàng dùng từ khóa khác EURUSD). */
  getLatestNews(symbol: SymbolCode): Promise<NewsSnapshot>;
}
