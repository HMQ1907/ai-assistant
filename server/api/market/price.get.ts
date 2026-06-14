import { createError } from "h3";
import { MarketDataService } from "../../services/MarketDataService";

export default defineEventHandler(async (event) => {
  try {
    setResponseHeaders(event, {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    const config = useRuntimeConfig();
    return await new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
      mt5BridgeUrl: config.mt5BridgeUrl,
      mt5Symbol: config.mt5Symbol,
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
      debug: config.marketDataDebug,
    }).getLatestPrice("XAUUSD");
  } catch (error) {
    throw createError({
      statusCode: 502,
      message:
        error instanceof Error
          ? error.message
          : "Không lấy được giá XAUUSD hiện tại.",
    });
  }
});
