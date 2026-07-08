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
  // eslint-disable-next-line no-var
  var __autoTradeManagementLastSlot: string | undefined;
}

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  const autoMode = config.autoTradeEnabled;

  if (!autoMode && !config.tradeScannerEnabled) {
    console.info("[trade-loop] disabled (AUTO_TRADE=false, TRADE_SCANNER_ENABLED=false)");
    return;
  }
  // Cháº¿ Ä‘á»™ bÃ¡o tÃ­n hiá»‡u LLM cáº§n Telegram; auto-bot thÃ¬ khÃ´ng.
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

    // Tracker Ä‘o káº¿t quáº£ (cáº£ 2 cháº¿ Ä‘á»™), má»—i 5 phÃºt, Ä‘á»™c láº­p khung giá».
    if (isFiveMinSlot(now, tz)) {
      const trackerSlot = slotKey(now, tz);
      if (globalThis.__outcomeTrackerLastSlot !== trackerSlot) {
        globalThis.__outcomeTrackerLastSlot = trackerSlot;
        void outcomeTracker.trackOnce();
      }
    }

    if (autoMode) {
      // Auto-bot vòng 1: m?i 5 phút + vài giây sau n?n dóng d? scan setup m?i.
      if (isFiveMinSlot(now, tz)) {
        const autoSlot = slotKey(now, tz);
        if (globalThis.__autoTradeLastSlot !== autoSlot) {
          globalThis.__autoTradeLastSlot = autoSlot;
          void autoBot.runOnce();
        }
        return;
      }

      // Auto-bot vòng 2: m?i phút + vài giây, ch? qu?n lý l?nh dang có.
      if (isOneMinSlot(now, tz)) {
        const managementSlot = slotKey(now, tz);
        if (globalThis.__autoTradeManagementLastSlot !== managementSlot) {
          globalThis.__autoTradeManagementLastSlot = managementSlot;
          void autoBot.runManagementOnce();
        }
      }
      return;
    }

    // Cháº¿ Ä‘á»™ bÃ¡o tÃ­n hiá»‡u LLM: gá»i má»—i slot, scanOnce tá»± xá»­ lÃ½ focus/quÃ©t.
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
      `[trade-loop] AUTO-BOT enabled (Rules Engine H1) â€” entries in ${config.tradeScannerWindows || `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`} ${tz}, lots ${config.autoLotGood}/${config.autoLotVeryGood}, maxDailyLoss ${config.autoMaxDailyLossPercent}%`,
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
  return second >= 3 && second < 13 && minute % 5 === 0;
}

function isOneMinSlot(date: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    second: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(date);
  const second = Number(parts.find((part) => part.type === "second")?.value ?? 0);
  return second >= 3 && second < 13;
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

