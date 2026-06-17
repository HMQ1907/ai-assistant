<template>
  <section class="card active-orders">
    <div class="panel-head">
      <div>
        <h2>Check lệnh MT5 đang giữ</h2>
        <p class="muted">
          Quét lệnh chờ/vị thế mở trên MT5 và nhờ AI đề xuất giữ, hủy/đóng,
          hoặc dời SL/TP.
        </p>
      </div>
      <button class="button" :disabled="loading" type="button" @click="reviewActiveOrders">
        {{ loading ? "Đang check..." : "Check lệnh đang giữ" }}
      </button>
    </div>

    <p v-if="error" class="review-error">{{ error }}</p>

    <p v-if="checked && reviews.length === 0 && !error" class="muted">
      Không có lệnh XAUUSDm đang chờ hoặc đang mở trên MT5.
    </p>

    <div v-if="reviews.length" class="review-list">
      <article v-for="item in reviews" :key="item.order.ticket" class="order-card">
        <div class="order-head">
          <div>
            <span :class="['order-pill', item.order.state.toLowerCase()]">
              {{ stateLabel(item.order.state) }}
            </span>
            <strong>#{{ item.order.ticket }} / {{ item.order.direction }}</strong>
          </div>
          <strong :class="['action-pill', actionClass(item.review.recommended_action)]">
            {{ actionLabel(item.review.recommended_action) }}
          </strong>
        </div>

        <div class="order-grid">
          <div>
            <span>Entry</span>
            <strong>{{ formatPrice(item.order.price_open, item.order.symbol) }}</strong>
          </div>
          <div>
            <span>Volume</span>
            <strong>{{ item.order.volume.toFixed(2) }} lot</strong>
          </div>
          <div>
            <span>SL hiện tại</span>
            <strong>{{ formatNullablePrice(item.order.stop_loss, item.order.symbol) }}</strong>
          </div>
          <div>
            <span>TP hiện tại</span>
            <strong>{{ formatNullablePrice(item.order.take_profit, item.order.symbol) }}</strong>
          </div>
          <div>
            <span>P/L</span>
            <strong>{{ formatProfit(item.order.profit) }}</strong>
          </div>
          <div>
            <span>Match history</span>
            <strong>{{ item.matching_history_id ?? "Không có" }}</strong>
          </div>
        </div>

        <p>{{ item.review.summary }}</p>
        <p class="muted">
          <strong>Lý do:</strong> {{ item.review.action_reason }}
        </p>

        <div class="plan-grid">
          <section>
            <h4>Stop loss</h4>
            <p class="muted">{{ item.review.stop_loss_plan.reason }}</p>
            <strong>
              {{
                item.review.stop_loss_plan.suggested_stop_loss === null
                  ? "Giữ nguyên"
                  : `Đề xuất: ${formatPrice(item.review.stop_loss_plan.suggested_stop_loss, item.order.symbol)}`
              }}
            </strong>
          </section>
          <section>
            <h4>Take profit</h4>
            <p class="muted">{{ item.review.take_profit_plan.reason }}</p>
            <strong>
              {{
                item.review.take_profit_plan.suggested_take_profit === null
                  ? "Giữ nguyên"
                  : `Đề xuất: ${formatPrice(item.review.take_profit_plan.suggested_take_profit, item.order.symbol)}`
              }}
            </strong>
          </section>
        </div>

        <div class="plan-grid">
          <section>
            <h4>Điều kiện hủy/đóng</h4>
            <ul class="list">
              <li v-for="reason in listOrDash(item.review.cancellation_conditions)" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </section>
          <section>
            <h4>Checklist</h4>
            <ul class="list">
              <li v-for="step in listOrDash(item.review.checklist)" :key="step">
                {{ step }}
              </li>
            </ul>
          </section>
        </div>

        <p class="muted">
          Check lại sau {{ item.review.next_check_minutes }} phút.
          {{ item.review.disclaimer }}
        </p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiOrderReview } from "~/types/ai";
