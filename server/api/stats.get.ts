import { createError } from "h3";
import { AnalysisHistoryService } from "../services/AnalysisHistoryService";
import { SupabaseService } from "../services/SupabaseService";

export default defineEventHandler(async () => {
  try {
    const config = useRuntimeConfig();
    return await new AnalysisHistoryService(
      new SupabaseService({
        url: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
      }).getClient(),
    ).stats();
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage:
        error instanceof Error ? error.message : "Could not load stats",
    });
  }
});
