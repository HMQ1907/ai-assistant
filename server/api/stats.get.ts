import { createError, getQuery } from "h3";
import { z } from "zod";
import {
  AnalysisHistoryService,
  type StatsFilter,
} from "../services/AnalysisHistoryService";
import { SupabaseService } from "../services/SupabaseService";

const statsQuerySchema = z.object({
  // YYYY-MM-DD (hiểu theo múi giờ VN). Bỏ trống = toàn bộ lịch sử.
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // rule = tín hiệu từ rule engine (auto-bot + quét manual); ai = AI phân tích cũ.
  source: z.enum(["all", "rule", "ai"]).optional(),
});

export default defineEventHandler(async (event) => {
  try {
    const config = useRuntimeConfig();
    const query = statsQuerySchema.parse(getQuery(event));
    const filter: StatsFilter = {
      fromDate: query.from,
      source: query.source ?? "all",
    };
    return await new AnalysisHistoryService(
      new SupabaseService({
        url: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
      }).getClient(),
    ).stats(filter);
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage:
        error instanceof Error ? error.message : "Không tải được thống kê",
    });
  }
});
