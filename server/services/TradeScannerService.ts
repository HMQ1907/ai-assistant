import type { AiOrderReview, AiTradeRecommendation, OrderReviewAction } from "../../types/ai";
import type { ActiveMt5Order } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { parseRiskReward } from "../utils/risk";
import { runActiveXauUsdOrderReviews } from "./ActiveOrderReviewRunner";
import { Mt5OrderService } from "./Mt5OrderService";
import { runTradingAnalysis } from "./TradingAnalysisRunner";
import { TelegramService } from "./TelegramService";

export class TradeScannerService {
  private running = false;
  private lastSignalSignature: string | null = null;
  private lastSignalAt = 0;
  // Focus mode: khi dang co lenh tren MT5, theo doi lenh do thay vi quet tin hieu moi.
  private focusLastReviewAt = 0;
  private focusNextCheckMin = 0;
  private readonly focusSentSignatures = new Map<number, string>();

  async scanOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const config = useRuntimeConfig();

      // 1) Co lenh XAUUSD dang cho/dang mo tren MT5 chua? (probe re, khong goi AI)
      let activeOrders: ActiveMt5Order[] = [];
      try {
        activeOrders = await new Mt5OrderService({
          bridgeUrl: config.mt5BridgeUrl,
          symbol: config.mt5Symbol,
        }).getActiveOrders();
      } catch (error) {
        console.warn(
          "[trade-scanner] focus probe failed, fallback to scan:",
          error instanceof Error ? error.message : error,
        );
      }

      // 2) Co lenh -> focus theo doi lenh do, KHONG quet tin hieu moi (chay ca ngoai khung gio).
      if (activeOrders.length > 0) {
        await this.monitorActiveOrders(config);
        return;
      }
      this.resetFocus();

      // 3) Khong co lenh: chi quet tim setup moi trong khung gio cho phep.
      if (!isInsideTradeScannerWindow()) {
        console.info("[trade-scanner] silent: ngoài khung giờ quét");
        return;
      }

      const analysis = await runTradingAnalysis({
        symbol: "XAUUSD",
        accountSizeUsd: config.accountSizeUsd,
      });

      const reason = this.rejectReason(analysis.result);
      if (reason) {
        console.info(`[trade-scanner] silent: ${reason}`);
        return;
      }

      if (this.isDuplicateSignal(analysis.result, config.tradeScannerDedupMinutes)) {
        console.info("[trade-scanner] silent: duplicate of last setup within dedup window");
        return;
      }

