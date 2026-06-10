<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>Lịch sử</h1>
        <p>
          Cập nhật kết quả giao dịch {{ symbol }} người dùng đã tự thực hiện bên ngoài
          hệ thống.
        </p>
      </div>
    </div>

    <AnalysisHistoryTable
      :records="history"
      @detail="showDetail"
      @updated="replaceHistoryRecord"
    />

    <section v-if="selectedRecord && selectedResult" class="detail-block">
      <div class="detail-head">
        <h2>Chi tiết phân tích</h2>
        <button class="button small secondary" @click="selectedRecord = null">
          Đóng
        </button>
      </div>
      <RecommendationCard :history="selectedRecord" :result="selectedResult" />
    </section>
  </main>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";
import type { AnalysisHistoryRecord } from "~/types/trading";

const props = defineProps<{ symbol: "XAUUSD" | "BTCUSD" }>();
const history = ref<AnalysisHistoryRecord[]>([]);
const selectedRecord = ref<AnalysisHistoryRecord | null>(null);
const selectedResult = computed(() =>
  isAiTradeRecommendation(selectedRecord.value?.parsed_result)
    ? selectedRecord.value.parsed_result
    : null,
);

onMounted(async () => {
  history.value = await $fetch<AnalysisHistoryRecord[]>("/api/history", {
    query: { symbol: props.symbol },
  });
});

function showDetail(record: AnalysisHistoryRecord): void {
  selectedRecord.value = record;
}

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) =>
    item.id === record.id ? record : item,
  );
  if (selectedRecord.value?.id === record.id) {
    selectedRecord.value = record;
  }
}

function isAiTradeRecommendation(
  value: unknown,
): value is AiTradeRecommendation {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AiTradeRecommendation>;
  return (
    record.symbol === props.symbol &&
    (record.decision === "TRADE" || record.decision === "NO_TRADE") &&
    typeof record.summary === "string" &&
    typeof record.position_sizing === "object"
  );
}
</script>

<style scoped>
.detail-block {
  margin-top: 18px;
}

.detail-head {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}

.small {
  min-height: 34px;
  padding: 0 10px;
}

.secondary {
  background: #263344;
}
</style>
