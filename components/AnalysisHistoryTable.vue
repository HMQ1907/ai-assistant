<template>
  <section class="card">
    <h2>Lịch sử phân tích</h2>
    <div v-if="records.length === 0" class="muted">Chưa có phân tích.</div>
    <table v-else class="history-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Thời gian</th>
          <th>Khuyến nghị</th>
          <th>Symbol</th>
          <th>Hướng</th>
          <th>Độ tin cậy</th>
          <th>Kết quả</th>
          <th>Entry thực tế</th>
          <th>Exit thực tế</th>
          <th>P/L</th>
          <th>Ghi chú</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in records" :key="record.id">
          <td data-label="ID">
            <button
              class="history-id"
              :title="`Bấm để sao chép ID: ${record.id}`"
              type="button"
              @click="copyId(record.id)"
            >
              {{ copiedId === record.id ? "Đã sao chép" : record.id }}
            </button>
          </td>
          <td data-label="Thời gian">{{ formatTime(record.created_at) }}</td>
          <td data-label="Khuyến nghị">
            <span
              :class="[
                'badge',
                record.decision === 'TRADE' ? 'trade' : 'no-trade',
              ]"
            >
              {{ decisionLabel(record.decision) }}
            </span>
          </td>
          <td data-label="Symbol">{{ record.symbol }}</td>
          <td data-label="Hướng">
            <span :class="['direction-pill', directionClass(record.direction)]">
              {{ directionPillLabel(record.direction) }}
            </span>
          </td>
          <td data-label="Độ tin cậy">{{ record.confidence }}%</td>
          <td data-label="Kết quả">
            <select
              :value="drafts[record.id]?.result_status ?? record.result_status"
              class="select result-select"
              @change="setStatus(record.id, $event)"
            >
              <option v-for="status in statuses" :key="status" :value="status">
                {{ statusLabel(status) }}
              </option>
            </select>
          </td>
          <td data-label="Entry thực tế">
            <input
              :value="numberDraft(record.id, 'actual_entry', record.actual_entry)"
              class="input compact"
              type="number"
              step="0.00001"
              @input="setNumber(record.id, 'actual_entry', $event)"
            >
          </td>
          <td data-label="Exit thực tế">
            <input
              :value="numberDraft(record.id, 'actual_exit', record.actual_exit)"
              class="input compact"
              type="number"
              step="0.00001"
              @input="setNumber(record.id, 'actual_exit', $event)"
            >
          </td>
          <td data-label="P/L">
            <input
              :value="
                numberDraft(
                  record.id,
                  'actual_profit_loss',
                  record.actual_profit_loss,
                )
              "
              class="input compact"
              type="number"
              step="0.01"
              @input="setNumber(record.id, 'actual_profit_loss', $event)"
            >
          </td>
          <td data-label="Ghi chú">
            <input
              :value="drafts[record.id]?.user_note ?? record.user_note"
              class="input note-input"
              placeholder="Ghi chú"
              @input="setNote(record.id, $event)"
            >
          </td>
          <td data-label="Chi tiết">
            <button class="button small secondary" @click="emit('detail', record)">
              Chi tiết
            </button>
          </td>
          <td data-label="Lưu">
            <button class="button small" @click="save(record.id)">Lưu</button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import type {
  AnalysisHistoryRecord,
  ResultStatus,
  TradeDirection,
} from "~/types/trading";
import { decisionLabel, statusLabel } from "~/utils/display";

const props = defineProps<{ records: AnalysisHistoryRecord[] }>();
const emit = defineEmits<{
  updated: [record: AnalysisHistoryRecord];
  detail: [record: AnalysisHistoryRecord];
}>();

const statuses: ResultStatus[] = [
  "PENDING",
  "WIN",
  "LOSS",
  "BREAKEVEN",
  "SKIPPED",
];

type Draft = {
  result_status: ResultStatus;
  actual_entry: number | null;
  actual_exit: number | null;
  actual_profit_loss: number | null;
  user_note: string;
};

const drafts = reactive<Record<string, Draft>>({});
const copiedId = ref("");

watch(
  () => props.records,
  (records) => {
    for (const record of records) {
      drafts[record.id] = {
        result_status: record.result_status,
        actual_entry: record.actual_entry,
        actual_exit: record.actual_exit,
        actual_profit_loss: record.actual_profit_loss,
        user_note: record.user_note,
      };
    }
  },
  { immediate: true },
);