      const telegram = new TelegramService({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
      });
      await telegram.sendMessage(formatTelegramAlert(analysis.result, analysis.history.id));
      await telegram.sendMessage(formatCheckCommand(analysis.history.id));
      console.info("[trade-scanner] telegram alert sent");
    } catch (error) {
      await this.notifyFailure(error);
      console.warn(
        "[trade-scanner] scan failed:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.running = false;
    }
  }

  private async notifyFailure(error: unknown): Promise<void> {
    const config = useRuntimeConfig();
    if (!config.telegramBotToken || !config.telegramChatId) return;

    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message.replace(/\s+/g, " ").slice(0, 800);

    try {
      await new TelegramService({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
      }).sendMessage(
        [
          "XAUUSD scanner error",
          "",
          "Scanner đang tới giờ chạy nhưng bị lỗi, nên không tạo được tín hiệu.",
          "",
          `Lỗi: ${safeMessage}`,
          "",
          "Kiểm tra lại npm run mt5:bridge, MT5 terminal, Gemini/Evolink API key hoặc network.",
        ].join("\n"),
      );
    } catch (telegramError) {
      console.warn(
        "[trade-scanner] telegram failure notification failed:",
        telegramError instanceof Error ? telegramError.message : telegramError,
      );
    }
  }

  // Focus mode: review cac lenh dang active, day Telegram "nen lam gi tiep".
  // Gian nhip goi AI theo next_check_minutes de tiet kiem quota.
  private async monitorActiveOrders(config: {
    telegramBotToken: string;
    telegramChatId: string;
  }): Promise<void> {
    const now = Date.now();
    if (
      this.focusLastReviewAt > 0 &&
      now - this.focusLastReviewAt < this.focusNextCheckMin * 60_000
    ) {
      console.info("[trade-scanner] focus: chưa tới giờ review lại lệnh");
      return;
    }

    const { reviews } = await runActiveXauUsdOrderReviews();
    if (reviews.length === 0) return;

    this.focusLastReviewAt = now;
    this.focusNextCheckMin = Math.max(
      5,
      Math.min(...reviews.map((item) => item.review.next_check_minutes || 15)),
    );

    const telegram = new TelegramService({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
    });

    for (const item of reviews) {
      const signature = reviewSignature(item.review);
      const actionable = isActionableReview(item.review.recommended_action);
      // Khuyen nghi can hanh dong -> luon bao. Khong thi chi bao khi loi khuyen DOI.
      if (!actionable && this.focusSentSignatures.get(item.order.ticket) === signature) {
        continue;
      }
      this.focusSentSignatures.set(item.order.ticket, signature);
      await telegram.sendMessage(formatActiveOrderAlert(item.order, item.review));
    }
    console.info(`[trade-scanner] focus: reviewed ${reviews.length} active order(s)`);
  }

  private resetFocus(): void {
    this.focusLastReviewAt = 0;
    this.focusNextCheckMin = 0;
    this.focusSentSignatures.clear();
  }

  // Cung mot setup H1 song nhieu gio nen se hien ra o nhieu lan quet lien tiep.
  // Chi bao mot lan trong cua so dedup; setup moi/doi (huong, entry, SL khac) thi bao lai.
  private isDuplicateSignal(
    recommendation: AiTradeRecommendation,
    dedupMinutes: number,
  ): boolean {
    const signature = signalSignature(recommendation);
    const now = Date.now();
    const withinWindow =
      this.lastSignalSignature === signature &&
      now - this.lastSignalAt < dedupMinutes * 60_000;

    this.lastSignalSignature = signature;
    this.lastSignalAt = now;
    return withinWindow;
  }

  private rejectReason(recommendation: AiTradeRecommendation): string | null {
    const config = useRuntimeConfig();
    if (recommendation.decision !== "TRADE") return "NO_TRADE";
    if (recommendation.confidence < config.tradeScannerMinConfidence) {
      return `confidence ${recommendation.confidence} < ${config.tradeScannerMinConfidence}`;
    }
    if (
      (recommendation.estimated_win_probability ?? recommendation.confidence) <
      config.tradeScannerMinWinProbability
    ) {
      return `win probability ${
        recommendation.estimated_win_probability ?? recommendation.confidence
      } < ${config.tradeScannerMinWinProbability}`;
    }
    const riskReward = parseRiskReward(recommendation.risk_reward ?? "");
    if (riskReward < config.tradeScannerMinRiskReward) {
      return `RR ${recommendation.risk_reward} < 1:${config.tradeScannerMinRiskReward}`;
    }
    if (recommendation.trade_validation_failures?.length) {
      return "validation failures present";
    }
    if (!recommendation.entry_zone || !recommendation.stop_loss || !recommendation.take_profit) {
      return "missing entry/sl/tp";
    }
    return null;
  }
}

export function isInsideTradeScannerWindow(date = new Date()): boolean {
  const config = useRuntimeConfig();
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.tradeScannerTimezone,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const currentMinutes = hour * 60 + minute;
  const windows = parseTradeScannerWindows(config.tradeScannerWindows);

  if (windows.length > 0) {
    return windows.some(
      (window) =>
        currentMinutes >= window.startMinutes &&
        currentMinutes < window.endMinutes,
    );
  }

  return (
    currentMinutes >= config.tradeScannerStartHour * 60 &&
    currentMinutes < config.tradeScannerEndHour * 60
  );
}

export function isScannerSlot(date = new Date()): boolean {
  const config = useRuntimeConfig();
  const parts = new Intl.DateTimeFormat("en-US", {
    minute: "2-digit",
    second: "2-digit",
    timeZone: config.tradeScannerTimezone,
  }).formatToParts(date);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const second = Number(parts.find((part) => part.type === "second")?.value ?? 0);
  return second < 10 && minute % config.tradeScannerIntervalMinutes === 0;
}

const ACTION_LABEL: Record<OrderReviewAction, string> = {
  KEEP_ORDER: "Giữ nguyên lệnh",
  CANCEL_ORDER: "HỦY lệnh chờ",
  MOVE_SL: "Dời Stop Loss",
  MOVE_TP: "Dời Take Profit",
  MOVE_SL_TP: "Dời cả SL và TP",
  WAIT: "Chờ thêm",
  CLOSE_MANUALLY: "ĐÓNG lệnh thủ công",
  TRADE_COMPLETED: "Lệnh đã kết thúc",
};

const STATUS_LABEL: Record<string, string> = {
  LIKELY_NOT_FILLED: "Nhiều khả năng chưa khớp",
  LIKELY_FILLED: "Nhiều khả năng đã khớp",
  ALREADY_INVALIDATED: "Setup đã bị vô hiệu",
  UNCLEAR: "Chưa rõ",
};

