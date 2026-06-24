import type { AiTradeRecommendation } from "../../types/ai";
import type { AnalysisHistoryRecord, Candle, SymbolCode } from "../../types/trading";
import { tradingRules } from "../config/tradingRules";
import { evaluateSignalOutcome } from "../utils/signalOutcome";
import { AnalysisHistoryService } from "./AnalysisHistoryService";
import { MarketDataService } from "./MarketDataService";
import { SupabaseService } from "./SupabaseService";

/**
 * Doi chieu duong di gia (nen M5) sau moi tin hieu de tu dong ghi lai ket qua thuc te:
 * entry co khop khong, SL/TP cai toi truoc, MAE/MFE, va co bi quet SL roi dao chieu khong.
 * Day la nen tang du lieu khach quan de danh gia "da so" thay vi doan tu vai ca le.
 */
export class SignalOutcomeTracker {
  private running = false;

  async trackOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const config = useRuntimeConfig();
      const historyService = new AnalysisHistoryService(
        new SupabaseService({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
        }).getClient(),
      );

      const records = await historyService.listTrackable();
      if (records.length === 0) return;

      const bySymbol = groupBySymbol(records);
      const now = new Date().toISOString();

      for (const [symbol, symbolRecords] of bySymbol) {
        let candles: Candle[];
        try {
          candles = await this.fetchM5Candles(symbol);
        } catch (error) {
          console.warn(
            `[outcome-tracker] ${symbol} fetch candles failed:`,
            error instanceof Error ? error.message : error,
          );
          continue;
        }

        for (const record of symbolRecords) {
          const parsed = record.parsed_result as AiTradeRecommendation | null;
          const cancelAfter =
            parsed?.cancel_after_minutes && parsed.cancel_after_minutes > 0
              ? parsed.cancel_after_minutes
              : 120;

          const evaluation = evaluateSignalOutcome(
            {
              direction: record.direction,
              orderType: record.order_type,
              entryFrom: record.entry_from,
              entryTo: record.entry_to,
              stopLoss: record.stop_loss,
              takeProfit: record.take_profit,
              createdAt: record.created_at,
              cancelAfterMinutes: cancelAfter,
              maxHoldingMinutes: tradingRules.maxHoldingMinutes,
            },
            candles,
            now,
          );

          try {
            await historyService.updateAutoOutcome(record.id, evaluation);
          } catch (error) {
            console.warn(
              `[outcome-tracker] update ${record.id} failed:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async fetchM5Candles(symbol: SymbolCode): Promise<Candle[]> {
    const config = useRuntimeConfig();
    const mt5Symbol =
      symbol === "EURUSD" ? config.mt5EurUsdSymbol : config.mt5Symbol;
    const marketService = new MarketDataService({
      providerName: config.marketDataProvider,
      apiKey: config.marketDataApiKey,
      baseUrl: config.marketDataBaseUrl,
      mt5BridgeUrl: config.mt5BridgeUrl,
      mt5Symbol,
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
      debug: false,
    });
    const market = await marketService.collectAll([symbol]);
    return market.snapshots[0]?.candles.M5 ?? [];
  }
}

function groupBySymbol(
  records: AnalysisHistoryRecord[],
): Map<SymbolCode, AnalysisHistoryRecord[]> {
  const map = new Map<SymbolCode, AnalysisHistoryRecord[]>();
  for (const record of records) {
    if (record.symbol !== "XAUUSD" && record.symbol !== "EURUSD") continue;
    const symbol = record.symbol as SymbolCode;
    const list = map.get(symbol) ?? [];
    list.push(record);
    map.set(symbol, list);
  }
  return map;
}
