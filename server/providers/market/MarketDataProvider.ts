import type { MarketSnapshot, SymbolCode } from '../../../types/trading'

export interface MarketDataProvider {
  readonly name: string
  getSnapshots(symbols: SymbolCode[]): Promise<MarketSnapshot[]>
}
