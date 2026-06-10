import { createError, getQuery } from "h3";
import { AnalysisHistoryService } from "../services/AnalysisHistoryService";
import { SupabaseService } from "../services/SupabaseService";

export default defineEventHandler(async (event) => {
  try {
    const config = useRuntimeConfig();
    const symbol = parseSymbol(getQuery(event).symbol);
    return await new AnalysisHistoryService(
      new SupabaseService({
        url: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
      }).getClient(),
    ).list(symbol);
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage:
        error instanceof Error ? error.message : "Không tải được lịch sử",
    });
  }
});

function parseSymbol(value: unknown): "XAUUSD" | "BTCUSD" | undefined {
  return value === "XAUUSD" || value === "BTCUSD" ? value : undefined;
}
