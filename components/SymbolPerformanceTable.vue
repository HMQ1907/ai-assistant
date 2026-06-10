<template>
  <p v-if="items.length === 0" class="muted">
    Chưa có kết quả giao dịch nào được ghi nhận.
  </p>
  <table v-else class="history-table">
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
        <td>{{ item.symbol }}</td>
        <td>{{ item.trades }}</td>
        <td>{{ item.wins }}</td>
        <td>{{ item.losses }}</td>
        <td>{{ item.totalProfitLoss.toFixed(2) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup lang="ts">
import type { SymbolPerformance } from "~/types/trading";

defineProps<{ items: SymbolPerformance[] }>();
</script>
