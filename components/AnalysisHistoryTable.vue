<template>
  <section class="card">
    <h2>Lịch sử phân tích</h2>
    <div v-if="records.length === 0" class="muted">Chưa có phân tích.</div>
    <div v-else class="history-table-wrap">
    <table class="history-table">
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
          <th>Thao tác</th>
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
          <td data-label="Thao tác" class="actions-cell">
            <div class="row-actions">
              <button
                class="action-button action-button-secondary"
                type="button"
                @click="emit('detail', record)"
              >
                Chi tiết
              </button>
              <button
                class="action-button action-button-secondary review-button"
                type="button"
                :disabled="checkingId === record.id"
                @click="reviewOrder(record)"
              >
                {{ checkingId === record.id ? "Đang kiểm tra..." : "Check lại lệnh" }}
              </button>
              <button
                class="action-button action-button-primary"
                type="button"
                @click="save(record.id)"
              >
                Lưu
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    </div>

    <p v-if="reviewError" class="review-error">{{ reviewError }}</p>

    <section v-if="reviewResult" class="review-panel">
      <div class="review-head">
        <div>
          <p class="review-eyebrow">AI check lại lệnh</p>
          <h3>{{ actionLabel(reviewResult.recommended_action) }}</h3>
        </div>
        <button class="button small secondary" @click="reviewResult = null">
          Đóng
        </button>
      </div>

      <div class="review-grid">
        <div>
          <span>ID lịch sử</span>
          <strong>{{ reviewResult.reviewed_history_id }}</strong>
        </div>
        <div>
          <span>Giá hiện tại</span>
          <strong>{{ formatPrice(reviewResult.current_price) }}</strong>
        </div>
        <div>
          <span>Khả năng khớp</span>
          <strong>{{ reviewStatusLabel(reviewResult.order_status_assessment) }}</strong>
        </div>
        <div>
          <span>Độ tin cậy</span>
          <strong>{{ reviewResult.confidence }}%</strong>
        </div>
      </div>

      <p>{{ reviewResult.summary }}</p>
      <p class="muted">
        <strong>Đánh giá khớp lệnh:</strong> {{ reviewResult.fill_assessment }}
      </p>
      <p class="muted">
        <strong>Lý do hành động:</strong> {{ reviewResult.action_reason }}
      </p>

      <div class="grid two">
        <section>
          <h4>Stop loss</h4>
          <p class="muted">{{ reviewResult.stop_loss_plan.reason }}</p>
          <strong v-if="reviewResult.stop_loss_plan.suggested_stop_loss !== null">
            SL đề xuất: {{ formatPrice(reviewResult.stop_loss_plan.suggested_stop_loss) }}
          </strong>
        </section>
        <section>
          <h4>Take profit</h4>
          <p class="muted">{{ reviewResult.take_profit_plan.reason }}</p>
          <strong v-if="reviewResult.take_profit_plan.suggested_take_profit !== null">
            TP đề xuất: {{ formatPrice(reviewResult.take_profit_plan.suggested_take_profit) }}
          </strong>
        </section>
      </div>

      <div class="grid two">
        <section>
          <h4>Điều kiện hủy</h4>
          <ul class="list">
            <li v-for="item in listOrDash(reviewResult.cancellation_conditions)" :key="item">
              {{ item }}
            </li>
          </ul>
        </section>
        <section>
          <h4>Rủi ro</h4>
          <ul class="list">
            <li v-for="item in listOrDash(reviewResult.risk_warnings)" :key="item">
              {{ item }}
            </li>
          </ul>
        </section>
      </div>

      <h4>Checklist thủ công</h4>
      <ul class="list">
        <li v-for="item in listOrDash(reviewResult.checklist)" :key="item">
          {{ item }}
        </li>
      </ul>
      <p class="muted">
        Nên check lại sau {{ reviewResult.next_check_minutes }} phút.
        {{ reviewResult.disclaimer }}
      </p>
    </section>
  </section>
</template>

<script setup lang="ts">
import type { AiOrderReview } from "~/types/ai";
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
const checkingId = ref("");
const reviewResult = ref<AiOrderReview | null>(null);
const reviewError = ref("");

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

