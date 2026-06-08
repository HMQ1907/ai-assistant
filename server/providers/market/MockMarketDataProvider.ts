import type { Candle, MarketSnapshot, SymbolCode, Timeframe } from '../../../types/trading'
import { TIMEFRAMES } from '../../../types/trading'
import type { MarketDataProvider } from './MarketDataProvider'

const basePrices: Record<SymbolCode, number> = {
  XAUUSD: 2325,
  BTCUSD: 68200,
  ETHUSD: 3650,
  EURUSD: 1.086,
  GBPUSD: 1.274,
  USDJPY: 157.2,
  USDCHF: 0.898,
  USDCAD: 1.372,
  AUDUSD: 0.662,
  NAS100: 19050,
  US30: 38800
}

const timeframeMinutes: Record<Timeframe, number> = {
  M5: 5,
  M15: 15,
  H1: 60,
  H4: 240
}

export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = 'mock'

  async getSnapshots(symbols: SymbolCode[]): Promise<MarketSnapshot[]> {
    return symbols.map((symbol, index) => this.createSnapshot(symbol, index))
  }

  private createSnapshot(symbol: SymbolCode, index: number): MarketSnapshot {
    const base = basePrices[symbol]
    const candles = Object.fromEntries(
      TIMEFRAMES.map((timeframe) => [timeframe, this.createCandles(symbol, base, timeframe, index)])
    ) as MarketSnapshot['candles']
    const lastClose = candles.M5.at(-1)?.close ?? base
    const spread = this.spreadFor(symbol, lastClose)

    return {
      symbol,
      price: round(lastClose, precisionFor(symbol)),
      bid: round(lastClose - spread / 2, precisionFor(symbol)),
      ask: round(lastClose + spread / 2, precisionFor(symbol)),
      spread: round(spread, precisionFor(symbol)),
      candles
    }
  }

  private createCandles(symbol: SymbolCode, base: number, timeframe: Timeframe, index: number): Candle[] {
    const minutes = timeframeMinutes[timeframe]
    const precision = precisionFor(symbol)
    const now = Date.now()
    let previousClose = base * (1 + Math.sin(index + minutes) * 0.002)

    return Array.from({ length: 140 }, (_, i) => {
      const phase = i / 9 + index
      const trend = (i - 70) * base * 0.000015 * (index % 3 === 0 ? -1 : 1)
      const wave = Math.sin(phase) * base * 0.0018
      const close = base + trend + wave
      const open = previousClose
      const high = Math.max(open, close) + base * (0.0007 + (i % 5) * 0.00008)
      const low = Math.min(open, close) - base * (0.0007 + (i % 7) * 0.00006)
      previousClose = close

      return {
        time: new Date(now - (139 - i) * minutes * 60_000).toISOString(),
        open: round(open, precision),
        high: round(high, precision),
        low: round(low, precision),
        close: round(close, precision),
        volume: Math.round(900 + Math.abs(Math.sin(phase)) * 1700)
      }
    })
  }

  private spreadFor(symbol: SymbolCode, price: number): number {
    if (symbol.includes('JPY')) return 0.018
    if (symbol.endsWith('USD') && symbol.length === 6 && !symbol.startsWith('BTC') && !symbol.startsWith('ETH')) return 0.00016
    if (symbol === 'XAUUSD') return 0.22
    if (symbol === 'BTCUSD') return price * 0.00045
    if (symbol === 'ETHUSD') return price * 0.00055
    return price * 0.00018
  }
}

function precisionFor(symbol: SymbolCode): number {
  if (symbol.includes('JPY')) return 3
  if (symbol.endsWith('USD') && symbol.length === 6 && !symbol.startsWith('BTC') && !symbol.startsWith('ETH')) return 5
  if (symbol === 'XAUUSD') return 2
  return 2
}

function round(value: number, precision: number): number {
  return Number(value.toFixed(precision))
}
