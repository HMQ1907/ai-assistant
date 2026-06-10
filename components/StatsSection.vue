<template>
  <section class="stats-section">
    <div class="section-heading">
      <h2>{{ title }}</h2>
      <p class="muted">{{ description }}</p>
    </div>

    <div class="stats-grid">
      <div v-for="card in summaryCards" :key="card.label" class="card stat-card">
        <span class="muted">{{ card.label }}</span>
        <strong>{{ card.value }}</strong>
      </div>
    </div>

    <div class="grid two detail-grid">
      <div class="card">
        <h3>Độ tin cậy</h3>
        <div class="kv">
          <div class="kv-row">
            <span class="muted">Trung bình Buy/Sell</span>
            <strong>{{ stats.avgConfidence }}%</strong>
          </div>
          <div class="kv-row">
            <span class="muted">Trung bình lệnh thắng</span>
            <strong>{{ stats.avgConfidenceOfWinners }}%</strong>
          </div>
          <div class="kv-row">
            <span class="muted">Trung bình lệnh thua</span>
            <strong>{{ stats.avgConfidenceOfLosers }}%</strong>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Tỷ lệ thắng</h3>
        <div class="win-rate">{{ stats.winRate }}%</div>
        <p class="muted">
          Tính bằng THẮNG / (THẮNG + THUA), không tính chưa cập nhật, hòa vốn
          và bỏ qua.
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PerformanceStatsSummary } from "~/types/trading";

const props = defineProps<{
  title: string;
  description: string;
  stats: PerformanceStatsSummary;
}>();

const summaryCards = computed(() => [
  { label: "Tổng phân tích", value: props.stats.totalAnalysis },
  { label: "Đã ghi kết quả", value: props.stats.totalTrades },
  { label: "THẮNG", value: props.stats.wins },
  { label: "THUA", value: props.stats.losses },
  { label: "HÒA VỐN", value: props.stats.breakevens },
  { label: "BỎ QUA", value: props.stats.skipped },
]);
</script>

<style scoped>
.stats-section {
  margin-top: 18px;
}
.section-heading {
  margin-bottom: 12px;
}
.section-heading h2,
.section-heading p {
  margin-bottom: 4px;
  margin-top: 0;
}
.stats-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(6, minmax(0, 1fr));
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
.detail-grid {
  margin-top: 12px;
}
@media (max-width: 920px) {
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 520px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>
