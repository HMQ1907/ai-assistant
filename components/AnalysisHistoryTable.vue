<template>
  <section class="card">
    <h2>Analysis history</h2>
    <div v-if="records.length === 0" class="muted">No analysis yet.</div>
    <table v-else class="history-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Decision</th>
          <th>Symbol</th>
          <th>Direction</th>
          <th>Confidence</th>
          <th>Status</th>
          <th>Note</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in records" :key="record.id">
          <td>{{ formatTime(record.created_at) }}</td>
          <td><span :class="['badge', record.decision === 'TRADE' ? 'trade' : 'no-trade']">{{ record.decision }}</span></td>
          <td>{{ record.symbol }}</td>
          <td>{{ record.direction }}</td>
          <td>{{ record.confidence }}%</td>
          <td>
            <select :value="drafts[record.id]?.result_status ?? record.result_status" class="select" @change="setStatus(record.id, $event)">
              <option>PENDING</option>
              <option>WIN</option>
              <option>LOSS</option>
              <option>SKIPPED</option>
            </select>
          </td>
          <td>
            <input
              :value="drafts[record.id]?.user_note ?? record.user_note"
              class="input"
              placeholder="Personal note"
              @input="setNote(record.id, $event)"
            />
          </td>
          <td>
            <button class="button small" @click="save(record.id)">Save</button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import type { AnalysisHistoryRecord, ResultStatus } from '~/types/trading'

const props = defineProps<{ records: AnalysisHistoryRecord[] }>()
const emit = defineEmits<{ updated: [record: AnalysisHistoryRecord] }>()

const drafts = reactive<Record<number, { result_status: ResultStatus; user_note: string }>>({})

watch(
  () => props.records,
  (records) => {
    for (const record of records) {
      drafts[record.id] = {
        result_status: record.result_status,
        user_note: record.user_note
      }
    }
  },
  { immediate: true }
)

async function save(id: number): Promise<void> {
  const draft = drafts[id]
  if (!draft) return
  const updated = await $fetch<AnalysisHistoryRecord>(`/api/history/${id}`, {
    method: 'PATCH',
    body: draft
  })
  emit('updated', updated)
}

function setStatus(id: number, event: Event): void {
  const target = event.target as HTMLSelectElement | null
  const value = target?.value
  if (value !== 'PENDING' && value !== 'WIN' && value !== 'LOSS' && value !== 'SKIPPED') return
  drafts[id] ??= { result_status: value, user_note: '' }
  drafts[id].result_status = value
}

function setNote(id: number, event: Event): void {
  const target = event.target as HTMLInputElement | null
  drafts[id] ??= { result_status: 'PENDING', user_note: '' }
  drafts[id].user_note = target?.value ?? ''
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value))
}
</script>

<style scoped>
.small {
  min-height: 34px;
  padding: 0 10px;
}
</style>
