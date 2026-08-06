import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBacktestCandlesPaged } from "../../server/backtest/backtestData";
import type { Candle, Timeframe } from "../../types/trading";

const CACHE_DIR = join(process.cwd(), ".cache", "backtest");

/**
 * Nến MT5 cache ra đĩa: sweep tham số phải nạp lại vài chục nghìn nến M1 nhiều lần,
 * gọi bridge mỗi lần vừa chậm vừa cho dataset lệch nhau giữa các lần chạy.
 */
export async function loadCandlesCached(
  bridgeUrl: string,
  symbol: string,
  timeframe: Timeframe,
  count: number,
): Promise<Candle[]> {
  const file = join(CACHE_DIR, `${symbol}-${timeframe}-${count}.json`);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")) as Candle[];
  }
  const candles = await fetchBacktestCandlesPaged(bridgeUrl, symbol, timeframe, count, 20000);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(candles));
  return candles;
}
