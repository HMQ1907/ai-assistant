import { SignalOutcomeTracker } from "../services/SignalOutcomeTracker";
import { TradeScannerService, isScannerSlot } from "../services/TradeScannerService";

declare global {
  // eslint-disable-next-line no-var
  var __tradeScannerTimer: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __tradeScannerLastSlot: string | undefined;
  // eslint-disable-next-line no-var
  var __outcomeTrackerLastSlot: string | undefined;
}

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  if (!config.tradeScannerEnabled) {
    console.info("[trade-scanner] disabled");
    return;
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn("[trade-scanner] disabled: missing Telegram config");
    return;
  }
  if (globalThis.__tradeScannerTimer) {
    clearInterval(globalThis.__tradeScannerTimer);
  }

  const scanner = new TradeScannerService();
  const outcomeTracker = new SignalOutcomeTracker();
  globalThis.__tradeScannerTimer = setInterval(() => {
    const now = new Date();

    // Tracker chay doc lap voi khung gio trade: lenh vao luc 21h co the resolve luc 23h
    // (ngoai cua so quet). Chay moi 5 phut, doi chieu gia va cap nhat ket qua.
    if (isOutcomeTrackerSlot(now, config.tradeScannerTimezone)) {
      const trackerSlot = slotKey(now, config.tradeScannerTimezone);
      if (globalThis.__outcomeTrackerLastSlot !== trackerSlot) {
        globalThis.__outcomeTrackerLastSlot = trackerSlot;
        void outcomeTracker.trackOnce();
      }
    }

    // Goi moi slot ke ca ngoai khung gio: scanOnce tu quyet dinh -- co lenh dang om thi
    // theo doi lenh do (24/7), khong co lenh thi chi quet tim setup moi trong khung gio.
    if (!isScannerSlot(now)) return;

    const slot = slotKey(now, config.tradeScannerTimezone);
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

  console.info(
    `[trade-scanner] enabled ${config.tradeScannerWindows || `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`} ${config.tradeScannerTimezone}, every ${config.tradeScannerIntervalMinutes}m`,
  );
});

function isOutcomeTrackerSlot(date: Date, timeZone: string): boolean {
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
