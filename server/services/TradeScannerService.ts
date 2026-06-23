import type { AiTradeRecommendation } from "../../types/ai";
import { tradingRules } from "../config/tradingRules";
import { parseRiskReward } from "../utils/risk";
import { runTradingAnalysis } from "./TradingAnalysisRunner";
import { TelegramService } from "./TelegramService";

export class TradeScannerService {
  private running = false;
  private lastSignalSignature: string | null = null;
  private lastSignalAt = 0;

  async scanOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const config = useRuntimeConfig();
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
