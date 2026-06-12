<template>
  <p v-if="items.length === 0" class="muted">
    Chưa có kết quả nào được ghi nhận.
  </p>
  <div v-else class="perf-table-wrap">
    <table class="history-table perf-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Lệnh</th>
          <th>Thắng</th>
          <th>Thua</th>
          <th>P/L</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.symbol">
          <td data-label="Symbol">{{ item.symbol }}</td>
          <td data-label="Lệnh">{{ item.trades }}</td>
          <td data-label="Thắng">{{ item.wins }}</td>
          <td data-label="Thua">{{ item.losses }}</td>
          <td data-label="P/L">{{ item.totalProfitLoss.toFixed(2) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import type { SymbolPerformance } from "~/types/trading";

defineProps<{ items: SymbolPerformance[] }>();
</script>

<style scoped>
.perf-table-wrap {
  overflow-x: auto;
}

@media (max-width: 620px) {
  .perf-table-wrap {
    overflow: visible;
  }

  .perf-table,
  .perf-table tbody,
  .perf-table tr,
  .perf-table td {
    display: block;
    width: 100%;
  }

  .perf-table {
    border-spacing: 0 10px;
    border-collapse: separate;
  }

  .perf-table thead {
    display: none;
  }

  .perf-table tr {
    background: #192027;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .perf-table td {
    align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 12px;
  }

  .perf-table td::before {
    color: var(--muted);
    content: attr(data-label);
    font-size: 13px;
    font-weight: 700;
  }

  .perf-table td:last-child {
    border-bottom: 0;
  }
}
</style>
