<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>Thống kê hiệu quả XAUUSD</h1>
        <p>
          So sánh toàn bộ lượt phân tích với riêng các tín hiệu được hệ thống
          cho phép giao dịch.
        </p>
      </div>
      <button class="button" @click="loadStats">Tải lại</button>
    </div>

    <div v-if="error" class="card">
      <strong>Không tải được thống kê</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <StatsSection
      title="Các phân tích được phép TRADE"
      description="Chỉ tính những lần AI và validation trả kết quả TRADE."
      :stats="stats.tradeAnalyses"
    />

    <StatsSection
      title="Tổng tất cả phân tích"
      description="Bao gồm cả TRADE và NO_TRADE."
      :stats="stats.allAnalyses"
    />

    <section class="stats-section">
      <div class="card">
        <h2>Hiệu suất tín hiệu TRADE</h2>
        <SymbolPerformanceTable :items="stats.bestSymbols" />
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import StatsSection from "~/components/StatsSection.vue";
import type {
  PerformanceStats,
  PerformanceStatsSummary,
} from "~/types/trading";

const emptySummary = (): PerformanceStatsSummary => ({
  totalAnalysis: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  skipped: 0,
  winRate: 0,
  avgConfidence: 0,
  avgConfidenceOfWinners: 0,
  avgConfidenceOfLosers: 0,
});

const stats = ref<PerformanceStats>({
  ...emptySummary(),
  allAnalyses: emptySummary(),
  tradeAnalyses: emptySummary(),
  bestSymbols: [],
  worstSymbols: [],
});
const error = ref("");

onMounted(loadStats);

async function loadStats(): Promise<void> {
  error.value = "";
  try {
    stats.value = await $fetch<PerformanceStats>("/api/stats");
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : "Lỗi không xác định";
  }
}
</script>

<style scoped>
.stats-section {
  margin-top: 18px;
}
</style>
