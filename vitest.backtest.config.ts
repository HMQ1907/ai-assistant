import { defineConfig } from "vitest/config";

// Config riêng cho backtest: KHÔNG stub fetch (cần gọi MT5 bridge thật),
// timeout dài vì phải replay hàng nghìn nến M5.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/backtest/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
