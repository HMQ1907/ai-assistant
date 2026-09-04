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

/**
 * Auto-bot loop (ưu tiên) hoặc manual Telegram scanner.
 *
 * AUTO_TRADE=true:
 *   - Mỗi TRADE_SCANNER_INTERVAL_MINUTES (mặc định 5): quét setup + đặt lệnh MT5
 *   - Mỗi 1 phút: quản lý lệnh đang mở / pending setup
 * AUTO_TRADE=false + TRADE_SCANNER_ENABLED=true:
 *   - Chỉ gửi tín hiệu Telegram (không đặt lệnh)
 */
export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  const autoMode = config.autoTradeEnabled;

  if (config.autoTradeScalp) {
    console.warn(
      "[trade-loop] AUTO_TRADE_SCALP bị bỏ qua — bot tập trung trend-pullback (không scalp).",
    );
  }

  if (!autoMode && !config.tradeScannerEnabled) {
    console.info("[trade-loop] disabled (AUTO_TRADE=false, TRADE_SCANNER_ENABLED=false)");
    return;
  }

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
  const windows =
    config.tradeScannerWindows ||
    `${config.tradeScannerStartHour}:00-${config.tradeScannerEndHour}:00`;

  globalThis.__tradeScannerTimer = setInterval(() => {
    const now = new Date();

    if (isScannerSlot(now)) {
      const trackerSlot = slotKey(now, tz);
        if (globalThis.__outcomeTrackerLastSlot !== trackerSlot) {
          globalThis.__outcomeTrackerLastSlot = trackerSlot;
          void outcomeTracker.trackOnce().catch((error) => {
            console.warn(
              "[trade-loop] outcome tracking skipped:",
              error instanceof Error ? error.message : error,
            );
          });
        }
    }

    if (autoMode) {
      const microScalp =
        String(config.autoStrategyMode).toLowerCase() === "xau_micro_scalp";
      const shouldScan = microScalp
        ? isOneMinSlot(now, tz)
        : isScannerSlot(now);
      if (shouldScan) {
        const autoSlot = slotKey(now, tz);
        if (globalThis.__autoTradeLastSlot !== autoSlot) {
          globalThis.__autoTradeLastSlot = autoSlot;
          void autoBot.runOnce();
        }
      }

      if (isOneMinSlot(now, tz)) {
        const managementSlot = slotKey(now, tz);
        if (globalThis.__autoTradeManagementLastSlot !== managementSlot) {
          globalThis.__autoTradeManagementLastSlot = managementSlot;
          void autoBot.runManagementOnce();
        }
      }
      return;
    }

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
    const scanEvery =
      String(config.autoStrategyMode).toLowerCase() === "xau_micro_scalp"
        ? 1
        : config.tradeScannerIntervalMinutes;
    const profitCap = Number(config.autoMaxDailyProfitUsd || 0);
    console.info(
      `[trade-loop] AUTO-BOT ON — ${config.autoStrategyMode}, scan every ${scanEvery}m, lot ${config.autoLotGood}/${config.autoLotVeryGood}, max ${config.autoMaxTradesPerDay}/day, dailyLoss ${config.autoMaxDailyLossUsd || `${config.autoMaxDailyLossPercent}%`} USD${profitCap > 0 ? `, dailyProfit ${profitCap} USD` : ""}, window ${windows} ${tz}.`,
    );
  } else {
    console.info(
      `[trade-loop] MANUAL signal scanner ON — every ${config.tradeScannerIntervalMinutes}m in ${windows} ${tz}; Telegram only.`,
    );
  }
});

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
