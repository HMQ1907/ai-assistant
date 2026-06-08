<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>Performance stats</h1>
        <p>Thong ke ket qua user da ghi nhan sau khi tu trade ben ngoai he thong.</p>
      </div>
      <button class="button" @click="loadStats">Refresh</button>
    </div>

    <div v-if="error" class="card">
      <strong>Stats failed</strong>
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
        <h2>Confidence stats</h2>
        <div class="kv">
          <div class="kv-row">
            <span class="muted">Average Confidence</span>
            <strong>{{ stats.avgConfidence }}%</strong>
          </div>
          <div class="kv-row">
            <span class="muted">Average Confidence Of Winners</span>
            <strong>{{ stats.avgConfidenceOfWinners }}%</strong>
          </div>
          <div class="kv-row">
            <span class="muted">Average Confidence Of Losers</span>
            <strong>{{ stats.avgConfidenceOfLosers }}%</strong>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Win rate</h2>
        <div class="win-rate">{{ stats.winRate }}%</div>
        <p class="muted">Win rate uses WIN / (WIN + LOSS), excluding PENDING, BREAKEVEN and SKIPPED.</p>
      </div>
    </section>

    <section class="grid two stats-section">
      <div class="card">
        <h2>Top Winning Symbols</h2>
        <SymbolPerformanceTable :items="stats.bestSymbols" />
      </div>
      <div class="card">
        <h2>Top Losing Symbols</h2>
        <SymbolPerformanceTable :items="stats.worstSymbols" />
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { PerformanceStats } from '~/types/trading'

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
  worstSymbols: []
}

const stats = ref<PerformanceStats>({ ...emptyStats })
const error = ref('')

const summaryCards = computed(() => [
  { label: 'Total Analysis', value: stats.value.totalAnalysis },
  { label: 'Total Trades Recorded', value: stats.value.totalTrades },
  { label: 'WIN', value: stats.value.wins },
  { label: 'LOSS', value: stats.value.losses },
  { label: 'BREAKEVEN', value: stats.value.breakevens },
  { label: 'SKIPPED', value: stats.value.skipped }
])

onMounted(loadStats)

async function loadStats(): Promise<void> {
  error.value = ''
  try {
    stats.value = await $fetch<PerformanceStats>('/api/stats')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Unknown error'
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