async function reviewOrder(record: AnalysisHistoryRecord): Promise<void> {
  checkingId.value = record.id;
  reviewResult.value = null;
  reviewError.value = "";
  try {
    const draft = drafts[record.id] ?? {
      result_status: record.result_status,
      actual_entry: record.actual_entry,
      actual_exit: record.actual_exit,
      actual_profit_loss: record.actual_profit_loss,
      user_note: record.user_note,
    };
    const response = await $fetch<{ review: AiOrderReview }>(
      `/api/history/${record.id}/review`,
      {
        method: "POST",
        body: draft,
      },
    );
    reviewResult.value = response.review;
  } catch (error) {
    reviewError.value =
      error instanceof Error ? error.message : "Không check lại được lệnh.";
  } finally {
    checkingId.value = "";
  }
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

function actionLabel(value: AiOrderReview["recommended_action"]): string {
  const labels: Record<AiOrderReview["recommended_action"], string> = {
    KEEP_ORDER: "Giữ nguyên lệnh",
    CANCEL_ORDER: "Hủy lệnh chờ",
    MOVE_SL: "Dời stop loss",
    MOVE_TP: "Dời take profit",
    MOVE_SL_TP: "Dời stop loss và take profit",
    WAIT: "Chờ thêm",
    CLOSE_MANUALLY: "Cân nhắc đóng thủ công",
    TRADE_COMPLETED: "Giao dịch đã hoàn tất",
  };
  return labels[value];
}

function reviewStatusLabel(
  value: AiOrderReview["order_status_assessment"],
): string {
  const labels: Record<AiOrderReview["order_status_assessment"], string> = {
    LIKELY_NOT_FILLED: "Có thể chưa khớp",
    LIKELY_FILLED: "Có thể đã khớp",
    ALREADY_INVALIDATED: "Kèo đã bị vô hiệu",
    UNCLEAR: "Chưa xác định",
  };
  return labels[value];
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "Không rõ";
  }
  return value.toFixed(2);
}

const listOrDash = (items: string[]) => (items.length ? items : ["Không có."]);
</script>

<style scoped>
.history-table-wrap {
  margin: 0 -4px;
  overflow-x: auto;
  padding: 0 4px 6px;
  scrollbar-color: #465666 transparent;
  scrollbar-width: thin;
}

.history-table {
  min-width: 1120px;
  table-layout: fixed;
}

.history-table th {
  color: #aebdca;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  padding-bottom: 12px;
  text-transform: uppercase;
  white-space: nowrap;
}

.history-table td {
  height: 68px;
  vertical-align: middle;
}

.history-table tbody tr {
  transition: background-color 150ms ease;
}

.history-table tbody tr:hover {
  background: rgba(101, 166, 255, 0.035);
}

.history-table th:nth-child(1) {
  width: 110px;
}

.history-table th:nth-child(2) {
  width: 112px;
}

.history-table th:nth-child(3) {
  width: 118px;
}

.history-table th:nth-child(4) {
  width: 78px;
}

.history-table th:nth-child(5) {
  width: 76px;
}

.history-table th:nth-child(6) {
  width: 88px;
}

.history-table th:nth-child(7) {
  width: 134px;
}

.history-table th:nth-child(8),
.history-table th:nth-child(9),
.history-table th:nth-child(10) {
  width: 116px;
}

.history-table th:nth-child(11) {
  width: 130px;
}

.history-table th:nth-child(12) {
  width: 236px;
}

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
  max-width: 96px;
  overflow: hidden;
  padding: 0;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-id:hover {
  text-decoration: underline;
}

.row-actions {
  display: grid;
  gap: 7px;
  grid-template-columns: 70px minmax(104px, 1fr) 52px;
}

.action-button {
  align-items: center;
  border: 1px solid #425264;
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  font-size: 12px;
  font-weight: 750;
  justify-content: center;
  line-height: 1.15;
  min-height: 34px;
  padding: 6px 9px;
  white-space: nowrap;
}

.action-button:disabled {
  cursor: wait;
  opacity: 0.62;
}

.action-button-secondary {
  background: #202a34;
}

.action-button-secondary:hover:not(:disabled) {
  background: #293746;
  border-color: #5c7186;
}

.action-button-primary {
  background: #1f63ad;
  border-color: #4777b8;
}

.action-button-primary:hover {
  background: #2772c4;
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

.review-panel {
  border-top: 1px solid var(--border);
  margin-top: 18px;
  padding-top: 18px;
}

.review-head {
  align-items: flex-start;
  display: flex;
  gap: 12px;
  justify-content: space-between;
}

.review-eyebrow {
  color: #7cc4ff;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.12em;
  margin: 0 0 6px;
  text-transform: uppercase;
}

.review-head h3 {
  margin-top: 0;
}

.review-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 12px 0;
}

.review-grid div {
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
  padding: 10px;
}

.review-grid span {
  color: var(--muted);
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}

.review-grid strong {
  overflow-wrap: anywhere;
}

.review-error {
  color: var(--red);
  margin-top: 14px;
}

