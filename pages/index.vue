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
      <AnalyzeButton :loading="loading" @analyze="analyze" />
    </div>

    <div v-if="error" class="card">
      <strong>Phân tích thất bại</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <div v-if="loading" class="card">
      <strong>
        Đang lấy dữ liệu XAUUSD thật, tin tức thật và gửi AI phân tích...
      </strong>
      <p class="muted">Quá trình này có thể mất 60-120 giây tùy provider.</p>
    </div>

    <RecommendationCard
      v-if="result"
      :history="latestHistory"
      :result="result"
    />

    <AnalysisHistoryTable
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
const latestHistory = computed(() =>
  result.value ? (history.value[0] ?? null) : null,
);

onMounted(loadHistory);

async function analyze(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const response = await $fetch<{
      result: AiTradeRecommendation;
      history: AnalysisHistoryRecord;
    }>("/api/analyze", {
      method: "POST",
    });
    result.value = response.result;
    history.value = [
      response.history,
      ...history.value.filter((record) => record.id !== response.history.id),
    ];
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "Lỗi không xác định";
  } finally {
    loading.value = false;
  }
}

async function loadHistory(): Promise<void> {
  history.value = await $fetch<AnalysisHistoryRecord[]>("/api/history");
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
</style>
