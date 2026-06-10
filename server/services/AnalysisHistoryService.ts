import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiTradeRecommendation } from "../../types/ai";
import type {
  AnalysisHistoryRecord,
  AnalysisPayload,
  PerformanceStats,
  ResultStatus,
  SymbolPerformance,
  SymbolCode,
} from "../../types/trading";

const tableName = "analysis_history";

const resultStatusSchema = z.enum([
  "PENDING",
  "WIN",
  "LOSS",
  "BREAKEVEN",
  "SKIPPED",
]);

interface AnalysisHistoryRow {
  id: string;
  created_at: string;
  request_payload: AnalysisPayload;
  ai_response_raw: string;
  parsed_result: unknown;
  decision: string;
  symbol: string;
  direction: string;
  confidence: number;
  entry_from: number;
  entry_to: number;
  stop_loss: number;
  take_profit: number;
  result_status: string;
  actual_entry: number | null;
  actual_exit: number | null;
  actual_profit_loss: number | null;
  user_note: string | null;
  market_data_provider: string | null;
  news_provider: string | null;
  data_quality: string | null;
  data_warnings: unknown;
  market_data_timestamp: string | null;
  news_data_timestamp: string | null;
}

export interface HistoryUpdateInput {
  result_status?: ResultStatus;
  actual_entry?: number | null;
  actual_exit?: number | null;
  actual_profit_loss?: number | null;
  user_note?: string;
}

export class AnalysisHistoryService {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: {
    requestPayload: AnalysisPayload;
    aiResponseRaw: string;
    parsedResult: AiTradeRecommendation;
  }): Promise<AnalysisHistoryRecord> {
    const { data, error } = await this.supabase
      .from(tableName)
      .insert({
        request_payload: input.requestPayload,
        ai_response_raw: input.aiResponseRaw,
        parsed_result: input.parsedResult,
        decision: input.parsedResult.decision,
        symbol: input.parsedResult.symbol,
        direction: input.parsedResult.direction,
        confidence: input.parsedResult.confidence,
        entry_from: input.parsedResult.entry_zone?.from ?? 0,
        entry_to: input.parsedResult.entry_zone?.to ?? 0,
        stop_loss: input.parsedResult.stop_loss ?? 0,
        take_profit: input.parsedResult.take_profit ?? 0,
        result_status: "PENDING",
        actual_entry: null,
        actual_exit: null,
        actual_profit_loss: null,
        user_note: "",
        market_data_provider: input.requestPayload.marketDataProvider,
        news_provider: input.requestPayload.newsProvider,
        data_quality: input.requestPayload.dataQuality,
        data_warnings: input.requestPayload.dataWarnings,
        market_data_timestamp: input.requestPayload.marketDataTimestamp,
        news_data_timestamp: input.requestPayload.newsDataTimestamp,
      })
      .select("*")
      .single();

    if (error)
      throw new Error(`Không lưu được lịch sử phân tích: ${error.message}`);
    return toRecord(data);
  }

  async list(symbol?: SymbolCode): Promise<AnalysisHistoryRecord[]> {
    let query = this.supabase
      .from(tableName)
      .select("*")
      .order("created_at", { ascending: false });
    if (symbol) query = query.eq("symbol", symbol);
    const { data, error } = await query.limit(100);
    if (error)
      throw new Error(`Không tải được lịch sử phân tích: ${error.message}`);
    return (data ?? []).map(toRecord);
  }

  async update(
    id: string,
    input: HistoryUpdateInput,
  ): Promise<AnalysisHistoryRecord> {
    const patch: HistoryUpdateInput = {};
    if (input.result_status !== undefined)
      patch.result_status = input.result_status;
    if (input.actual_entry !== undefined)
      patch.actual_entry = input.actual_entry;
    if (input.actual_exit !== undefined) patch.actual_exit = input.actual_exit;
    if (input.actual_profit_loss !== undefined)
      patch.actual_profit_loss = input.actual_profit_loss;
    if (input.user_note !== undefined) patch.user_note = input.user_note;
    if (
      patch.result_status === "PENDING" &&
      patch.actual_profit_loss !== undefined &&
      patch.actual_profit_loss !== null
    ) {
      patch.result_status = statusFromProfitLoss(patch.actual_profit_loss);
    }

    const { data, error } = await this.supabase
      .from(tableName)
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();
    if (error)
      throw new Error(`Không cập nhật được lịch sử phân tích: ${error.message}`);
    return toRecord(data);
  }

  async stats(symbol?: SymbolCode): Promise<PerformanceStats> {
    let query = this.supabase.from(tableName).select("*");
    if (symbol) query = query.eq("symbol", symbol);
    const { data, error } = await query;
    if (error)
      throw new Error(`Không tải được thống kê hiệu quả: ${error.message}`);

    const records = (data ?? []).map(toRecord);
    const recordsWithEffectiveStatus = records.map((record) => ({
      record,
      resultStatus: effectiveResultStatus(record),
    }));
    const directionalRecords = records.filter(
      (record) => record.direction === "BUY" || record.direction === "SELL",
    );
    const wins = recordsWithEffectiveStatus
      .filter((item) => item.resultStatus === "WIN")
      .map((item) => item.record);
    const losses = recordsWithEffectiveStatus
      .filter((item) => item.resultStatus === "LOSS")
      .map((item) => item.record);
    const breakevens = records.filter(
      (record) => effectiveResultStatus(record) === "BREAKEVEN",
    );
    const skipped = records.filter(
      (record) => effectiveResultStatus(record) === "SKIPPED",
    );
    const recordedTrades = recordsWithEffectiveStatus.filter(
      (item) => item.resultStatus !== "PENDING",
    );

    return {
      totalAnalysis: records.length,
      totalTrades: recordedTrades.length,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      skipped: skipped.length,
      winRate: percentage(wins.length, wins.length + losses.length),
      avgConfidence: average(
        directionalRecords.map((record) => record.confidence),
      ),
      avgConfidenceOfWinners: average(wins.map((record) => record.confidence)),
      avgConfidenceOfLosers: average(losses.map((record) => record.confidence)),
      bestSymbols: symbolPerformance(records, "best"),
      worstSymbols: symbolPerformance(records, "worst"),
    };
  }
}

