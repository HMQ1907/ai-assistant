import type { Candle, Timeframe } from "../../types/trading";

interface BridgeCandlesResponse {
  symbol: string;
  timeframe: string;
  count: number;
  candles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    spread?: number;
  }>;
}

/**
 * Lấy nến lịch sử (1 khung) từ MT5 bridge endpoint /candles, trả về theo thứ tự
 * cũ -> mới (ascending) đúng yêu cầu của backtester.
 */
export async function fetchBacktestCandles(
  bridgeUrl: string,
  symbol: string,
  timeframe: Timeframe,
  count: number,
  start = 1,
): Promise<Candle[]> {
  const url = new URL("/candles", bridgeUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("count", String(count));
  url.searchParams.set("start", String(start));

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Không kết nối được MT5 bridge tại ${bridgeUrl}: ${reason}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `MT5 bridge /candles trả HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }

  const body = (await response.json()) as BridgeCandlesResponse;
  return body.candles
    .map((candle) => ({
      time: candle.time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      ...(candle.spread !== undefined ? { spread: Number(candle.spread) } : {}),
    }))
    .filter(
      (candle) =>
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close),
    );
}

/**
 * Lấy nhiều hơn giới hạn 1 lần gọi bằng cách ghép các trang `start`.
 * Trả về ascending (cũ -> mới), đã dedupe theo time.
 */
export async function fetchBacktestCandlesPaged(
  bridgeUrl: string,
  symbol: string,
  timeframe: Timeframe,
  totalCount: number,
  pageSize = 6000,
): Promise<Candle[]> {
  const pages: Candle[][] = [];
  let remaining = totalCount;
  let start = 1;
  while (remaining > 0) {
    const take = Math.min(pageSize, remaining);
    const chunk = await fetchBacktestCandles(bridgeUrl, symbol, timeframe, take, start);
    if (chunk.length === 0) break;
    pages.push(chunk);
    if (chunk.length < take) break;
    start += chunk.length;
    remaining -= chunk.length;
  }

  const byTime = new Map<string, Candle>();
  for (const page of pages.reverse()) {
    for (const candle of page) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  );
}
