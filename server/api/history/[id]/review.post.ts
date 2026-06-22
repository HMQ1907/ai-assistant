import { createError, getRouterParam, readBody } from "h3";
import { z } from "zod";
import { runOrderReview } from "../../../services/OrderReviewRunner";

const reviewRequestSchema = z.object({
  result_status: z.string().default("PENDING"),
  actual_entry: z.number().nullable().default(null),
  actual_exit: z.number().nullable().default(null),
  actual_profit_loss: z.number().nullable().default(null),
  actual_order_placed_at: z
    .preprocess(normalizeOptionalDateTime, z.string().nullable())
    .default(null),
  user_note: z.string().default(""),
});

function normalizeOptionalDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export default defineEventHandler(async (event) => {
  try {
    const id = getRouterParam(event, "id");
    if (!id) {
      throw createError({
        statusCode: 400,
        message: "Thiếu ID lịch sử cần check lại.",
      });
    }

    const body = await readBody<unknown>(event);
    const input = reviewRequestSchema.parse(body ?? {});
    const output = await runOrderReview({
      id,
      resultStatus: input.result_status,
      actualEntry: input.actual_entry,
      actualExit: input.actual_exit,
      actualProfitLoss: input.actual_profit_loss,
      actualOrderPlacedAt: input.actual_order_placed_at,
      userNote: input.user_note,
    });

    return {
      review: output.review,
      raw: output.raw,
      latestPayload: output.latestPayload,
    };
  } catch (error) {
    throw createError({
      statusCode: 500,
      message:
        error instanceof Error ? error.message : "Check lại lệnh thất bại",
    });
  }
});
