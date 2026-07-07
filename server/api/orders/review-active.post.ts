import { createError } from "h3";
import { runActiveSymbolOrderReviews } from "../../services/ActiveOrderReviewRunner";

export default defineEventHandler(async () => {
  try {
    return await runActiveSymbolOrderReviews();
  } catch (error) {
    throw createError({
      statusCode: 500,
      message:
        error instanceof Error
          ? error.message
          : "Check các lệnh đang active thất bại.",
    });
  }
});