@media (max-width: 820px) {
  :deep(.card) {
    min-width: 0;
  }

  .history-table-wrap {
    margin: 0;
    max-width: 100%;
    overflow: visible;
    padding: 0;
  }

  .history-table,
  .history-table tbody,
  .history-table tr,
  .history-table td {
    display: block;
    width: 100%;
  }

  .history-table {
    border-collapse: separate;
    border-spacing: 0 18px;
    min-width: 0;
    table-layout: auto;
  }

  .history-table thead {
    display: none;
  }

  .history-table tr {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #192027;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
    max-width: 100%;
    overflow: hidden;
  }

  /* Mặc định: nhãn trái – giá trị phải, gọn trên một dòng cho ô chỉ-đọc */
  .history-table td {
    align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    display: flex;
    gap: 12px;
    height: auto;
    justify-content: space-between;
    min-height: 46px;
    max-width: 100%;
    overflow: hidden;
    padding: 11px 14px;
  }

  .history-table td::before {
    color: var(--muted);
    content: attr(data-label);
    flex: 0 0 auto;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  /* Giá trị căn phải, không tràn, nổi bật hơn nhãn */
  .history-table td > * {
    color: var(--text);
    font-weight: 600;
    min-width: 0;
    text-align: right;
  }

  .history-table td:last-child {
    border-bottom: 0;
  }

  .history-table td[data-label="ID"] {
    background: rgba(101, 166, 255, 0.035);
  }

  .history-id {
    display: block;
    flex: 1 1 auto;
    max-width: min(220px, 62vw);
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    width: 100%;
  }

  /* Các ô nhập liệu: nhãn trên, ô input chiếm trọn chiều ngang bên dưới */
  .history-table td[data-label="Entry thực tế"],
  .history-table td[data-label="Exit thực tế"],
  .history-table td[data-label="P/L"],
  .history-table td[data-label="Ghi chú"],
  .history-table td[data-label="Kết quả"],
  .history-table td[data-label="Thao tác"] {
    align-items: stretch;
    flex-direction: column;
    gap: 6px;
  }

  .history-table td[data-label="Kết quả"] {
    background: #151c23;
    border-top: 8px solid var(--bg);
    margin-top: -1px;
    padding-top: 14px;
  }

  .history-table td[data-label="Entry thực tế"],
  .history-table td[data-label="Exit thực tế"],
  .history-table td[data-label="P/L"],
  .history-table td[data-label="Ghi chú"] {
    background: #151c23;
  }

  .history-table td[data-label="Thao tác"] {
    background: #121920;
    border-top: 8px solid var(--bg);
    margin-top: -1px;
    padding-bottom: 14px;
    padding-top: 14px;
  }

  .history-table td[data-label="Entry thực tế"]::before,
  .history-table td[data-label="Exit thực tế"]::before,
  .history-table td[data-label="P/L"]::before,
  .history-table td[data-label="Ghi chú"]::before,
  .history-table td[data-label="Kết quả"]::before,
  .history-table td[data-label="Thao tác"]::before {
    text-align: left;
  }

  .history-table td[data-label="Entry thực tế"] > *,
  .history-table td[data-label="Exit thực tế"] > *,
  .history-table td[data-label="P/L"] > *,
  .history-table td[data-label="Ghi chú"] > *,
  .history-table td[data-label="Kết quả"] > * {
    text-align: left;
    width: 100%;
  }

  .compact,
  .note-input,
  .result-select {
    display: block;
    max-width: 100%;
    min-width: 0;
    width: 100%;
  }

  .row-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-width: 100%;
    width: 100%;
  }

  .action-button {
    max-width: 100%;
    min-height: 42px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .action-button-primary {
    grid-column: 1 / -1;
    display: inline-flex;
  }

  .review-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 420px) {
  .history-table td {
    padding: 11px 12px;
  }

  .history-table td:not(
      [data-label="Entry thực tế"],
      [data-label="Exit thực tế"],
      [data-label="P/L"],
      [data-label="Ghi chú"],
      [data-label="Kết quả"],
      [data-label="Thao tác"]
    ) {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  .history-table td:not(
      [data-label="Entry thực tế"],
      [data-label="Exit thực tế"],
      [data-label="P/L"],
      [data-label="Ghi chú"],
      [data-label="Kết quả"],
      [data-label="Thao tác"]
    ) > * {
    text-align: left;
  }

  .history-id {
    max-width: 100%;
    text-align: left;
  }

  .row-actions {
    grid-template-columns: 1fr;
  }

  .action-button-primary {
    grid-column: auto;
  }

  .review-grid {
    grid-template-columns: 1fr;
  }
}
</style>
