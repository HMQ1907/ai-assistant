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
      process.env.MAX_LOSS_PERCENT_PER_TRADE || 20,
    ),
    maxDailyLossPercent: Number(process.env.MAX_DAILY_LOSS_PERCENT || 15),
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
    tradeScannerDedupMinutes: Number(
      process.env.TRADE_SCANNER_DEDUP_MINUTES || 45,
    ),
    // Auto-bot (Rules Engine H1). AUTO_TRADE=true -> tự đặt lệnh; false -> hệ báo tín hiệu cũ.
    autoTradeEnabled: process.env.AUTO_TRADE === "true",
    // 2 mức: setup đẹp -> good; setup rất đẹp (conviction >= 2/3) -> veryGood.
    autoLotGood: Number(process.env.AUTO_LOT_GOOD || 0.01),
    autoLotVeryGood: Number(process.env.AUTO_LOT_VERY_GOOD || 0.01),
    autoVeryGoodMinConviction: Number(process.env.AUTO_VERYGOOD_MIN_CONVICTION || 2),
    autoMaxTradesPerDay: Number(process.env.AUTO_MAX_TRADES_PER_DAY || 10),
    autoMaxDailyLossPercent: Number(process.env.AUTO_MAX_DAILY_LOSS_PERCENT || 25),
    autoMaxHoldHours: Number(process.env.AUTO_MAX_HOLD_HOURS || 72),
    autoCooldownMinutes: Number(process.env.AUTO_COOLDOWN_MINUTES || 15),
    autoCooldownM15Candles: Number(process.env.AUTO_COOLDOWN_M15_CANDLES || 3),
    autoUseAiVetoOnBump: process.env.AUTO_AI_VETO !== "false",
    autoTradeOnAiError: process.env.AUTO_TRADE_ON_AI_ERROR === "true",
    autoStrategyMode: process.env.AUTO_STRATEGY_MODE || "xau_trend_pullback",
    // Cho phép vào lệnh trên M15 (trong trend H1, bias H4) để có nhiều lệnh hơn.
    autoUseM15: process.env.AUTO_USE_M15 !== "false",
    // Nhánh scalp dự phòng trong mode xau_trend_pullback. Mặc định TẮT:
    // chỉ vào lệnh khi có setup trend-pullback sạch, không rơi xuống scalp chất lượng thấp.
    autoAllowScalp: process.env.AUTO_ALLOW_SCALP === "true",
    // Auto-scalp: khi bật AUTO_TRADE=true + AUTO_TRADE_SCALP=true, bot chuyển sang
    // chế độ reversal scalp tự động mỗi 1 phút (M1/M5/M15/H1), lot cố định 0.01,
    // không qua AI veto. Dùng cùng engine với MANUAL_SCALP nhưng đặt lệnh tự động.
    autoTradeScalp: process.env.AUTO_TRADE_SCALP === "true",
    autoScalpTpR: Number(process.env.AUTO_SCALP_TP_R || 1.5),
    autoScalpFrequency: process.env.AUTO_SCALP_FREQUENCY || "normal",
    // Manual-only: khi bấm "Quét setup Rule Engine", chuyển sang reversal scalp
    // M1/M5/M15/H1 để tìm đỉnh/đáy ngắn hạn. Không ảnh hưởng auto-bot.
    manualScalp: process.env.MANUAL_SCALP === "true",
  },
  typescript: {
    strict: true,
  },
});
