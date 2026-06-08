import type { MarketSnapshot, SymbolCode } from '../../types/trading'
import { SYMBOLS } from '../../types/trading'
import { MockMarketDataProvider } from '../providers/market/MockMarketDataProvider'
import type { MarketDataProvider } from '../providers/market/MarketDataProvider'

export class MarketDataService {
  private readonly provider: MarketDataProvider

  constructor(providerName = 'mock') {
    this.provider = this.createProvider(providerName)
  }

  getDefaultSymbols(): SymbolCode[] {
    return [...SYMBOLS]
  }

  async collectAll(symbols: SymbolCode[] = this.getDefaultSymbols()): Promise<MarketSnapshot[]> {
    return this.provider.getSnapshots(symbols)
  }

  private createProvider(providerName: string): MarketDataProvider {
    switch (providerName) {
      case 'mock':
        return new MockMarketDataProvider()
      default:
        throw new Error(`Unsupported market data provider: ${providerName}`)
    }
  }
}
