import { createError, getQuery } from "h3";
import { SYMBOLS, type SymbolCode } from "../../../types/trading";
import { MarketDataService } from "../../services/MarketDataService";

function resolveSymbol(value: unknown): SymbolCode {
  return typeof value === "string" &&
    (SYMBOLS as readonly string[]).includes(value)
    ? (value as SymbolCode)
    : "XAUUSD";
}

export default defineEventHandler(async (event) => {
  const symbol = resolveSymbol(getQuery(event).symbol);
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
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
      debug: config.marketDataDebug,
    }).getLatestPrice(symbol);
  } catch (error) {
    throw createError({
      statusCode: 502,
      message:
        error instanceof Error
          ? error.message
          : `Không lấy được giá ${symbol} hiện tại.`,
    });
  }
});
