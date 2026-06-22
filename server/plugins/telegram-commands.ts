import { TelegramCommandService } from "../services/TelegramCommandService";

declare global {
  // eslint-disable-next-line no-var
  var __telegramCommandTimer: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __telegramCommandOffset: number | undefined;
}

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  if (!config.tradeScannerEnabled) {
    console.info("[telegram-commands] disabled: scanner disabled");
    return;
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn("[telegram-commands] disabled: missing Telegram config");
    return;
  }
  if (globalThis.__telegramCommandTimer) {
    clearInterval(globalThis.__telegramCommandTimer);
  }

  const commands = new TelegramCommandService();
  globalThis.__telegramCommandTimer = setInterval(() => {
    void commands
      .pollOnce()
      .then((offset) => {
        if (offset !== undefined) globalThis.__telegramCommandOffset = offset;
      })
      .catch((error) => {
        console.warn(
          "[telegram-commands] poll failed:",
          error instanceof Error ? error.message : error,
        );
      });
  }, 5_000);

  nitroApp.hooks.hookOnce("close", () => {
    if (globalThis.__telegramCommandTimer) {
      clearInterval(globalThis.__telegramCommandTimer);
      globalThis.__telegramCommandTimer = undefined;
    }
  });

  console.info("[telegram-commands] enabled: /check <signal_id>");
});
