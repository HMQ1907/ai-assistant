<template>
  <section class="card">
    <h3>Technical analysis</h3>
    <div class="kv">
      <div class="kv-row"><span>Trend</span><span>{{ result.technical_analysis.trend }}</span></div>
      <div class="kv-row"><span>Momentum</span><span>{{ result.technical_analysis.momentum }}</span></div>
      <div class="kv-row"><span>S/R</span><span>{{ result.technical_analysis.support_resistance }}</span></div>
      <div class="kv-row"><span>Volatility</span><span>{{ result.technical_analysis.volatility }}</span></div>
      <div class="kv-row"><span>Timeframes</span><span>{{ result.technical_analysis.timeframe_alignment }}</span></div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from '~/types/ai'

defineProps<{ result: AiTradeRecommendation }>()
</script>
