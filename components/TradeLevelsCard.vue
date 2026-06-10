<template>
  <section class="card">
    <h3>Kế hoạch Entry / SL / TP</h3>
    <p class="muted">{{ result.entry_plan }}</p>
    <div class="kv">
      <div class="kv-row">
        <span>Vùng entry đề xuất</span>
        <strong>{{ formatEntryZone }}</strong>
      </div>
      <div class="kv-row">
        <span>Stop loss</span><strong>{{ formatLevel(result.stop_loss) }}</strong>
      </div>
      <p class="muted">
        {{ result.stop_loss_reason || "Không có SL vì chưa có setup giao dịch hợp lệ." }}
      </p>
      <div class="kv-row">
        <span>Take profit</span><strong>{{ formatLevel(result.take_profit) }}</strong>
      </div>
      <p class="muted">
        {{ result.take_profit_reason || "Không có TP vì chưa có setup giao dịch hợp lệ." }}
      </p>
      <div class="kv-row">
        <span>Risk reward</span><strong>{{ result.risk_reward ?? "Không áp dụng" }}</strong>
      </div>
      <div class="kv-row">
        <span>{{ quantityLabel }} gợi ý</span>
        <strong>{{ formatQuantity(result.position_sizing.suggested_lot) }}</strong>
      </div>
      <div class="kv-row">
        <span>Thời gian giữ dự kiến</span>
        <strong>{{ result.expected_holding_time ?? "Không áp dụng" }}</strong>
      </div>
      <div class="kv-row">
        <span>Vốn hiện tại</span>
        <strong>${{ result.position_sizing.account_size_usd }}</strong>
      </div>
      <div class="kv-row">
        <span>Giới hạn lỗ tối đa</span>
        <strong>
          ${{ result.position_sizing.max_loss_usd }}
          ({{ result.position_sizing.max_loss_percent }}%)
        </strong>
      </div>
      <div class="kv-row">
        <span>Lỗ ước tính nếu chạm SL</span>
        <strong>{{ formatUsd(result.position_sizing.estimated_loss_if_sl_hit) }}</strong>
      </div>
      <p class="muted">{{ result.position_sizing.position_sizing_explanation }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";

const props = defineProps<{ result: AiTradeRecommendation }>();
const quantityLabel = computed(() =>
  props.result.symbol === "BTCUSD" ? "Số lượng BTC" : "Lot",
);

const formatEntryZone = computed(() =>
  props.result.entry_zone
    ? `${formatLevel(props.result.entry_zone.from)} - ${formatLevel(props.result.entry_zone.to)}`
    : "Không áp dụng",
);

function formatLevel(value: number | null): string {
  return value !== null && Number.isFinite(value) && value > 0
    ? value.toFixed(2)
    : "Không áp dụng";
}

function formatQuantity(value: number | null): string {
  return value !== null && Number.isFinite(value) && value > 0
    ? props.result.symbol === "BTCUSD"
      ? `${value.toFixed(5)} BTC`
      : `${value.toFixed(2)} lot`
    : "Không vào lệnh";
}

function formatUsd(value: number | null): string {
  return value !== null && Number.isFinite(value)
    ? `$${value.toFixed(2)}`
    : "Không áp dụng";
}
</script>
