import type { AiTradeRecommendation } from "../../types/ai";
import { tradingRules } from "../config/tradingRules";
import { parseRiskReward } from "../utils/risk";
import { runRuleSignalScan } from "./RuleSignalService";
import { TelegramService } from "./TelegramService";

/**
 * Manual signal scanner: mỗi N phút (mặc định 5, sau khi nến M5 đóng) chạy
 * Rule Engine. Chỉ gửi Telegram khi có TRADE hợp lệ. Không đặt lệnh MT5.
 */
export class TradeScannerService {
  private running = false;
  private lastSignalSignature: string | null = null;
  private lastSignalAt = 0;

  async scanOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const config = useRuntimeConfig();

      if (!isInsideTradeScannerWindow()) {
        console.info("[trade-scanner] silent: ngoài khung giờ quét");
        return;
      }

      const analysis = await runRuleSignalScan({});

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
      await telegram.sendMessage(formatTelegramMarketAlert(analysis.result, analysis.history.id));
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
          "Scanner tới giờ chạy nhưng lỗi — không gửi được tín hiệu.",
          "",
          `Lỗi: ${safeMessage}`,
          "",
          "Kiểm tra: npm run mt5:bridge, MT5 terminal, Supabase, network.",
        ].join("\n"),
      );
    } catch (telegramError) {
      console.warn(
        "[trade-scanner] telegram failure notification failed:",
        telegramError instanceof Error ? telegramError.message : telegramError,
      );
    }
  }

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
    if (recommendation.decision !== "TRADE") {
      const detail = recommendation.no_trade_reason || recommendation.summary || "NO_TRADE";
      return detail.slice(0, 160);
    }
    if (recommendation.order_type !== "MARKET") {
      return `scanner sends MARKET entries only; received ${recommendation.order_type}`;
    }
    if (recommendation.direction !== "BUY" && recommendation.direction !== "SELL") {
      return "missing BUY/SELL direction";
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

/** Slot ngay sau khi nến đóng (giây 3–12) theo chu kỳ INTERVAL phút. */
export function isScannerSlot(date = new Date()): boolean {
  const config = useRuntimeConfig();
  const parts = new Intl.DateTimeFormat("en-US", {
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: config.tradeScannerTimezone,
  }).formatToParts(date);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const second = Number(parts.find((part) => part.type === "second")?.value ?? 0);
  const interval = Math.max(1, config.tradeScannerIntervalMinutes);
  return second >= 3 && second < 13 && minute % interval === 0;
}

function signalSignature(recommendation: AiTradeRecommendation): string {
  const bucket = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) return "x";
    return Math.abs(value) >= 100
      ? String(Math.round(value / 5) * 5)
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

export function formatTelegramMarketAlert(recommendation: AiTradeRecommendation, historyId: string): string {
  const action = recommendation.direction === "BUY" ? "BUY NOW" : "SELL NOW";
  const entry = recommendation.entry_zone?.from ?? recommendation.current_price;
  const lossAt001Lot = recommendation.stop_loss === null
    ? null
    : Math.abs(entry - recommendation.stop_loss) * tradingRules.xauUsdOuncesPerLot * 0.01;
  const profitAt001Lot = recommendation.take_profit === null
    ? null
    : Math.abs(recommendation.take_profit - entry) * tradingRules.xauUsdOuncesPerLot * 0.01;
  return [
    `XAUUSD — ${action}`,
    "",
    `Entry market: ${entry}`,
    `SL: ${recommendation.stop_loss}`,
    `TP: ${recommendation.take_profit}`,
    `RR: ${recommendation.risk_reward ?? `>= 1:${tradingRules.minRiskReward}`}`,
    ...(lossAt001Lot !== null && profitAt001Lot !== null
      ? [`Ước tính 0.01 lot: SL -$${lossAt001Lot.toFixed(2)} / TP +$${profitAt001Lot.toFixed(2)}`]
      : []),
    "Hiệu lực: vào ngay khi nhận; nếu đã quá 1 nến M5 hoặc giá chạy xa Entry thì bỏ.",
    "",
    `Lý do: ${recommendation.trade_reason || recommendation.summary}`,
    ...(recommendation.invalid_conditions.length
      ? ["", "Thoát/hủy nếu:", ...recommendation.invalid_conditions.map((item) => `- ${item}`)]
      : []),
    ...(recommendation.risk_factors.length
      ? ["", "Cảnh báo:", ...recommendation.risk_factors.map((item) => `- ${item}`)]
      : []),
    "",
    `Signal ID: ${historyId}`,
    "Tín hiệu đánh tay; tự kiểm tra giá chưa chạy xa Entry. Không phải cam kết lợi nhuận.",
  ].join("\n");
}

function formatTelegramAlert(recommendation: AiTradeRecommendation, historyId: string): string {
  const entry = recommendation.entry_zone
    ? `${recommendation.entry_zone.from}`
    : "N/A";
  const cancelAfter = recommendation.cancel_after_minutes
    ? `${recommendation.cancel_after_minutes} phút`
    : "Theo invalid conditions";

  return [
    "XAUUSD Rule Engine signal",
    "",
    `${recommendation.direction} ${recommendation.order_type}`,
    `RR: ${recommendation.risk_reward ?? `>= 1:${tradingRules.minRiskReward}`}`,
    `Giá hiện tại: ${recommendation.current_price}`,
    `Entry: ${entry}`,
    `SL: ${recommendation.stop_loss}`,
    `TP: ${recommendation.take_profit}`,
    `Hủy sau: ${cancelAfter}`,
    "",
    `Lý do: ${recommendation.trade_reason || recommendation.summary}`,
    "",
    "Điều kiện hủy:",
    ...(recommendation.invalid_conditions.length
      ? recommendation.invalid_conditions.map((item) => `- ${item}`)
      : ["- (không có)"]),
    "",
    ...(recommendation.risk_factors.length
      ? ["Cảnh báo:", ...recommendation.risk_factors.map((item) => `- ${item}`), ""]
      : []),
    `Signal ID: ${historyId}`,
    "Chỉ là tín hiệu — bạn tự quyết định lot và vào lệnh trên MT5.",
  ].join("\n");
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
