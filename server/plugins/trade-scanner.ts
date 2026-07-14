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
  // eslint-disable-next-line no-var
  var __scalpBotLastSlot: string | undefined;
}

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  const autoMode = config.autoTradeEnabled;
  const scalpMode = autoMode && config.autoTradeScalp;

  if (!autoMode && !config.tradeScannerEnabled) {
    console.info("[trade-loop] disabled (AUTO_TRADE=false, TRADE_SCANNER_ENABLED=false)");
    return;
  }
  // Signal scanner needs Telegram; auto-bot can run without it.
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

    // Outcome tracker runs every 5 minutes, independent from entry session.
    if (isFiveMinSlot(now, tz)) {
      const trackerSlot = slotKey(now, tz);
      if (globalThis.__outcomeTrackerLastSlot !== trackerSlot) {
        globalThis.__outcomeTrackerLastSlot = trackerSlot;
        void outcomeTracker.trackOnce();
      }
    }

    if (autoMode) {
      // Scalp-bot mode: AUTO_TRADE=true + AUTO_TRADE_SCALP=true
      // Quét mỗi 1 phút bằng reversal scalp engine, không AI veto, lot 0.01.
      if (scalpMode) {
        if (isOneMinSlot(now, tz)) {
          const scalpSlot = slotKey(now, tz);
          if (globalThis.__scalpBotLastSlot !== scalpSlot) {
            globalThis.__scalpBotLastSlot = scalpSlot;
            void autoBot.runScalpOnce();
          }
        }
        return;
      }

      // Auto-bot loop 1: every 5 minutes + a few seconds after candle close.
      if (isFiveMinSlot(now, tz)) {
        const autoSlot = slotKey(now, tz);
        if (globalThis.__autoTradeLastSlot !== autoSlot) {
          globalThis.__autoTradeLastSlot = autoSlot;
          void autoBot.runOnce();
        }
        return;
      }

      // Auto-bot loop 2: every minute, manage active orders / pending setup only.
      if (isOneMinSlot(now, tz)) {
        const managementSlot = slotKey(now, tz);
        if (globalThis.__autoTradeManagementLastSlot !== managementSlot) {
          globalThis.__autoTradeManagementLastSlot = managementSlot;
          void autoBot.runManagementOnce();
        }
      }
      return;
    }

    // LLM signal scanner mode.
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

  if (scalpMode) {
    console.info(
      `[trade-loop] AUTO-SCALP enabled (Reversal Scalp M1/M5/M15/H1, no AI veto) - entries in ${config.tradeScannerWindows || `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`} ${tz}, lot ${config.autoLotGood}, TP ${config.autoScalpTpR}R, maxOpen ${config.autoScalpMaxOpenTrades}, max/day ${config.autoMaxTradesPerDay}, maxHold ${config.autoScalpMaxHoldMinutes}m`,
    );
  } else if (autoMode) {
    console.info(
      `[trade-loop] AUTO-BOT enabled (Rules Engine H1) - entries in ${config.tradeScannerWindows || `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`} ${tz}, lots ${config.autoLotGood}/${config.autoLotVeryGood}, maxDailyLoss ${config.autoMaxDailyLossPercent}%`,
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