function isActionableReview(action: OrderReviewAction): boolean {
  return (
    action === "CANCEL_ORDER" ||
    action === "CLOSE_MANUALLY" ||
    action === "MOVE_SL" ||
    action === "MOVE_TP" ||
    action === "MOVE_SL_TP" ||
    action === "TRADE_COMPLETED"
  );
}

function reviewSignature(review: AiOrderReview): string {
  return [
    review.recommended_action,
    review.order_status_assessment,
    review.stop_loss_plan.suggested_stop_loss ?? "x",
    review.take_profit_plan.suggested_take_profit ?? "x",
  ].join("|");
}

function formatActiveOrderAlert(order: ActiveMt5Order, review: AiOrderReview): string {
  const lines = [
    `XAUUSD theo dõi lệnh #${order.ticket}`,
    "",
    `${order.direction} ${order.type} @ ${order.price_open}`,
    `Trạng thái: ${STATUS_LABEL[review.order_status_assessment] ?? review.order_status_assessment}`,
    `Khuyến nghị: ${ACTION_LABEL[review.recommended_action] ?? review.recommended_action}`,
    "",
    review.action_reason || review.summary,
  ];

  if (!review.stop_loss_plan.keep_current && review.stop_loss_plan.suggested_stop_loss !== null) {
    lines.push(`SL đề xuất: ${review.stop_loss_plan.suggested_stop_loss} (${review.stop_loss_plan.reason})`);
  }
  if (!review.take_profit_plan.keep_current && review.take_profit_plan.suggested_take_profit !== null) {
    lines.push(`TP đề xuất: ${review.take_profit_plan.suggested_take_profit} (${review.take_profit_plan.reason})`);
  }
  if (review.cancellation_conditions.length > 0) {
    lines.push("", "Điều kiện hủy:");
    lines.push(...review.cancellation_conditions.map((item) => `- ${item}`));
  }

  lines.push("", `Check lại sau: ${review.next_check_minutes} phút`);
  lines.push("Đây là theo dõi tự động lệnh bạn đang ôm, không phải lệnh tự động.");
  return lines.join("\n");
}

function signalSignature(recommendation: AiTradeRecommendation): string {
  const bucket = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) return "x";
    // Vang gom theo $1, cap nho (EURUSD) theo 0.0010 — chenh nho hon coi la cung setup.
    return Math.abs(value) >= 100
      ? String(Math.round(value))
      : String(Math.round(value * 1000) / 1000);
  };
  return [
    recommendation.direction,
    recommendation.order_type,
    bucket(recommendation.entry_zone?.from ?? null),
    bucket(recommendation.entry_zone?.to ?? null),
    bucket(recommendation.stop_loss),
  ].join("|");
}

function formatTelegramAlert(recommendation: AiTradeRecommendation, historyId: string): string {
  const entry = recommendation.entry_zone
    ? `${recommendation.entry_zone.from} - ${recommendation.entry_zone.to}`
    : "N/A";
  const winProbability =
    recommendation.estimated_win_probability ?? recommendation.confidence;
  const cancelAfter = recommendation.cancel_after_minutes
    ? `${recommendation.cancel_after_minutes} phút`
    : "Theo invalid conditions";

  return [
    "XAUUSD setup alert",
    "",
    `${recommendation.direction} ${recommendation.order_type}`,
    `Confidence: ${recommendation.confidence}%`,
    `Win probability: ${winProbability}%`,
    `RR: ${recommendation.risk_reward ?? `>= 1:${tradingRules.minRiskReward}`}`,
    `Current: ${recommendation.current_price}`,
    `Entry: ${entry}`,
    `SL: ${recommendation.stop_loss}`,
    `TP: ${recommendation.take_profit}`,
    `Cancel after: ${cancelAfter}`,
    "",
    `Lý do: ${recommendation.trade_reason || recommendation.summary}`,
    "",
    "Điều kiện hủy:",
    ...recommendation.invalid_conditions.map((item) => `- ${item}`),
    "",
    `Signal ID: ${historyId}`,
    "Đây là alert để bạn tự duyệt, không phải lệnh tự động.",
  ].join("\n");
}

function formatCheckCommand(historyId: string): string {
  return `/check "${historyId}"`;
}

function parseTradeScannerWindows(
  value: string,
): Array<{ startMinutes: number; endMinutes: number }> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [start, end] = item.split("-").map((part) => part?.trim());
      const startMinutes = parseClockMinutes(start ?? "");
      const endMinutes = parseClockMinutes(end ?? "");
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        return null;
      }
      return { startMinutes, endMinutes };
    })
    .filter((item): item is { startMinutes: number; endMinutes: number } => item !== null);
}

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}
