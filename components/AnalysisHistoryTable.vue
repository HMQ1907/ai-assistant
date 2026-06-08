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
          <th>Actual Entry</th>
          <th>Actual Exit</th>
          <th>P/L</th>
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
              <option>BREAKEVEN</option>
              <option>SKIPPED</option>
            </select>
          </td>
          <td>
            <input
              :value="numberDraft(record.id, 'actual_entry', record.actual_entry)"
              class="input compact"
              type="number"
              step="0.00001"
              @input="setNumber(record.id, 'actual_entry', $event)"
            />
          </td>
          <td>
            <input
              :value="numberDraft(record.id, 'actual_exit', record.actual_exit)"
              class="input compact"
              type="number"
              step="0.00001"
              @input="setNumber(record.id, 'actual_exit', $event)"
            />
          </td>
          <td>
            <input
              :value="numberDraft(record.id, 'actual_profit_loss', record.actual_profit_loss)"
              class="input compact"
              type="number"
              step="0.01"
              @input="setNumber(record.id, 'actual_profit_loss', $event)"
            />
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

type Draft = {
  result_status: ResultStatus
  actual_entry: number | null
  actual_exit: number | null
  actual_profit_loss: number | null
  user_note: string
}

const drafts = reactive<Record<string, Draft>>({})

watch(
  () => props.records,
  (records) => {
    for (const record of records) {
      drafts[record.id] = {
        result_status: record.result_status,
        actual_entry: record.actual_entry,
        actual_exit: record.actual_exit,
        actual_profit_loss: record.actual_profit_loss,
        user_note: record.user_note
      }
    }
  },
  { immediate: true }
)

async function save(id: string): Promise<void> {
  const draft = drafts[id]
  if (!draft) return
  const updated = await $fetch<AnalysisHistoryRecord>(`/api/history/${id}`, {
    method: 'PATCH',
    body: draft
  })
  emit('updated', updated)
}

function setStatus(id: string, event: Event): void {
  const target = event.target as HTMLSelectElement | null
  const value = target?.value
  if (value !== 'PENDING' && value !== 'WIN' && value !== 'LOSS' && value !== 'BREAKEVEN' && value !== 'SKIPPED') return
  drafts[id] ??= emptyDraft(value)
  drafts[id].result_status = value
}

function setNote(id: string, event: Event): void {
  const target = event.target as HTMLInputElement | null
  drafts[id] ??= emptyDraft('PENDING')
  drafts[id].user_note = target?.value ?? ''
}

function setNumber(id: string, key: 'actual_entry' | 'actual_exit' | 'actual_profit_loss', event: Event): void {
  const target = event.target as HTMLInputElement | null
  drafts[id] ??= emptyDraft('PENDING')
  drafts[id][key] = target?.value ? Number(target.value) : null
}

function numberDraft(id: string, key: 'actual_entry' | 'actual_exit' | 'actual_profit_loss', fallback: number | null): string {
  const value = drafts[id]?.[key] ?? fallback
  return value === null ? '' : String(value)
}

function emptyDraft(status: ResultStatus): Draft {
  return {
    result_status: status,
    actual_entry: null,
    actual_exit: null,
    actual_profit_loss: null,
    user_note: ''
  }
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

.compact {
  min-width: 92px;
}
</style>
