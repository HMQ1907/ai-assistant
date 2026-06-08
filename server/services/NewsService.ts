import type { NewsSnapshot } from '../../types/trading'
import { MockNewsProvider } from '../providers/news/MockNewsProvider'
import type { NewsProvider } from '../providers/news/NewsProvider'

export class NewsService {
  private readonly provider: NewsProvider

  constructor(providerName = 'mock') {
    this.provider = this.createProvider(providerName)
  }

  async collect(): Promise<NewsSnapshot> {
    return this.provider.getLatestNews()
  }

  private createProvider(providerName: string): NewsProvider {
    switch (providerName) {
      case 'mock':
        return new MockNewsProvider()
      default:
        throw new Error(`Unsupported news provider: ${providerName}`)
    }
  }
}
