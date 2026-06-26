import { AutoTradeRunner } from "../services/AutoTradeRunner";
import { SignalOutcomeTracker } from "../services/SignalOutcomeTracker";
import { TradeScannerService, isScannerSlot } from "../services/TradeScannerService";

declare global {
  // eslint-disable-next-line no-var
  var __tradeScannerTimer: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __tradeScannerLastSlot: string | undefined;
  // eslint-disable-next-line no-var
  var __outcomeTrackerLastSlot: string | undefined;
  // eslint-disable-next-line no-var
  var __autoTradeLastSlot: string | undefined;
}

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  const autoMode = config.autoTradeEnabled;

  if (!autoMode && !config.tradeScannerEnabled) {
    console.info("[trade-loop] disabled (AUTO_TRADE=false, TRADE_SCANNER_ENABLED=false)");
    return;
  }
  // Chế độ báo tín hiệu LLM cần Telegram; auto-bot thì không.
  if (!autoMode && (!config.telegramBotToken || !config.telegramChatId)) {
    console.warn("[trade-loop] scanner disabled: missing Telegram config");
    return;
  }
  if (globalThis.__tradeScannerTimer) {
    clearInterval(globalThis.__tradeScannerTimer);
  }

  const scanner = new TradeScannerService();
  const outcomeTracker = new SignalOutcomeTracker();
  const autoBot = new AutoTradeRunner();
  const tz = config.tradeScannerTimezone;

  globalThis.__tradeScannerTimer = setInterval(() => {
    const now = new Date();

    // Tracker đo kết quả (cả 2 chế độ), mỗi 5 phút, độc lập khung giờ.
    if (isFiveMinSlot(now, tz)) {
      const trackerSlot = slotKey(now, tz);
      if (globalThis.__outcomeTrackerLastSlot !== trackerSlot) {
        globalThis.__outcomeTrackerLastSlot = trackerSlot;
        void outcomeTracker.trackOnce();
      }
    }

    if (autoMode) {
      // Auto-bot: mỗi 5 phút (24/7 để quản lệnh; vào lệnh chỉ trong khung giờ — xử lý bên trong).
      if (isFiveMinSlot(now, tz)) {
        const autoSlot = slotKey(now, tz);
        if (globalThis.__autoTradeLastSlot !== autoSlot) {
          globalThis.__autoTradeLastSlot = autoSlot;
          void autoBot.runOnce();
        }
      }
      return;
    }

    // Chế độ báo tín hiệu LLM: gọi mỗi slot, scanOnce tự xử lý focus/quét.
    if (!isScannerSlot(now)) return;
    const slot = slotKey(now, tz);
    if (globalThis.__tradeScannerLastSlot === slot) return;
    globalThis.__tradeScannerLastSlot = slot;
    void scanner.scanOnce();
  }, 5_000);

  nitroApp.hooks.hookOnce("close", () => {
    if (globalThis.__tradeScannerTimer) {
      clearInterval(globalThis.__tradeScannerTimer);
      globalThis.__tradeScannerTimer = undefined;
    }
  });

  if (autoMode) {
    console.info(
      `[trade-loop] AUTO-BOT enabled (Rules Engine H1) — entries in ${config.tradeScannerWindows || `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`} ${tz}, lots ${config.autoLotGood}/${config.autoLotVeryGood}, maxDailyLoss ${config.autoMaxDailyLossPercent}%`,
    );
  } else {
    console.info(
      `[trade-loop] SIGNAL scanner enabled ${config.tradeScannerWindows || `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`} ${tz}, every ${config.tradeScannerIntervalMinutes}m`,
    );
  }
});

function isFiveMinSlot(date: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(date);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const second = Number(parts.find((part) => part.type === "second")?.value ?? 0);
  return second < 10 && minute % 5 === 0;
}

function slotKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}
