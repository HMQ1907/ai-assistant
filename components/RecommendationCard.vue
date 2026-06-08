<template>
  <section class="grid">
    <div class="card">
      <div class="summary-head">
        <span :class="['badge', result.decision === 'TRADE' ? 'trade' : 'no-trade']">{{ result.decision }}</span>
        <strong>{{ result.symbol }} / {{ result.direction }}</strong>
      </div>
      <p>{{ result.summary }}</p>
      <ConfidenceBar :value="result.confidence" />
      <p class="muted">{{ result.disclaimer }}</p>
      <p v-if="result.no_trade_reason" class="muted"><strong>No trade:</strong> {{ result.no_trade_reason }}</p>
      <p v-if="result.next_check_suggestion" class="muted"><strong>Check lai:</strong> {{ result.next_check_suggestion }}</p>
    </div>

    <div class="grid three">
      <TradeLevelsCard :result="result" />
      <TechnicalAnalysisCard :result="result" />
      <NewsAnalysisCard :result="result" />
    </div>

    <div class="grid two">
      <section class="card">
        <h3>Why this symbol</h3>
        <p class="muted">{{ result.why_this_symbol }}</p>
        <h3>Why not others</h3>
        <ul class="list">
          <li v-for="item in result.why_not_others" :key="item">{{ item }}</li>
        </ul>
      </section>

      <section class="card">
        <h3>Main reasons</h3>
        <ul class="list">
          <li v-for="item in result.main_reasons" :key="item">{{ item }}</li>
        </ul>
        <h3>Scenarios</h3>
        <p class="muted"><strong>Best:</strong> {{ result.best_case_scenario }}</p>
        <p class="muted"><strong>Worst:</strong> {{ result.worst_case_scenario }}</p>
      </section>
    </div>

    <div class="grid two">
      <RiskFactorsCard :result="result" />
      <PreEntryChecklist :result="result" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from '~/types/ai'

defineProps<{ result: AiTradeRecommendation }>()
</script>

<style scoped>
.summary-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
</style>