async function save(id: string): Promise<void> {
  const draft = drafts[id];
  if (!draft) return;
  const updated = await $fetch<AnalysisHistoryRecord>(`/api/history/${id}`, {
    method: "PATCH",
    body: draft,
  });
  emit("updated", updated);
}

async function copyId(id: string): Promise<void> {
  await navigator.clipboard.writeText(id);
  copiedId.value = id;
  window.setTimeout(() => {
    if (copiedId.value === id) copiedId.value = "";
  }, 1500);
}

function setStatus(id: string, event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  const value = target?.value;
  if (!isResultStatus(value)) return;
  drafts[id] ??= emptyDraft(value);
  drafts[id].result_status = value;
}

function setNote(id: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  drafts[id] ??= emptyDraft("PENDING");
  drafts[id].user_note = target?.value ?? "";
}

function setNumber(
  id: string,
  key: "actual_entry" | "actual_exit" | "actual_profit_loss",
  event: Event,
): void {
  const target = event.target as HTMLInputElement | null;
  drafts[id] ??= emptyDraft("PENDING");
  const value = target?.value ? Number(target.value) : null;
  drafts[id][key] = value;

  if (
    key === "actual_profit_loss" &&
    value !== null &&
    drafts[id].result_status === "PENDING"
  ) {
    drafts[id].result_status = inferStatusFromProfitLoss(value);
  }
}

function numberDraft(
  id: string,
  key: "actual_entry" | "actual_exit" | "actual_profit_loss",
  defaultValue: number | null,
): string {
  const value = drafts[id]?.[key] ?? defaultValue;
  return value === null ? "" : String(value);
}

function emptyDraft(status: ResultStatus): Draft {
  return {
    result_status: status,
    actual_entry: null,
    actual_exit: null,
    actual_profit_loss: null,
    user_note: "",
  };
}

function isResultStatus(value: string | undefined): value is ResultStatus {
  return (
    value === "PENDING" ||
    value === "WIN" ||
    value === "LOSS" ||
    value === "BREAKEVEN" ||
    value === "SKIPPED"
  );
}

function inferStatusFromProfitLoss(value: number): ResultStatus {
  if (value > 0) return "WIN";
  if (value < 0) return "LOSS";
  return "BREAKEVEN";
}

function directionPillLabel(value: TradeDirection): string {
  if (value === "BUY") return "Buy";
  if (value === "SELL") return "Sell";
  return "Không vào";
}

function directionClass(value: TradeDirection): string {
  if (value === "BUY") return "buy";
  if (value === "SELL") return "sell";
  return "none";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}
</script>

<style scoped>
.small {
  min-height: 34px;
  padding: 0 10px;
}

.secondary {
  background: #263344;
}

.compact {
  min-width: 92px;
}

.note-input {
  min-width: 82px;
}

.result-select {
  min-width: 106px;
}

.history-id {
  background: transparent;
  border: 0;
  color: #7cc4ff;
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  max-width: 150px;
  overflow: hidden;
  padding: 0;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-id:hover {
  text-decoration: underline;
}

.direction-pill {
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 999px;
  display: inline-flex;
  font-size: 12px;
  font-weight: 800;
  min-height: 30px;
  padding: 4px 10px;
}

.direction-pill.buy {
  border-color: rgba(54, 197, 138, 0.72);
  color: var(--green);
}

.direction-pill.sell {
  border-color: rgba(239, 107, 115, 0.72);
  color: var(--red);
}

.direction-pill.none {
  border-color: #66717c;
  color: var(--muted);
}

@media (max-width: 820px) {
  .history-table,
  .history-table tbody,
  .history-table tr,
  .history-table td {
    display: block;
    width: 100%;
  }

  .history-table {
    border-collapse: separate;
    border-spacing: 0 12px;
  }

  .history-table thead {
    display: none;
  }

  .history-table tr {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.015);
  }

  .history-table td {
    align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(104px, 0.42fr) minmax(0, 1fr);
    min-height: 48px;
    padding: 10px 12px;
  }

  .history-table td::before {
    color: var(--muted);
    content: attr(data-label);
    font-size: 13px;
    font-weight: 700;
  }

  .history-table td:last-child {
    border-bottom: 0;
  }

  .compact,
  .note-input,
  .result-select {
    min-width: 0;
  }

  .small {
    width: 100%;
  }
}

@media (max-width: 420px) {
  .history-table td {
    align-items: stretch;
    grid-template-columns: 1fr;
  }
}
</style>
