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
    marketDataProvider: process.env.MARKET_DATA_PROVIDER || "",
    marketDataApiKey: process.env.MARKET_DATA_API_KEY || "",
    marketDataBaseUrl:
      process.env.MARKET_DATA_BASE_URL || "https://api.twelvedata.com",
    newsProvider: process.env.NEWS_PROVIDER || "",
    newsApiKey: process.env.NEWS_API_KEY || "",
    newsBaseUrl: process.env.NEWS_BASE_URL || "https://newsapi.org",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
});
