import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiTradeRecommendation } from "../../types/ai";
import type {
  AnalysisHistoryRecord,
  AnalysisPayload,
  ExecutionStats,
  OrderState,
  PerformanceStats,
  ResultStatus,
  SignalAutoOutcome,
  SignalFirstHit,
  SignalOutcomeEvaluation,
  SymbolPerformance,
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
  actual_order_placed_at: string | null;
  user_note: string | null;
  market_data_provider: string | null;
  news_provider: string | null;
  data_quality: string | null;
  data_warnings: unknown;
  market_data_timestamp: string | null;
  news_data_timestamp: string | null;
  mt5_ticket: number | null;
  order_type: string | null;
  order_state: string | null;
  placed_at: string | null;
  auto_outcome: string | null;
  auto_filled: boolean | null;
  auto_filled_at: string | null;
  auto_first_hit: string | null;
  auto_mae: number | null;
  auto_mfe: number | null;
  auto_swept_then_reversed: boolean | null;
  auto_resolved_at: string | null;
  auto_evaluated_at: string | null;
}

// Tóm tắt kết quả THẬT của các tín hiệu TRADE gần nhất (tracker tự chấm),
// bơm ngược vào prompt để AI tự hiệu chỉnh confidence/win-probability
// thay vì đoán mò lạc quan. Chỉ gồm outcome đã ngã ngũ.
export interface RecentSignalPerformance {
  resolved: number;
  wins: number;
  losses: number;
  sweptLosses: number; // LOSS bị quét SL xong giá vẫn chạy tới TP (SL quá sát)
  notFilled: number; // lệnh chờ hết hạn không khớp (entry đặt quá xa)
  expired: number;
  winRate: number;
  recentSignals: Array<{
    created_at: string;
    direction: string;
    order_type: string | null;
    confidence: number;
    outcome: string;
    swept_then_reversed: boolean;
  }>;
}

// Bộ lọc thống kê: theo ngày bắt đầu (VN) và theo nguồn phát tín hiệu.
export type StatsSource = "all" | "rule" | "ai";
export interface StatsFilter {
  fromDate?: string | undefined; // YYYY-MM-DD, hiểu theo múi giờ VN
  source?: StatsSource | undefined;
}

// Nhận diện record do RULE ENGINE phát (auto-bot hoặc quét manual mới) dựa vào
// nhãn ai_response_raw — record AI thật chứa raw JSON của model, không bắt đầu
// bằng các prefix này.
function isRuleEngineRecord(record: { ai_response_raw: string }): boolean {
  const raw = record.ai_response_raw.trimStart();
  return raw.startsWith("auto-bot") || raw.startsWith("manual rule-engine");
}

