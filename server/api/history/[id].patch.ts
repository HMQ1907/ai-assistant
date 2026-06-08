import { createError, readBody } from 'h3'
import { z } from 'zod'
import { AnalysisHistoryService } from '../../services/AnalysisHistoryService'

const bodySchema = z.object({
  result_status: z.enum(['PENDING', 'WIN', 'LOSS', 'SKIPPED']).optional(),
  user_note: z.string().max(2000).optional()
})

export default defineEventHandler(async (event) => {
  try {
    const id = Number(event.context.params?.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid history id')
    const body = bodySchema.parse(await readBody(event))
    const config = useRuntimeConfig()
    return new AnalysisHistoryService(config.databasePath).update(id, body)
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Could not update history'
    })
  }
})
