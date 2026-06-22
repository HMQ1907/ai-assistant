import { createError, readBody } from "h3";
import { z } from "zod";
import { tradingRules } from "../config/tradingRules";
import { runTradingAnalysis } from "../services/TradingAnalysisRunner";

const analyzeRequestSchema = z.object({
  symbol: z.enum(["XAUUSD", "EURUSD"]).default("XAUUSD"),
  accountSizeUsd: z
    .number()
    .positive()
    .max(1_000_000)
    .default(tradingRules.defaultAccountSizeUsd),
});

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    const input = analyzeRequestSchema.parse(body ?? {});
    const { result, history } = await runTradingAnalysis(input);

    return { result, history };
  } catch (error) {
    throw createError({
      statusCode: 500,
      message: error instanceof Error ? error.message : "Phân tích thất bại",
    });
  }
});
