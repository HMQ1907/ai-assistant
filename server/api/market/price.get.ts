import { createError } from "h3";
import { getQuery } from "h3";
import { z } from "zod";
import { MarketDataService } from "../../services/MarketDataService";

const priceQuerySchema = z.object({
  symbol: z.enum(["XAUUSD", "EURUSD"]).default("XAUUSD"),
});

export default defineEventHandler(async (event) => {
  try {
    setResponseHeaders(event, {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    const config = useRuntimeConfig();
    const query = priceQuerySchema.parse(getQuery(event));
    const mt5Symbol =
      query.symbol === "EURUSD" ? config.mt5EurUsdSymbol : config.mt5Symbol;
    return await new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
      mt5BridgeUrl: config.mt5BridgeUrl,
      mt5Symbol,
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
      debug: config.marketDataDebug,
    }).getLatestPrice(query.symbol);
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
