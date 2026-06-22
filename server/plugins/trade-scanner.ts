import { TradeScannerService, isInsideTradeScannerWindow, isScannerSlot } from "../services/TradeScannerService";

declare global {
  // eslint-disable-next-line no-var
  var __tradeScannerTimer: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __tradeScannerLastSlot: string | undefined;
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
  globalThis.__tradeScannerTimer = setInterval(() => {
    const now = new Date();
    if (!isInsideTradeScannerWindow(now) || !isScannerSlot(now)) return;

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
