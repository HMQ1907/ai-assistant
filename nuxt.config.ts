export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  runtimeConfig: {
    evolinkApiKey: process.env.EVOLINK_API_KEY || '',
    evolinkModel: process.env.EVOLINK_MODEL || 'claude-opus-4.8',
    evolinkBaseUrl: process.env.EVOLINK_BASE_URL || 'https://api.evolink.ai/v1/chat/completions',
    aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 90000),
    marketDataProvider: process.env.MARKET_DATA_PROVIDER || 'mock',
    newsProvider: process.env.NEWS_PROVIDER || 'mock',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  },
  typescript: {
    strict: true,
    typeCheck: false
  }
})
