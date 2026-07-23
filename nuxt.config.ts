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
      process.env.MAX_LOSS_PERCENT_PER_TRADE || 10,
    ),
    maxDailyLossPercent: Number(process.env.MAX_DAILY_LOSS_PERCENT || 5),
    marketDataProvider: process.env.MARKET_DATA_PROVIDER || "twelvedata",
    marketDataApiKey: process.env.MARKET_DATA_API_KEY || "",
    marketDataBaseUrl:
      process.env.MARKET_DATA_BASE_URL || "https://api.twelvedata.com",
    mt5BridgeUrl: process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765",
    mt5Symbol: process.env.MT5_SYMBOL || "XAUUSD",
    mt5EurUsdSymbol: process.env.MT5_EURUSD_SYMBOL || "EURUSD",
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
    tradeScannerStartHour: Number(process.env.TRADE_SCANNER_START_HOUR || 0),
    tradeScannerEndHour: Number(process.env.TRADE_SCANNER_END_HOUR || 24),
    tradeScannerIntervalMinutes: Number(
      process.env.TRADE_SCANNER_INTERVAL_MINUTES || 5,
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
    tradeScannerDedupMinutes: Number(
      process.env.TRADE_SCANNER_DEDUP_MINUTES || 45,
    ),
    // Auto-bot: trend-pullback XAU, lot nhỏ cho tài khoản ~$200.
    autoTradeEnabled: process.env.AUTO_TRADE === "true",
    autoLotGood: Number(process.env.AUTO_LOT_GOOD || 0.01),
    autoLotVeryGood: Number(process.env.AUTO_LOT_VERY_GOOD || 0.01),
    autoVeryGoodMinConviction: Number(process.env.AUTO_VERYGOOD_MIN_CONVICTION || 2),
    autoMaxTradesPerDay: Number(process.env.AUTO_MAX_TRADES_PER_DAY || 2),
    autoMaxDailyLossPercent: Number(process.env.AUTO_MAX_DAILY_LOSS_PERCENT || 5),
    autoMaxDailyLossUsd: Number(process.env.AUTO_MAX_DAILY_LOSS_USD || 10),
    autoMaxDailyProfitUsd: Number(process.env.AUTO_MAX_DAILY_PROFIT_USD || 0),
    autoMaxHoldHours: Number(process.env.AUTO_MAX_HOLD_HOURS || 8),
    autoCooldownMinutes: Number(process.env.AUTO_COOLDOWN_MINUTES || 45),
    autoCooldownM15Candles: Number(process.env.AUTO_COOLDOWN_M15_CANDLES || 0),
    // AI veto opt-in — mặc định tắt để bot deterministic + tránh timeout chặn lệnh.
    autoUseAiVetoOnBump: process.env.AUTO_AI_VETO === "true",
    autoTradeOnAiError: process.env.AUTO_TRADE_ON_AI_ERROR === "true",
    autoStrategyMode: process.env.AUTO_STRATEGY_MODE || "xau_trend_pullback",
    autoUseM15: process.env.AUTO_USE_M15 !== "false",
    autoAllowScalp: process.env.AUTO_ALLOW_SCALP === "true",
    // Scalp mode bị plugin bỏ qua — giữ flag để tương thích ENV cũ.
    autoTradeScalp: process.env.AUTO_TRADE_SCALP === "true",
    autoScalpTpR: Number(process.env.AUTO_SCALP_TP_R || 1.5),
    autoScalpFrequency: process.env.AUTO_SCALP_FREQUENCY || "normal",
    autoScalpMaxHoldMinutes: Number(process.env.AUTO_SCALP_MAX_HOLD_MINUTES || 30),
    autoScalpMaxOpenTrades: Number(process.env.AUTO_SCALP_MAX_OPEN_TRADES || 2),
    autoNewsBlackoutEnabled: process.env.AUTO_NEWS_BLACKOUT_ENABLED === "true",
    autoNewsBlackoutMinutes: Number(process.env.AUTO_NEWS_BLACKOUT_MINUTES || 60),
    autoNewsBlackoutEvents: process.env.AUTO_NEWS_BLACKOUT_EVENTS || "",
    autoNewsCalendarUrl:
      process.env.AUTO_NEWS_CALENDAR_URL ||
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    autoNewsCalendarCurrencies: process.env.AUTO_NEWS_CALENDAR_CURRENCIES || "USD,EUR",
    autoNewsCalendarImpacts: process.env.AUTO_NEWS_CALENDAR_IMPACTS || "High",
    autoNewsCalendarCacheMinutes: Number(process.env.AUTO_NEWS_CALENDAR_CACHE_MINUTES || 30),
    manualScalp: process.env.MANUAL_SCALP === "true",
    autoXauSellTpTarget: Number(process.env.AUTO_XAU_SELL_TP_TARGET || 0),
  },
  typescript: {
    strict: true,
  },
});
