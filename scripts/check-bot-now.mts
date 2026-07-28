import fs from "node:fs";
import {
  evaluateXauMicroScalpSignal,
  explainXauMicroScalpRejection,
  defaultXauMicroScalpConfig,
} from "../server/strategy/xauMicroScalpStrategy.ts";
import {
  computeAsiaSessionRange,
  resolveTrendDayBlock,
} from "../server/strategy/trendDayFilter.ts";

const snapPath = process.argv[2] || "mt5snap.json";
const d = JSON.parse(fs.readFileSync(snapPath, "utf8")) as {
  time: string;
  bid: number;
  candles: Record<string, Array<{ time: string; open: number; high: number; low: number; close: number }>>;
};
const { M1, M5, M15, H1, H4 } = d.candles;
const now = new Date(d.time);

console.log("Now (MT5 tick):", d.time, "Bid:", d.bid);
console.log("Asia range:", computeAsiaSessionRange(H1, now));
for (const dir of ["BUY", "SELL"] as const) {
  const block = resolveTrendDayBlock({
    direction: dir,
    entry: d.bid,
    h1: H1,
    h4: H4,
    now,
  });
  console.log(`Trend-day ${dir}:`, block ?? "ALLOW");
}
const sig = evaluateXauMicroScalpSignal(
  M1,
  M15,
  H1,
  defaultXauMicroScalpConfig,
  M5,
  H4,
  now,
);
console.log("Micro-scalp signal:", sig ? JSON.stringify(sig, null, 2) : "null");
console.log(
  "Rejection:",
  explainXauMicroScalpRejection(M1, M15, H1, defaultXauMicroScalpConfig, M5, H4, now),
);
