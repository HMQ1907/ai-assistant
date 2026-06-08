import { createError } from 'h3'
import { AnalysisHistoryService } from '../services/AnalysisHistoryService'

export default defineEventHandler(() => {
  try {
    const config = useRuntimeConfig()
    return new AnalysisHistoryService(config.databasePath).list()
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not load history'
    })
  }
})
