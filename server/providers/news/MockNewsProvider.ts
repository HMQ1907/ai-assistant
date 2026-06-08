import type { NewsSnapshot } from '../../../types/trading'
import type { NewsProvider } from './NewsProvider'

export class MockNewsProvider implements NewsProvider {
  readonly name = 'mock'

  async getLatestNews(): Promise<NewsSnapshot> {
    const now = Date.now()

    return {
      items: [
        {
          title: 'USD traders await Fed speaker comments after mixed inflation data',
          source: 'MockMacroWire',
          publishedAt: new Date(now - 22 * 60_000).toISOString(),
          category: 'FED',
          impact: 'MEDIUM',
          sentiment: 'NEUTRAL',
          symbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD']
        },
        {
          title: 'Gold holds range as real yields stabilize',
          source: 'MockMetalsDesk',
          publishedAt: new Date(now - 38 * 60_000).toISOString(),
          category: 'GOLD',
          impact: 'MEDIUM',
          sentiment: 'NEUTRAL',
          symbols: ['XAUUSD']
        },
        {
          title: 'Crypto majors consolidate after strong prior session',
          source: 'MockCryptoFeed',
          publishedAt: new Date(now - 54 * 60_000).toISOString(),
          category: 'CRYPTO',
          impact: 'MEDIUM',
          sentiment: 'NEUTRAL',
          symbols: ['BTCUSD', 'ETHUSD']
        }
      ],
      upcomingEvents: [
        {
          title: 'US PMI preliminary release',
          scheduledAt: new Date(now + 2 * 60 * 60_000).toISOString(),
          currency: 'USD',
          impact: 'HIGH'
        }
      ]
    }
  }
}
