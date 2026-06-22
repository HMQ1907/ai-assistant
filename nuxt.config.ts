export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  compatibilityDate: "2025-05-15",
  devtools: { enabled: true },
  runtimeConfig: {
    evolinkApiKey: process.env.EVOLINK_API_KEY || "",
    evolinkModel: process.env.EVOLINK_MODEL || "claude-opus-4.8",
    evolinkBaseUrl:
      process.env.EVOLINK_BASE_URL ||
      "https://api.evolink.ai/v1/chat/completions",
    aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 90000),
    accountSizeUsd: Number(process.env.ACCOUNT_SIZE_USD || 200),
    maxLossPercentPerTrade: Number(
      process.env.MAX_LOSS_PERCENT_PER_TRADE || 15,
    ),
    maxDailyLossPercent: Number(process.env.MAX_DAILY_LOSS_PERCENT || 15),
    marketDataProvider: process.env.MARKET_DATA_PROVIDER || "twelvedata",
    marketDataApiKey: process.env.MARKET_DATA_API_KEY || "",
    marketDataBaseUrl:
      process.env.MARKET_DATA_BASE_URL || "https://api.twelvedata.com",
    mt5BridgeUrl: process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765",
    mt5Symbol: process.env.MT5_SYMBOL || "XAUUSDm",
    mt5EurUsdSymbol: process.env.MT5_EURUSD_SYMBOL || "EURUSDm",
    maxQuoteAgeSeconds: Number(process.env.MAX_QUOTE_AGE_SECONDS || 180),
    marketDataDebug: process.env.MARKET_DATA_DEBUG === "true",
    newsProvider: process.env.NEWS_PROVIDER || "gnews",
    newsApiKey: process.env.NEWS_API_KEY || "",
    newsBaseUrl: process.env.NEWS_BASE_URL || "https://gnews.io",
    newsMaxAgeHours: Number(process.env.NEWS_MAX_AGE_HOURS || 48),
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    tradeScannerEnabled: process.env.TRADE_SCANNER_ENABLED === "true",
    tradeScannerTimezone: process.env.TRADE_SCANNER_TIMEZONE || "Asia/Saigon",
    tradeScannerWindows: process.env.TRADE_SCANNER_WINDOWS || "",
    tradeScannerStartHour: Number(process.env.TRADE_SCANNER_START_HOUR || 19),
    tradeScannerEndHour: Number(process.env.TRADE_SCANNER_END_HOUR || 23),
    tradeScannerIntervalMinutes: Number(
      process.env.TRADE_SCANNER_INTERVAL_MINUTES || 15,
    ),
    tradeScannerMinConfidence: Number(
      process.env.TRADE_SCANNER_MIN_CONFIDENCE || 75,
    ),
    tradeScannerMinRiskReward: Number(
      process.env.TRADE_SCANNER_MIN_RISK_REWARD || 1.5,
    ),
    tradeScannerMinWinProbability: Number(
      process.env.TRADE_SCANNER_MIN_WIN_PROBABILITY || 65,
    ),
  },
  typescript: {
    strict: true,
  },
});
