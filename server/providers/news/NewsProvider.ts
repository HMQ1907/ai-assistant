import type { NewsSnapshot } from '../../../types/trading'

export interface NewsProvider {
  readonly name: string
  getLatestNews(): Promise<NewsSnapshot>
}
