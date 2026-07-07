import type { SymbolCode } from "../../types/trading";

export function symbolCodeFromMt5Symbol(mt5Symbol: string): SymbolCode {
  const normalized = mt5Symbol.trim().toUpperCase();
  if (normalized.startsWith("EURUSD")) return "EURUSD";
  if (normalized.startsWith("XAUUSD")) return "XAUUSD";
  throw new Error(
    `MT5_SYMBOL ${mt5Symbol} chưa được hỗ trợ. Hiện hỗ trợ EURUSD/EURUSDm và XAUUSD/XAUUSDm.`,
  );
}

export function symbolLabel(mt5Symbol: string): string {
  return `${symbolCodeFromMt5Symbol(mt5Symbol)} (${mt5Symbol})`;
}
