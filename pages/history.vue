<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>History</h1>
        <p>Danh dau lenh da vao, WIN, LOSS, SKIPPED va ghi chu ca nhan.</p>
      </div>
    </div>
    <AnalysisHistoryTable :records="history" @updated="replaceHistoryRecord" />
  </main>
</template>

<script setup lang="ts">
import type { AnalysisHistoryRecord } from '~/types/trading'

const history = ref<AnalysisHistoryRecord[]>([])

onMounted(async () => {
  history.value = await $fetch<AnalysisHistoryRecord[]>('/api/history')
})

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) => (item.id === record.id ? record : item))
}
</script>
