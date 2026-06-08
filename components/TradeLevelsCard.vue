<template>
  <section class="card">
    <h3>Entry / SL / TP</h3>
    <div class="kv">
      <div class="kv-row"><span>Entry zone</span><strong>{{ result.entry_zone.from }} - {{ result.entry_zone.to }}</strong></div>
      <div class="kv-row"><span>Stop loss</span><strong>{{ result.stop_loss }}</strong></div>
      <div class="kv-row"><span>Take profit</span><strong>{{ result.take_profit }}</strong></div>
      <div class="kv-row"><span>Risk reward</span><strong>{{ result.risk_reward }}</strong></div>
      <div class="kv-row"><span>Holding time</span><strong>{{ result.expected_holding_time }}</strong></div>
      <div class="kv-row"><span>Risk</span><strong>{{ result.position_sizing.risk_percent }}% / ${{ result.position_sizing.max_loss_usd }}</strong></div>
      <p class="muted">{{ result.position_sizing.suggested_lot }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from '~/types/ai'

defineProps<{ result: AiTradeRecommendation }>()
</script>