import type { ActiveMt5Order } from "~/types/trading";
import { formatPrice as formatPriceForSymbol } from "~/utils/display";

interface ActiveOrderReviewItem {
  order: ActiveMt5Order;
  review: AiOrderReview;
  matching_history_id: string | null;
}

const loading = ref(false);
const checked = ref(false);
const error = ref("");
const reviews = ref<ActiveOrderReviewItem[]>([]);

async function reviewActiveOrders(): Promise<void> {
  loading.value = true;
  checked.value = true;
  error.value = "";
  try {
    const response = await $fetch<{ reviews: ActiveOrderReviewItem[] }>(
      "/api/orders/review-active",
      { method: "POST" },
    );
    reviews.value = response.reviews;
  } catch (caught) {
    error.value = errorMessage(caught, "Không check được lệnh đang giữ.");
  } finally {
    loading.value = false;
  }
}

function stateLabel(value: ActiveMt5Order["state"]): string {
  return value === "FILLED" ? "Đang mở" : "Lệnh chờ";
}

function actionLabel(value: AiOrderReview["recommended_action"]): string {
  const labels: Record<AiOrderReview["recommended_action"], string> = {
    KEEP_ORDER: "Giữ tiếp",
    CANCEL_ORDER: "Hủy lệnh",
    MOVE_SL: "Dời SL",
    MOVE_TP: "Dời TP",
    MOVE_SL_TP: "Dời SL/TP",
    WAIT: "Chờ thêm",
    CLOSE_MANUALLY: "Cân nhắc đóng",
    TRADE_COMPLETED: "Đã hoàn tất",
  };
  return labels[value];
}

function actionClass(value: AiOrderReview["recommended_action"]): string {
  if (value === "CANCEL_ORDER" || value === "CLOSE_MANUALLY") return "danger";
  if (value === "MOVE_SL" || value === "MOVE_TP" || value === "MOVE_SL_TP") {
    return "warning";
  }
  return "neutral";
}

function formatPrice(value: number, symbol?: string | null): string {
  return formatPriceForSymbol(value, symbol);
}

function formatNullablePrice(value: number | null, symbol?: string | null): string {
  return value === null || !Number.isFinite(value)
    ? "Không có"
    : formatPriceForSymbol(value, symbol);
}

function formatProfit(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Không áp dụng";
  return `$${value.toFixed(2)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  return error instanceof Error ? error.message : fallback;
}

const listOrDash = (items: string[]) => (items.length ? items : ["Không có."]);
</script>

<style scoped>
.active-orders {
  margin-top: 24px;
}

.panel-head,
.order-head {
  align-items: flex-start;
  display: flex;
  gap: 14px;
  justify-content: space-between;
}

.panel-head h2 {
  margin-top: 0;
}

.review-error {
  color: var(--red);
}

.review-list {
  display: grid;
  gap: 14px;
}

.order-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
}

.order-head > div {
  align-items: center;
  display: flex;
  gap: 10px;
}

.order-grid,
.plan-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 12px 0;
}

.plan-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.order-grid div,
.plan-grid section {
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
  padding: 10px;
}

.order-grid span {
  color: var(--muted);
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}

.order-grid strong {
  overflow-wrap: anywhere;
}

.order-pill,
.action-pill {
  border: 1px solid var(--border);
  border-radius: 999px;
  display: inline-flex;
  font-size: 12px;
  font-weight: 800;
  padding: 5px 10px;
}

.order-pill.filled {
  border-color: rgba(54, 197, 138, 0.72);
  color: var(--green);
}

.order-pill.pending,
.action-pill.warning {
  border-color: rgba(245, 158, 11, 0.6);
  color: #fbbf24;
}

.action-pill.danger {
  border-color: rgba(239, 107, 115, 0.72);
  color: var(--red);
}

.action-pill.neutral {
  border-color: #5c7186;
  color: var(--text);
}

@media (max-width: 760px) {
  .panel-head,
  .order-head {
    flex-direction: column;
  }

  .order-grid,
  .plan-grid {
    grid-template-columns: 1fr;
  }
}
</style>
