import { createError } from 'h3'
import { AiAnalysisService } from '../services/AiAnalysisService'
import { AnalysisHistoryService } from '../services/AnalysisHistoryService'
import { IndicatorService } from '../services/IndicatorService'
import { MarketDataService } from '../services/MarketDataService'
import { NewsService } from '../services/NewsService'
import { OpportunityPayloadBuilder } from '../services/OpportunityPayloadBuilder'

export default defineEventHandler(async () => {
  try {
    const config = useRuntimeConfig()
    const marketService = new MarketDataService(config.marketDataProvider)
    const indicatorService = new IndicatorService()
    const newsService = new NewsService(config.newsProvider)
    const payloadBuilder = new OpportunityPayloadBuilder()
    const aiService = new AiAnalysisService({
      apiKey: config.evolinkApiKey,
      model: config.evolinkModel,
      baseUrl: config.evolinkBaseUrl,
      timeoutMs: config.aiTimeoutMs
    })
    const historyService = new AnalysisHistoryService(config.databasePath)

    const market = await marketService.collectAll()
    const indicators = indicatorService.calculateMany(market)
    const news = await newsService.collect()
    const payload = payloadBuilder.build(market, indicators, news)
    const aiResult = await aiService.analyze(payload)
    const history = historyService.create({
      requestPayload: payload,
      aiResponseRaw: aiResult.raw,
      parsedResult: aiResult.parsed
    })

    return { result: aiResult.parsed, history }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Analysis failed'
    })
  }
})
