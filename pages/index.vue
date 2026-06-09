<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>AI XAUUSD Trading Assistant</h1>
        <p>
          Phân tích XAUUSD bằng dữ liệu thị trường thật và tin tức thật. Công cụ
          chỉ đưa gợi ý giao dịch thủ công, không đặt lệnh.
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
        <AnalyzeButton :loading="loading" @analyze="analyze" />
      </div>
    </div>

    <div v-if="error" class="card">
      <strong>Phân tích thất bại</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <div v-if="loading" class="card">
      <strong>
        Đang lấy dữ liệu XAUUSD, tin tức và gửi AI phân tích...
      </strong>
      <p class="muted">Quá trình này có thể mất 60-120 giây.</p>
    </div>

    <RecommendationCard
      v-if="result"
      :history="latestHistory"
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
const accountSizeUsd = ref(70);
const latestHistory = computed(() =>
  result.value ? (history.value[0] ?? null) : null,
);

async function analyze(): Promise<void> {
  loading.value = true;
  error.value = "";
  hasAnalyzed.value = true;
  try {
    const response = await $fetch<{
      result: AiTradeRecommendation;
      history: AnalysisHistoryRecord;
    }>("/api/analyze", {
      method: "POST",
      body: {
        accountSizeUsd: normalizeAccountSize(accountSizeUsd.value),
      },
    });
    result.value = response.result;
    history.value = [
      response.history,
      ...history.value.filter((record) => record.id !== response.history.id),
    ];
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : "Lỗi không xác định";
  } finally {
    loading.value = false;
  }
}

function normalizeAccountSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Number(value) : 70;
}

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) =>
    item.id === record.id ? record : item,
  );
}
</script>

<style scoped>
.history-block {
  margin-top: 16px;
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

@media (max-width: 760px) {
  .action-panel {
    justify-items: stretch;
    min-width: 0;
    width: 100%;
  }
}
</style>
