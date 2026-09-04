<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>XAUUSD Auto-Bot</h1>
        <p>
          XAU RFTP v1: M15 EMA50/200 + VWAP regime → M5 pullback/rejection → momentum break
          → M5 pullback/strong close. Chỉ xét 08:00–18:00 UTC, có news filter và
          TP 2R; bot hiện ở chế độ không tự đặt lệnh.
        </p>
      </div>
      <div class="action-panel">
        <AnalyzeButton
          :loading="loading"
          label="Quét thử setup (không đặt lệnh)"
          @analyze="scanRuleSignal"
        />
      </div>
    </div>

    <div v-if="error" class="card">
      <strong>Quét thất bại</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <div v-if="loading" class="card">
      <strong>Đang lấy dữ liệu MT5 và quét Rule Engine...</strong>
      <p class="muted">Chỉ xem setup — không đặt lệnh từ nút này.</p>
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

const loading = ref(false);
const error = ref("");
const result = ref<AiTradeRecommendation | null>(null);
const history = ref<AnalysisHistoryRecord[]>([]);
const hasAnalyzed = ref(false);
const latestPrice = ref<number | null>(null);
const latestPriceLoading = ref(false);
const latestHistory = computed(() =>
  result.value ? (history.value[0] ?? null) : null,
);

async function scanRuleSignal(): Promise<void> {
  loading.value = true;
  error.value = "";
  hasAnalyzed.value = true;
  latestPrice.value = null;
  try {
    const response = await $fetch<{
      result: AiTradeRecommendation;
      history: AnalysisHistoryRecord;
    }>("/api/rule-signal", { method: "POST", body: {} });
    result.value = response.result;
    history.value = [
      response.history,
      ...history.value.filter((record) => record.id !== response.history.id),
    ];
    await refreshLatestPrice();
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : "Lỗi không xác định";
  } finally {
    loading.value = false;
  }
}

async function refreshLatestPrice(): Promise<void> {
  latestPriceLoading.value = true;
  try {
    const response = await $fetch<{ price: number }>("/api/market/price", {
      query: { symbol: "XAUUSD", timestamp: Date.now() },
    });
    latestPrice.value = response.price;
  } catch {
    latestPrice.value = null;
  } finally {
    latestPriceLoading.value = false;
  }
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
  display: grid;
  gap: 10px;
  justify-items: end;
  min-width: 220px;
}

@media (max-width: 760px) {
  .action-panel {
    justify-items: stretch;
    min-width: 0;
    width: 100%;
  }
}
</style>
