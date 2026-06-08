<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>Thống kê hiệu quả XAUUSD</h1>
        <p>
          Thống kê kết quả người dùng đã ghi nhận sau khi tự giao dịch XAUUSD
          bên ngoài hệ thống.
        </p>
      </div>
      <button class="button" @click="loadStats">Tải lại</button>
    </div>

    <div v-if="error" class="card">
      <strong>Không tải được thống kê</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <section class="stats-grid">
      <div v-for="card in summaryCards" :key="card.label" class="card stat-card">
        <span class="muted">{{ card.label }}</span>
        <strong>{{ card.value }}</strong>
      </div>
    </section>

    <section class="grid two stats-section">
      <div class="card">
        <h2>Thống kê confidence</h2>
        <div class="kv">
          <div class="kv-row">
            <span class="muted">Độ tin cậy trung bình</span>
            <strong>{{ stats.avgConfidence }}%</strong>
          </div>
          <div class="kv-row">
            <span class="muted">Độ tin cậy trung bình của lệnh thắng</span>
            <strong>{{ stats.avgConfidenceOfWinners }}%</strong>
          </div>
          <div class="kv-row">
            <span class="muted">Độ tin cậy trung bình của lệnh thua</span>
            <strong>{{ stats.avgConfidenceOfLosers }}%</strong>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Tỷ lệ thắng</h2>
        <div class="win-rate">{{ stats.winRate }}%</div>
        <p class="muted">
          Tỷ lệ thắng = THẮNG / (THẮNG + THUA), không tính CHƯA CẬP NHẬT, HÒA
          VỐN và BỎ QUA.
        </p>
      </div>
    </section>

    <section class="stats-section">
      <div class="card">
        <h2>Hiệu suất XAUUSD</h2>
        <SymbolPerformanceTable :items="stats.bestSymbols" />
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { PerformanceStats } from "~/types/trading";

const emptyStats: PerformanceStats = {
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
  bestSymbols: [],
  worstSymbols: [],
};

const stats = ref<PerformanceStats>({ ...emptyStats });
const error = ref("");

const summaryCards = computed(() => [
  { label: "Tổng phân tích", value: stats.value.totalAnalysis },
  { label: "Giao dịch đã ghi nhận", value: stats.value.totalTrades },
  { label: "THẮNG", value: stats.value.wins },
  { label: "THUA", value: stats.value.losses },
  { label: "HÒA VỐN", value: stats.value.breakevens },
  { label: "BỎ QUA", value: stats.value.skipped },
]);

onMounted(loadStats);

async function loadStats(): Promise<void> {
  error.value = "";
  try {
    stats.value = await $fetch<PerformanceStats>("/api/stats");
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "Lỗi không xác định";
  }
}
</script>

<style scoped>
.stats-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}

.stat-card {
  display: grid;
  gap: 8px;
}

.stat-card strong,
.win-rate {
  font-size: 28px;
  font-weight: 800;
}

.stats-section {
  margin-top: 16px;
}

@media (max-width: 920px) {
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
