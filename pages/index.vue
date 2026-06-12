<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>AI Trading Assistant</h1>
        <p>
          Phân tích XAUUSD và EURUSD bằng dữ liệu thị trường thật và tin tức
          thật. Công cụ chỉ đưa gợi ý giao dịch thủ công, không đặt lệnh.
        </p>
      </div>
      <div class="action-panel">
        <label>
          <span>Vốn hiện tại (USD)</span>
          <input
            v-model.number="accountSizeUsd"
            class="input capital-input"
            min="1"
            step="1"
            type="number"
          />
        </label>
      </div>
    </div>

    <div class="symbols-grid">
      <section
        v-for="symbol in symbols"
        :key="symbol"
        class="symbol-column"
      >
        <header class="symbol-head">
          <h2>{{ symbol }}</h2>
          <AnalyzeButton
            :loading="states[symbol].loading"
            :symbol="symbol"
            @analyze="() => analyze(symbol)"
          />
        </header>

        <div v-if="states[symbol].error" class="card">
          <strong>Phân tích {{ symbol }} thất bại</strong>
          <p class="muted">{{ states[symbol].error }}</p>
        </div>

        <div v-if="states[symbol].loading" class="card">
          <strong>
            Đang lấy dữ liệu {{ symbol }}, tin tức và gửi AI phân tích...
          </strong>
          <p class="muted">Quá trình này có thể mất 60-120 giây.</p>
        </div>

        <RecommendationCard
          v-if="states[symbol].result"
          :history="states[symbol].latestHistory"
          :latest-price="states[symbol].latestPrice"
          :latest-price-loading="states[symbol].latestPriceLoading"
          :result="states[symbol].result!"
        />

        <p
          v-if="!states[symbol].result && !states[symbol].loading && !states[symbol].error"
          class="muted symbol-empty"
        >
          Bấm "Hiển thị gợi ý {{ symbol }}" để phân tích.
        </p>
      </section>
    </div>

    <AnalysisHistoryTable
      v-if="hasAnalyzed"
      :records="history"
      class="history-block"
      @updated="replaceHistoryRecord"
    />
  </main>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";
import type { AnalysisHistoryRecord, SymbolCode } from "~/types/trading";
import { SYMBOLS } from "~/types/trading";

interface SymbolState {
  loading: boolean;
  error: string;
  result: AiTradeRecommendation | null;
  latestHistory: AnalysisHistoryRecord | null;
  latestPrice: number | null;
  latestPriceLoading: boolean;
}

const symbols = [...SYMBOLS];
const accountSizeUsd = ref(200);
const history = ref<AnalysisHistoryRecord[]>([]);

function emptyState(): SymbolState {
  return {
    loading: false,
    error: "",
    result: null,
    latestHistory: null,
    latestPrice: null,
    latestPriceLoading: false,
  };
}

const states = reactive<Record<SymbolCode, SymbolState>>(
  Object.fromEntries(symbols.map((symbol) => [symbol, emptyState()])) as Record<
    SymbolCode,
    SymbolState
  >,
);

const hasAnalyzed = computed(() =>
  symbols.some((symbol) => states[symbol].result !== null),
);

async function analyze(symbol: SymbolCode): Promise<void> {
  const state = states[symbol];
  state.loading = true;
  state.error = "";
  state.latestPrice = null;
  try {
    const response = await $fetch<{
      result: AiTradeRecommendation;
      history: AnalysisHistoryRecord;
    }>("/api/analyze", {
      method: "POST",
      body: {
        symbol,
        accountSizeUsd: normalizeAccountSize(accountSizeUsd.value),
      },
    });
    state.result = response.result;
    state.latestHistory = response.history;
    history.value = [
      response.history,
      ...history.value.filter((record) => record.id !== response.history.id),
    ];
    await refreshLatestPrice(symbol);
  } catch (caught) {
    state.error =
      caught instanceof Error ? caught.message : "Lỗi không xác định";
  } finally {
    state.loading = false;
  }
}

async function refreshLatestPrice(symbol: SymbolCode): Promise<void> {
  const state = states[symbol];
  state.latestPriceLoading = true;
  try {
    const response = await $fetch<{ price: number }>("/api/market/price", {
      query: { symbol, timestamp: Date.now() },
    });
    state.latestPrice = response.price;
  } catch {
    state.latestPrice = null;
  } finally {
    state.latestPriceLoading = false;
  }
}

function normalizeAccountSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Number(value) : 200;
}

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) =>
    item.id === record.id ? record : item,
  );
  for (const symbol of symbols) {
    if (states[symbol].latestHistory?.id === record.id) {
      states[symbol].latestHistory = record;
    }
  }
}
</script>

<style scoped>
.history-block {
  margin-top: 24px;
}

.action-panel {
  display: grid;
  gap: 10px;
  justify-items: end;
  min-width: 220px;
}

.action-panel label {
  display: grid;
  gap: 6px;
  width: 100%;
  color: #9fb4cc;
  font-size: 13px;
}

.capital-input {
  width: 100%;
}

.symbols-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  align-items: start;
}

.symbol-column {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.symbol-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
}

.symbol-head h2 {
  margin: 0;
  font-size: 20px;
}

.symbol-head :deep(.button) {
  width: auto;
  min-width: 200px;
}

.symbol-empty {
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 22px 16px;
  text-align: center;
}

@media (max-width: 920px) {
  .symbols-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .action-panel {
    justify-items: stretch;
    min-width: 0;
    width: 100%;
  }

  .symbol-head {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .symbol-head :deep(.button) {
    width: 100%;
    min-width: 0;
  }
}
</style>
