import { createError, getRouterParam } from "h3";
import { AnalysisHistoryService } from "../../../services/AnalysisHistoryService";
import { Mt5OrderService } from "../../../services/Mt5OrderService";
import { SupabaseService } from "../../../services/SupabaseService";

export default defineEventHandler(async (event) => {
  try {
    const id = getRouterParam(event, "id");
    if (!id) {
      throw createError({ statusCode: 400, message: "Thiếu ID lịch sử." });
    }

    const config = useRuntimeConfig();
    const historyService = new AnalysisHistoryService(
      new SupabaseService({
        url: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
      }).getClient(),
    );

    const history = await historyService.getById(id);

    if (history.mt5_ticket === null) {
      throw createError({
        statusCode: 400,
        message: "Bản ghi này chưa có lệnh trên MT5 để hủy.",
      });
    }
    if (history.order_state !== "PENDING" && history.order_state !== "FILLED") {
      throw createError({
        statusCode: 409,
        message: `Lệnh đang ở trạng thái ${history.order_state}, không thể hủy/đóng.`,
      });
    }

    const orderService = new Mt5OrderService({
      bridgeUrl: config.mt5BridgeUrl,
      symbol: config.mt5Symbol,
    });

    const cancelled = await orderService.cancelOrder(history.mt5_ticket);
    const record = await historyService.markOrderState(id, cancelled.state);

    return { record, cancelled };
  } catch (error) {
    if (isH3Error(error)) throw error;
    throw createError({
      statusCode: 500,
      message:
        error instanceof Error ? error.message : "Hủy/đóng lệnh thất bại.",
    });
  }
});

function isH3Error(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" && error !== null && "statusCode" in error
  );
}
