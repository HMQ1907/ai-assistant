<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>Manual trading assistant</h1>
        <p>Quet XAUUSD, crypto, forex va indices. Tool chi phan tich, khong dat lenh.</p>
      </div>
      <AnalyzeButton :loading="loading" @analyze="analyze" />
    </div>

    <div v-if="error" class="card">
      <strong>Analysis failed</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <div v-if="loading" class="card">
      <strong>Dang thu thap market data, news va goi AI...</strong>
      <p class="muted">Timeout AI co the mat 60-120 giay neu dung Evolink that.</p>
    </div>

    <RecommendationCard v-if="result" :result="result" />

    <AnalysisHistoryTable :records="history" class="history-block" @updated="replaceHistoryRecord" />
  </main>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from '~/types/ai'
import type { AnalysisHistoryRecord } from '~/types/trading'

const loading = ref(false)
const error = ref('')
const result = ref<AiTradeRecommendation | null>(null)
const history = ref<AnalysisHistoryRecord[]>([])

onMounted(loadHistory)

async function analyze(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const response = await $fetch<{ result: AiTradeRecommendation; history: AnalysisHistoryRecord }>('/api/analyze', {
      method: 'POST'
    })
    result.value = response.result
    history.value = [response.history, ...history.value.filter((record) => record.id !== response.history.id)]
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Unknown error'
  } finally {
    loading.value = false
  }
}

async function loadHistory(): Promise<void> {
  history.value = await $fetch<AnalysisHistoryRecord[]>('/api/history')
}

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) => (item.id === record.id ? record : item))
}
</script>

<style scoped>
.history-block {
  margin-top: 16px;
}
</style>
