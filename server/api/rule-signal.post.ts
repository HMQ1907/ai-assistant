import { createError, readBody } from "h3";
import { z } from "zod";
import { runRuleSignalScan } from "../services/RuleSignalService";

const ruleSignalRequestSchema = z.object({
  accountSizeUsd: z.number().positive().max(1_000_000).optional(),
});

/**
 * POST /api/rule-signal
 * Quét setup bằng CHÍNH rule engine của auto-bot (kèm đầy đủ kiểm tra an toàn
 * + AI veto) nhưng không đặt lệnh — trả tín hiệu cho người dùng tự quyết định.
 */
export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    const input = ruleSignalRequestSchema.parse(body ?? {});
    const { result, history } = await runRuleSignalScan(input);
    return { result, history };
  } catch (error) {
    throw createError({
      statusCode: 500,
      message:
        error instanceof Error ? error.message : "Quét rule engine thất bại",
    });
  }
});