function toRecord(row: unknown): AnalysisHistoryRecord {
  const value = row as AnalysisHistoryRow;
  return {
    id: String(value.id),
    created_at: String(value.created_at),
    request_payload: value.request_payload,
    ai_response_raw: String(value.ai_response_raw),
    parsed_result: value.parsed_result,
    decision: value.decision === "TRADE" ? "TRADE" : "NO_TRADE",
    symbol: String(value.symbol),
    direction:
      value.direction === "BUY" || value.direction === "SELL"
        ? value.direction
        : "NONE",
    confidence: Number(value.confidence),
    entry_from: Number(value.entry_from),
    entry_to: Number(value.entry_to),
    stop_loss: Number(value.stop_loss),
    take_profit: Number(value.take_profit),
    result_status: normalizeStatus(String(value.result_status)),
    actual_entry: nullableNumber(value.actual_entry),
    actual_exit: nullableNumber(value.actual_exit),
    actual_profit_loss: nullableNumber(value.actual_profit_loss),
    user_note: value.user_note ?? "",
    market_data_provider: value.market_data_provider ?? "",
    news_provider: value.news_provider ?? "",
    data_quality:
      value.data_quality === "HIGH" ||
      value.data_quality === "MEDIUM" ||
      value.data_quality === "LOW"
        ? value.data_quality
        : "LOW",
    data_warnings: stringArray(value.data_warnings),
    market_data_timestamp: value.market_data_timestamp ?? "",
    news_data_timestamp: value.news_data_timestamp ?? "",
  };
}

function normalizeStatus(value: string): ResultStatus {
  return resultStatusSchema.safeParse(value).success
    ? (value as ResultStatus)
    : "PENDING";
}

function nullableNumber(value: number | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function effectiveResultStatus(record: AnalysisHistoryRecord): ResultStatus {
  if (record.result_status !== "PENDING") return record.result_status;
  if (record.actual_profit_loss === null) return "PENDING";
  return statusFromProfitLoss(record.actual_profit_loss);
}

function statusFromProfitLoss(value: number): ResultStatus {
  if (value > 0) return "WIN";
  if (value < 0) return "LOSS";
  return "BREAKEVEN";
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2),
  );
}

function percentage(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function symbolPerformance(
  records: AnalysisHistoryRecord[],
  mode: "best" | "worst",
): SymbolPerformance[] {
  const grouped = new Map<string, SymbolPerformance>();

  for (const record of records) {
    const resultStatus = effectiveResultStatus(record);
    if (resultStatus !== "WIN" && resultStatus !== "LOSS")
      continue;
    const existing = grouped.get(record.symbol) ?? {
      symbol: record.symbol,
      trades: 0,
      wins: 0,
      losses: 0,
      totalProfitLoss: 0,
    };

    existing.trades += 1;
    if (resultStatus === "WIN") existing.wins += 1;
    if (resultStatus === "LOSS") existing.losses += 1;
    existing.totalProfitLoss += record.actual_profit_loss ?? 0;
    grouped.set(record.symbol, existing);
  }

  return Array.from(grouped.values())
    .sort((left, right) => {
      const leftScore = left.wins - left.losses;
      const rightScore = right.wins - right.losses;
      return mode === "best" ? rightScore - leftScore : leftScore - rightScore;
    })
    .slice(0, 5);
}
