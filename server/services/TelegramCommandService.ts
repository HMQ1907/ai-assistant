import type { AiOrderReview } from "../../types/ai";
import { runOrderReview } from "./OrderReviewRunner";
import { TelegramService, type TelegramUpdate } from "./TelegramService";

export class TelegramCommandService {
  private running = false;

  async pollOnce(): Promise<number | undefined> {
    if (this.running) return undefined;
    this.running = true;

    try {
      const config = useRuntimeConfig();
      const telegram = new TelegramService({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
      });
      const updates = await telegram.getUpdates(globalThis.__telegramCommandOffset);
      let nextOffset = globalThis.__telegramCommandOffset;

      for (const update of updates) {
        nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
        await this.handleUpdate(update, telegram);
      }

      return nextOffset;
    } finally {
      this.running = false;
    }
  }

  private async handleUpdate(
    update: TelegramUpdate,
    telegram: TelegramService,
  ): Promise<void> {
    const config = useRuntimeConfig();
    const message = update.message;
    if (!message?.text) return;
    if (String(message.chat.id) !== String(config.telegramChatId)) return;

    const command = parseCheckCommand(message.text);
    if (!command) return;

    await telegram.sendMessage(
      [
        "Đã nhận yêu cầu check lại tín hiệu.",
        "",
        `Signal ID: ${command.id}`,
        "Mình đang lấy dữ liệu MT5 mới nhất và nhờ AI review lại. Chờ một chút nha.",
      ].join("\n"),
    );

    try {
      const output = await runOrderReview({
        id: command.id,
        userNote:
          "Người dùng yêu cầu check lại qua Telegram. Nếu không có thông tin khớp lệnh cụ thể, hãy giả định đây là lệnh/tín hiệu đang được theo dõi thủ công và nêu rõ phần nào cần tự xác minh trên Exness.",
      });
      await telegram.sendMessage(formatOrderReviewTelegram(output.review, command.id));
    } catch (error) {
      await telegram.sendMessage(
        [
          "Không check lại được tín hiệu này.",
          "",
          `Signal ID: ${command.id}`,
          `Lỗi: ${error instanceof Error ? error.message : String(error)}`,
          "",
          "Bạn kiểm tra lại ID, MT5 bridge, Gemini API và mạng giúp mình nha.",
        ].join("\n"),
      );
    }
  }
}

function parseCheckCommand(text: string): { id: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/check(?:@\w+)?\s+["']?([0-9a-fA-F-]{8,})["']?\s*$/);
  if (!match?.[1]) return null;
  return { id: match[1] };
}

function formatOrderReviewTelegram(review: AiOrderReview, signalId: string): string {
  return [
    "Kết quả check lại tín hiệu",
    "",
    `Signal ID: ${signalId}`,
    `Symbol: ${review.symbol}`,
    `Giá hiện tại: ${review.current_price}`,
    `Trạng thái lệnh: ${translateStatus(review.order_status_assessment)}`,
    `Hành động đề xuất: ${translateAction(review.recommended_action)}`,
    `Độ tin cậy review: ${review.confidence}%`,
    "",
    "Tóm tắt:",
    review.summary,
    "",
    "Đánh giá khớp lệnh:",
    review.fill_assessment,
    "",
    "Lý do hành động:",
    review.action_reason,
    "",
    "Kế hoạch SL:",
    `- ${review.stop_loss_plan.keep_current ? "Giữ SL hiện tại" : "Có thể dời SL"}`,
    `- SL đề xuất: ${review.stop_loss_plan.suggested_stop_loss ?? "Không áp dụng"}`,
    `- Lý do: ${review.stop_loss_plan.reason}`,
    "",
    "Kế hoạch TP:",
    `- ${review.take_profit_plan.keep_current ? "Giữ TP hiện tại" : "Có thể dời TP"}`,
    `- TP đề xuất: ${review.take_profit_plan.suggested_take_profit ?? "Không áp dụng"}`,
    `- Lý do: ${review.take_profit_plan.reason}`,
    "",
    "Điều kiện nên hủy / vô hiệu:",
    ...listOrFallback(review.cancellation_conditions),
    "",
    "Rủi ro cần chú ý:",
    ...listOrFallback(review.risk_warnings),
    "",
    `Gợi ý check lại sau: ${review.next_check_minutes} phút`,
    "",
    "Checklist thủ công:",
    ...listOrFallback(review.checklist),
    "",
    "Lưu ý: bot chỉ review, không tự đặt/sửa/hủy lệnh.",
  ].join("\n");
}

function listOrFallback(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- Không có mục cụ thể."];
}

function translateAction(action: AiOrderReview["recommended_action"]): string {
  const labels: Record<AiOrderReview["recommended_action"], string> = {
    KEEP_ORDER: "GIỮ LỆNH",
    CANCEL_ORDER: "HỦY LỆNH",
    MOVE_SL: "DỜI SL",
    MOVE_TP: "DỜI TP",
    MOVE_SL_TP: "DỜI SL VÀ TP",
    WAIT: "CHỜ THÊM",
    CLOSE_MANUALLY: "ĐÓNG THỦ CÔNG",
    TRADE_COMPLETED: "LỆNH ĐÃ HOÀN TẤT",
  };
  return `${labels[action]} (${action})`;
}

function translateStatus(status: AiOrderReview["order_status_assessment"]): string {
  const labels: Record<AiOrderReview["order_status_assessment"], string> = {
    LIKELY_NOT_FILLED: "CÓ KHẢ NĂNG CHƯA KHỚP",
    LIKELY_FILLED: "CÓ KHẢ NĂNG ĐÃ KHỚP",
    ALREADY_INVALIDATED: "ĐÃ BỊ VÔ HIỆU",
    UNCLEAR: "CHƯA RÕ",
  };
  return `${labels[status]} (${status})`;
}
