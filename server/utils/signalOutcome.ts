import type {
  Candle,
  SignalOutcomeEvaluation,
  TradeDirection,
} from "../../types/trading";

export interface OutcomeSignalInput {
  direction: TradeDirection;
  orderType: string | null;
  entryFrom: number;
  entryTo: number;
  stopLoss: number;
  takeProfit: number;
  createdAt: string;
  // Thoi gian toi da cho khop (phut) — het han ma chua khop thi NOT_FILLED.
  cancelAfterMinutes: number;
  // Thoi gian toi da giu lenh sau khi khop (phut) — het ma chua cham SL/TP thi EXPIRED.
  maxHoldingMinutes: number;
}

/**
 * Doi chieu duong di gia (nen, thuong M5) sau khi co tin hieu de suy ra ket qua
 * thuc te: entry co khop khong, SL hay TP toi truoc, MAE/MFE, va co bi quet SL
 * roi gia van di toi TP khong (dau hieu stop-hunt). Thuan tuy, khong I/O — de test.
 *
 * Quy uoc: ham KHONG goi Date.now(); thoi diem hien tai truyen vao qua `nowIso`.
 */
export function evaluateSignalOutcome(
  signal: OutcomeSignalInput,
  candles: Candle[],
  nowIso: string,
): SignalOutcomeEvaluation {
  const empty: SignalOutcomeEvaluation = {
    outcome: "PENDING",
    filled: false,
    filledAt: null,
    firstHit: null,
    mae: null,
    mfe: null,
    sweptThenReversed: false,
    resolvedAt: null,
  };

  if (signal.direction !== "BUY" && signal.direction !== "SELL") return empty;
  if (
    !isFinitePositive(signal.entryFrom) ||
    !isFinitePositive(signal.entryTo) ||
    !isFinitePositive(signal.stopLoss) ||
    !isFinitePositive(signal.takeProfit)
  ) {
    return empty;
  }

  const createdMs = toMs(signal.createdAt);
  const nowMs = toMs(nowIso);
  if (createdMs === null || nowMs === null) return empty;

  const entryMid = (signal.entryFrom + signal.entryTo) / 2;
  const entryLow = Math.min(signal.entryFrom, signal.entryTo);
  const entryHigh = Math.max(signal.entryFrom, signal.entryTo);
  const fillDeadlineMs = createdMs + signal.cancelAfterMinutes * 60_000;

  const path = candles
    .map((candle) => ({ candle, ms: toMs(candle.time) }))
    .filter(
      (item): item is { candle: Candle; ms: number } =>
        item.ms !== null && item.ms >= createdMs,
    )
    .sort((left, right) => left.ms - right.ms);

  const isMarket = (signal.orderType ?? "MARKET") === "MARKET";

  let filled = isMarket;
  let filledAt: string | null = isMarket ? signal.createdAt : null;
  let entryPrice = isMarket ? entryMid : entryMid;
  let firstHit: "SL" | "TP" | null = null;
  let resolvedAt: string | null = null;
  let mae = 0;
  let mfe = 0;
  let sawSlHit = false;
  let sweptThenReversed = false;

  for (const { candle, ms } of path) {
    if (!filled) {
      if (ms > fillDeadlineMs) break; // het cua so cho khop
      // Lenh cho: coi nhu khop khi nen cham vung entry.
      if (candle.low <= entryHigh && candle.high >= entryLow) {
        filled = true;
        filledAt = candle.time;
        entryPrice = entryMid;
      } else {
        continue;
      }
    }

    const holdDeadlineMs =
      (filledAt ? toMs(filledAt) ?? createdMs : createdMs) +
      signal.maxHoldingMinutes * 60_000;

    // MAE/MFE tinh tu entry, theo gia (USD).
    if (signal.direction === "SELL") {
      mae = Math.max(mae, candle.high - entryPrice);
      mfe = Math.max(mfe, entryPrice - candle.low);
    } else {
      mae = Math.max(mae, entryPrice - candle.low);
      mfe = Math.max(mfe, candle.high - entryPrice);
    }

    const slHit =
      signal.direction === "SELL"
        ? candle.high >= signal.stopLoss
        : candle.low <= signal.stopLoss;
    const tpHit =
      signal.direction === "SELL"
        ? candle.low <= signal.takeProfit
        : candle.high >= signal.takeProfit;

    if (firstHit === null) {
      // Cung mot nen cham ca SL va TP: khong biet cai nao truoc -> coi SL truoc (than trong).
      if (slHit) {
        firstHit = "SL";
        resolvedAt = candle.time;
        sawSlHit = true;
      } else if (tpHit) {
        firstHit = "TP";
        resolvedAt = candle.time;
      } else if (ms > holdDeadlineMs) {
        // Da khop nhung het cua so giu lenh ma chua cham SL/TP.
        return {
          outcome: "EXPIRED",
          filled: true,
          filledAt,
          firstHit: null,
          mae: round(mae),
          mfe: round(mfe),
          sweptThenReversed: false,
          resolvedAt: candle.time,
        };
      }
    } else if (sawSlHit && !sweptThenReversed) {
      // Sau khi dinh SL, gia co quay lai cham muc TP khong -> dau hieu bi quet.
      const reachedTp =
        signal.direction === "SELL"
          ? candle.low <= signal.takeProfit
          : candle.high >= signal.takeProfit;
      if (reachedTp) sweptThenReversed = true;
    }
  }

  if (firstHit !== null) {
    return {
      outcome: firstHit === "TP" ? "WIN" : "LOSS",
      filled: true,
      filledAt,
      firstHit,
      mae: round(mae),
      mfe: round(mfe),
      sweptThenReversed,
      resolvedAt,
    };
  }

  if (!filled) {
    // Chua khop. Het cua so cho khop chua?
    return {
      ...empty,
      outcome: nowMs > fillDeadlineMs ? "NOT_FILLED" : "PENDING",
    };
  }

  // Da khop, chua cham SL/TP, chua het cua so giu lenh.
  return {
    outcome: "OPEN",
    filled: true,
    filledAt,
    firstHit: null,
    mae: round(mae),
    mfe: round(mfe),
    sweptThenReversed: false,
    resolvedAt: null,
  };
}

export function isTerminalOutcome(outcome: SignalOutcomeEvaluation["outcome"]): boolean {
  return (
    outcome === "WIN" ||
    outcome === "LOSS" ||
    outcome === "NOT_FILLED" ||
    outcome === "EXPIRED"
  );
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function toMs(iso: string): number | null {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
