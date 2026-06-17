import { createError, readBody } from "h3";
import { z } from "zod";
import {
  AnalysisHistoryService,
  type HistoryUpdateInput,
} from "../../services/AnalysisHistoryService";
import { SupabaseService } from "../../services/SupabaseService";

const bodySchema = z.object({
  result_status: z
    .enum(["PENDING", "WIN", "LOSS", "BREAKEVEN", "SKIPPED"])
    .optional(),
  actual_entry: z.number().nullable().optional(),
  actual_exit: z.number().nullable().optional(),
  actual_profit_loss: z.number().nullable().optional(),
  actual_order_placed_at: z
    .preprocess(normalizeOptionalDateTime, z.string().nullable())
    .optional(),
  user_note: z.string().max(2000).optional(),
});

function normalizeOptionalDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export default defineEventHandler(async (event) => {
  try {
    const id = event.context.params?.id;
    if (!id) throw new Error("ID lịch sử không hợp lệ");
    const body = bodySchema.parse(await readBody(event));
    const update: HistoryUpdateInput = {};
    if (body.result_status !== undefined)
      update.result_status = body.result_status;
    if (body.actual_entry !== undefined)
      update.actual_entry = body.actual_entry;
    if (body.actual_exit !== undefined) update.actual_exit = body.actual_exit;
    if (body.actual_profit_loss !== undefined)
      update.actual_profit_loss = body.actual_profit_loss;
    if (body.actual_order_placed_at !== undefined)
      update.actual_order_placed_at = body.actual_order_placed_at;
    if (body.user_note !== undefined) update.user_note = body.user_note;
    const config = useRuntimeConfig();
    return await new AnalysisHistoryService(
      new SupabaseService({
        url: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
      }).getClient(),
    ).update(id, update);
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage:
        error instanceof Error ? error.message : "Không cập nhật được lịch sử",
    });
  }
});
