<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>AI EURUSD Trading Assistant</h1>
        <p>
          Phan tich EURUSD bang du lieu thi truong that va tin tuc that. Man
          hinh nay uu tien phan tich huong, entry, SL va TP; suggested lot duoc
          khoa cho toi khi cau hinh pip value broker.
        </p>
      </div>
      <div class="action-panel">
        <label>
          <span>Von hien tai (USD)</span>
          <input
            v-model.number="accountSizeUsd"
            class="input capital-input"
            min="1"
            step="1"
            type="number"
          />
        </label>
        <AnalyzeButton
          :loading="loading"
          label="Hien thi goi y EURUSD"
          @analyze="analyze"
        />
      </div>
    </div>

    <div v-if="error" class="card">
      <strong>Phan tich that bai</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <div v-if="loading" class="card">
      <strong>Dang lay du lieu EURUSD, tin tuc va gui AI phan tich...</strong>
      <p class="muted">Qua trinh nay co the mat 60-120 giay.</p>
    </div>

    <RecommendationCard
      v-if="result"
      :history="latestHistory"
      :latest-price="latestPrice"
      :latest-price-loading="latestPriceLoading"
      :result="result"
    />

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
import type { AnalysisHistoryRecord } from "~/types/trading";

const symbol = "EURUSD";
const loading = ref(false);
const error = ref("");
const result = ref<AiTradeRecommendation | null>(null);
const history = ref<AnalysisHistoryRecord[]>([]);
const hasAnalyzed = ref(false);
const accountSizeUsd = ref(200);
const latestPrice = ref<number | null>(null);
const latestPriceLoading = ref(false);
const latestHistory = computed(() =>
  result.value ? (history.value[0] ?? null) : null,
);

async function analyze(): Promise<void> {
  loading.value = true;
  error.value = "";
  hasAnalyzed.value = true;
  latestPrice.value = null;
  try {
    const response = await $fetch<{
      result: AiTradeRecommendation;
      history: AnalysisHistoryRecord;
    }>("/api/analyze", {
      method: "POST",
      body: {
        accountSizeUsd: normalizeAccountSize(accountSizeUsd.value),
        symbol,
      },
    });
    result.value = response.result;
    history.value = [
      response.history,
      ...history.value.filter((record) => record.id !== response.history.id),
    ].filter((record) => record.symbol === symbol);
    await refreshLatestPrice();
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : "Loi khong xac dinh";
  } finally {
    loading.value = false;
  }
}

async function refreshLatestPrice(): Promise<void> {
  latestPriceLoading.value = true;
  try {
    const response = await $fetch<{ price: number }>("/api/market/price", {
      query: { symbol, timestamp: Date.now() },
    });
    latestPrice.value = response.price;
  } catch {
    latestPrice.value = null;
  } finally {
    latestPriceLoading.value = false;
  }
}

function normalizeAccountSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Number(value) : 200;
}

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) =>
    item.id === record.id ? record : item,
  );
}
</script>

<style scoped>
.history-block {
  margin-top: 24px;
}

.action-panel {
  color: #9fb4cc;
  display: grid;
  gap: 10px;
  justify-items: end;
  min-width: 220px;
}

.action-panel label {
  display: grid;
  font-size: 13px;
  gap: 6px;
  width: 100%;
}

.capital-input {
  width: 100%;
}

@media (max-width: 760px) {
  .action-panel {
    align-items: end;
    grid-template-columns: minmax(110px, 0.8fr) 1.2fr;
    justify-items: stretch;
    min-width: 0;
    width: 100%;
  }
}

@media (max-width: 380px) {
  .action-panel {
    grid-template-columns: 1fr;
  }
}
</style>
