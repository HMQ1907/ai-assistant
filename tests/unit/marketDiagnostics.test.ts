import { describe, expect, it } from "vitest";
import { parseProviderCandles } from "../../server/utils/marketDiagnostics";

function candle(index: number) {
  return {
    datetime: `2026-06-0${index}T10:00:00Z`,
    open: "4300",
    high: "4310",
    low: "4290",
    close: "4305",
    volume: "0",
  };
}

describe("market diagnostics", () => {
  it("keeps valid candles and marks indicator sufficiency", () => {
    const values = Array.from({ length: 350 }, (_, index) => ({
      datetime: new Date(Date.UTC(2026, 5, 9, index)).toISOString(),
      open: String(4300 + index),
      high: String(4310 + index),
      low: String(4290 + index),
      close: String(4305 + index),
      volume: "0",
    }));

    const result = parseProviderCandles(values, "H1");
    expect(result.candles).toHaveLength(350);
    expect(result.diagnostics.indicatorDataSufficient).toBe(true);
    expect(result.diagnostics.filteredCount).toBe(0);
  });

  it("classifies invalid number, invalid shape and invalid timestamp", () => {
    const result = parseProviderCandles(
      [
        { ...candle(1), close: "NaN" },
        { ...candle(2), high: "4299" },
        { ...candle(3), datetime: "invalid" },
      ],
      "M15",
    );

    expect(result.diagnostics.reasons.INVALID_NUMBER).toBe(1);
    expect(result.diagnostics.reasons.INVALID_SHAPE).toBe(1);
    expect(result.diagnostics.reasons.INVALID_TIMESTAMP).toBe(1);
  });

  it("deduplicates duplicate timestamp with a clear reason", () => {
    const result = parseProviderCandles([candle(1), candle(1)], "M15");
    expect(result.candles).toHaveLength(1);
    expect(result.diagnostics.reasons.DUPLICATE_TIMESTAMP).toBe(1);
  });
});