export interface HistoryUpdateInput {
  result_status?: ResultStatus;
  actual_entry?: number | null;
  actual_exit?: number | null;
  actual_profit_loss?: number | null;
  actual_order_placed_at?: string | null;
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
        actual_order_placed_at: null,
        user_note: "",
        market_data_provider: input.requestPayload.marketDataProvider,
        news_provider: input.requestPayload.newsProvider,
        data_quality: input.requestPayload.dataQuality,
        data_warnings: input.requestPayload.dataWarnings,
        market_data_timestamp: input.requestPayload.marketDataTimestamp,
        news_data_timestamp: input.requestPayload.newsDataTimestamp,
        mt5_ticket: null,
        order_type: input.parsedResult.order_type,
        order_state: "NONE",
        placed_at: null,
      })
      .select("*")
      .single();

    if (error)
      throw new Error(`Không lưu được lịch sử phân tích: ${error.message}`);
    return toRecord(data);
  }

  async list(): Promise<AnalysisHistoryRecord[]> {
    const { data, error } = await this.supabase
      .from(tableName)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error)
      throw new Error(`Không tải được lịch sử phân tích: ${error.message}`);
    return (data ?? []).map(toRecord);
  }

  async getById(id: string): Promise<AnalysisHistoryRecord> {
    const { data, error } = await this.supabase
      .from(tableName)
      .select("*")
      .eq("id", id)
      .single();
    if (error)
      throw new Error(`Không tải được lịch sử phân tích: ${error.message}`);
    return toRecord(data);
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
    if (input.actual_order_placed_at !== undefined)
      patch.actual_order_placed_at = input.actual_order_placed_at;
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

  async markOrderPlaced(
    id: string,
    input: { mt5_ticket: number; order_type: string; order_state: OrderState },
  ): Promise<AnalysisHistoryRecord> {
    const { data, error } = await this.supabase
      .from(tableName)
      .update({
        mt5_ticket: input.mt5_ticket,
        order_type: input.order_type,
        order_state: input.order_state,
        placed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("*")
      .single();
    if (error)
      throw new Error(`Không lưu được trạng thái đặt lệnh: ${error.message}`);
    return toRecord(data);
  }

  async markOrderState(
    id: string,
    orderState: OrderState,
  ): Promise<AnalysisHistoryRecord> {
    const { data, error } = await this.supabase
      .from(tableName)
      .update({ order_state: orderState })
      .eq("id", id)
      .select("*")
      .single();
    if (error)
      throw new Error(`Không cập nhật được trạng thái lệnh: ${error.message}`);
    return toRecord(data);
  }

  // Cac tin hieu TRADE con dang theo doi (chua ket thuc) trong 24h gan day,
  // de tracker doi chieu gia va cap nhat ket qua thuc te.
  async listTrackable(): Promise<AnalysisHistoryRecord[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .from(tableName)
      .select("*")
      .eq("decision", "TRADE")
      .in("auto_outcome", ["PENDING", "OPEN"])
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error)
      throw new Error(`Không tải được tín hiệu cần theo dõi: ${error.message}`);
    return (data ?? []).map(toRecord);
  }

  async updateAutoOutcome(
    id: string,
    evaluation: SignalOutcomeEvaluation,
  ): Promise<void> {
    const { error } = await this.supabase
      .from(tableName)
      .update({
        auto_outcome: evaluation.outcome,
        auto_filled: evaluation.filled,
        auto_filled_at: evaluation.filledAt,
        auto_first_hit: evaluation.firstHit,
        auto_mae: evaluation.mae,
        auto_mfe: evaluation.mfe,
        auto_swept_then_reversed: evaluation.sweptThenReversed,
        auto_resolved_at: evaluation.resolvedAt,
        auto_evaluated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error)
      throw new Error(`Không cập nhật được kết quả tự động: ${error.message}`);
  }

  // Kết quả thật của các tín hiệu TRADE gần nhất cho một symbol — dùng làm
  // context tự hiệu chỉnh trong prompt phân tích. Lỗi ở đây KHÔNG được chặn
  // phân tích chính (caller phải try/catch).
  async recentSignalPerformance(
    symbol: string,
    limit = 30,
  ): Promise<RecentSignalPerformance> {
    const { data, error } = await this.supabase
      .from(tableName)
      .select(
        "created_at,direction,order_type,confidence,auto_outcome,auto_swept_then_reversed",
      )
      .eq("decision", "TRADE")
      .eq("symbol", symbol)
      .in("auto_outcome", ["WIN", "LOSS", "NOT_FILLED", "EXPIRED"])
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error)
      throw new Error(`Không tải được hiệu suất tín hiệu gần đây: ${error.message}`);

    const rows = (data ?? []) as Array<{
      created_at: string;
      direction: string;
      order_type: string | null;
      confidence: number;
      auto_outcome: string;
      auto_swept_then_reversed: boolean | null;
    }>;
    const wins = rows.filter((row) => row.auto_outcome === "WIN").length;
    const losses = rows.filter((row) => row.auto_outcome === "LOSS").length;
    return {
      resolved: rows.length,
      wins,
      losses,
      sweptLosses: rows.filter(
        (row) => row.auto_outcome === "LOSS" && row.auto_swept_then_reversed === true,
      ).length,
      notFilled: rows.filter((row) => row.auto_outcome === "NOT_FILLED").length,
      expired: rows.filter((row) => row.auto_outcome === "EXPIRED").length,
      winRate: percentage(wins, wins + losses),
      recentSignals: rows.slice(0, 10).map((row) => ({
        created_at: row.created_at,
        direction: row.direction,
        order_type: row.order_type,
        confidence: Number(row.confidence),
        outcome: row.auto_outcome,
        swept_then_reversed: row.auto_swept_then_reversed === true,
      })),
    };
  }

  async stats(filter?: StatsFilter): Promise<PerformanceStats> {
    let query = this.supabase.from(tableName).select("*");
    if (filter?.fromDate) {
      // Ngày người dùng chọn hiểu theo múi giờ VN (ngày giao dịch bắt đầu 00:00 VN).
      query = query.gte("created_at", `${filter.fromDate}T00:00:00+07:00`);
    }
    const { data, error } = await query;
    if (error)
      throw new Error(`Không tải được thống kê hiệu quả: ${error.message}`);

    let records = (data ?? []).map(toRecord);
    if (filter?.source === "rule") {
      records = records.filter(isRuleEngineRecord);
    } else if (filter?.source === "ai") {
      records = records.filter((record) => !isRuleEngineRecord(record));
    }
    const tradeRecords = records.filter((record) => record.decision === "TRADE");
    const allAnalyses = summarizeRecords(records);
    const tradeAnalyses = summarizeRecords(tradeRecords);

    return {
      ...allAnalyses,
      allAnalyses,
      tradeAnalyses,
      bestSymbols: symbolPerformance(tradeRecords, "best"),
      worstSymbols: symbolPerformance(tradeRecords, "worst"),
      execution: executionStats(tradeRecords),
    };
  }
}

// Thong ke chat luong THUC THI tu du lieu tracker tu dong (khong phu thuoc nguoi dung nhap).
function executionStats(records: AnalysisHistoryRecord[]): ExecutionStats {
  const tracked = records.filter(
    (record) => record.auto_outcome !== "PENDING",
  );
  const filled = tracked.filter((record) => record.auto_filled);
  const notFilled = tracked.filter(
    (record) => record.auto_outcome === "NOT_FILLED",
  );
  const wins = tracked.filter((record) => record.auto_outcome === "WIN");
  const losses = tracked.filter((record) => record.auto_outcome === "LOSS");
  const open = tracked.filter((record) => record.auto_outcome === "OPEN");
  const expired = tracked.filter((record) => record.auto_outcome === "EXPIRED");
  const swept = losses.filter((record) => record.auto_swept_then_reversed);

  const maeValues = filled
    .map((record) => record.auto_mae)
    .filter((value): value is number => value !== null);
  const mfeValues = filled
    .map((record) => record.auto_mfe)
    .filter((value): value is number => value !== null);
  const maeToStopRatios = filled
    .map((record) => {
      const entryMid = (record.entry_from + record.entry_to) / 2;
      const stopDistance = Math.abs(entryMid - record.stop_loss);
      if (record.auto_mae === null || stopDistance <= 0) return null;
      return record.auto_mae / stopDistance;
    })
    .filter((value): value is number => value !== null);

  return {
    tracked: tracked.length,
    filled: filled.length,
    notFilled: notFilled.length,
    fillRate: percentage(filled.length, tracked.length),
    wins: wins.length,
    losses: losses.length,
    open: open.length,
    expired: expired.length,
    winRate: percentage(wins.length, wins.length + losses.length),
    sweptThenReversed: swept.length,
    sweptThenReversedRate: percentage(swept.length, losses.length),
    avgMae: average(maeValues),
    avgMfe: average(mfeValues),
    avgMaeToStopRatio: average(maeToStopRatios),
  };
}

function summarizeRecords(
  records: AnalysisHistoryRecord[],
): Omit<
  PerformanceStats,
  "allAnalyses" | "tradeAnalyses" | "bestSymbols" | "worstSymbols" | "execution"
> {
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
  };
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
    actual_order_placed_at: value.actual_order_placed_at ?? null,
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
    mt5_ticket: nullableNumber(value.mt5_ticket),
    order_type: value.order_type ?? null,
    order_state: normalizeOrderState(value.order_state),
    placed_at: value.placed_at ?? null,
    auto_outcome: normalizeAutoOutcome(value.auto_outcome),
    auto_filled: value.auto_filled === true,
    auto_filled_at: value.auto_filled_at ?? null,
    auto_first_hit: normalizeFirstHit(value.auto_first_hit),
    auto_mae: nullableNumber(value.auto_mae),
    auto_mfe: nullableNumber(value.auto_mfe),
    auto_swept_then_reversed: value.auto_swept_then_reversed === true,
    auto_resolved_at: value.auto_resolved_at ?? null,
    auto_evaluated_at: value.auto_evaluated_at ?? null,
  };
}

function normalizeAutoOutcome(value: string | null): SignalAutoOutcome {
  if (
    value === "NOT_FILLED" ||
    value === "WIN" ||
    value === "LOSS" ||
    value === "OPEN" ||
    value === "EXPIRED"
  ) {
    return value;
  }
  return "PENDING";
}

function normalizeFirstHit(value: string | null): SignalFirstHit {
  return value === "SL" || value === "TP" ? value : null;
}

function normalizeOrderState(value: string | null): OrderState {
  if (
    value === "PENDING" ||
    value === "FILLED" ||
    value === "CANCELLED" ||
    value === "CLOSED"
  ) {
    return value;
  }
  return "NONE";
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
