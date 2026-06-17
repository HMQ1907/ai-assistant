<template>
  <section class="card">
    <h3>Entry / SL / TP</h3>
    <p class="muted">{{ result.entry_plan }}</p>
    <div class="kv">
      <div v-if="result.decision === 'TRADE'" class="kv-row">
        <span>Loại lệnh</span>
        <strong>{{ orderTypeLabel(result.order_type, result.direction) }}</strong>
      </div>
      <div class="kv-row">
        <span>% win keo</span>
        <strong>{{ winProbability }}%</strong>
      </div>
      <div class="kv-row">
        <span>Vùng entry đề xuất</span>
        <strong>{{ formatEntryZone }}</strong>
      </div>
      <div class="kv-row">
        <span>Stop loss</span>
        <strong>{{ formatLevel(result.stop_loss) }}</strong>
      </div>
      <p class="muted">
        {{ result.stop_loss_reason || "Không có SL vì chưa có setup giao dịch hợp lệ." }}
      </p>
      <div class="kv-row">
        <span>Take profit</span>
        <strong>{{ formatLevel(result.take_profit) }}</strong>
      </div>
      <p class="muted">
        {{ result.take_profit_reason || "Không có TP vì chưa có setup giao dịch hợp lệ." }}
      </p>
      <div class="kv-row">
        <span>Risk reward</span>
        <strong>{{ result.risk_reward ?? "Không áp dụng" }}</strong>
      </div>
      <div class="kv-row">
        <span>Thời gian giữ dự kiến</span>
        <strong>{{ result.expected_holding_time ?? "Không áp dụng" }}</strong>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation, OrderType } from "~/types/ai";
import type { TradeDirection } from "~/types/trading";
import { priceDecimals } from "~/utils/display";

const props = defineProps<{ result: AiTradeRecommendation }>();

const winProbability = computed(() =>
  Number.isFinite(props.result.estimated_win_probability)
    ? props.result.estimated_win_probability
    : props.result.confidence,
);

function orderTypeLabel(
  orderType: OrderType,
  direction: TradeDirection,
): string {
  if (orderType === "MARKET") {
    if (direction === "BUY") return "BUY market";
    if (direction === "SELL") return "SELL market";
    return "Market";
  }
  const labels: Record<Exclude<OrderType, "MARKET">, string> = {
    BUY_LIMIT: "BUY LIMIT",
    SELL_LIMIT: "SELL LIMIT",
    BUY_STOP: "BUY STOP",
    SELL_STOP: "SELL STOP",
  };
  return labels[orderType];
}

const formatEntryZone = computed(() =>
  props.result.entry_zone
    ? `${formatLevel(props.result.entry_zone.from)} - ${formatLevel(props.result.entry_zone.to)}`
    : "Không áp dụng",
);

function formatLevel(value: number | null): string {
  return value !== null && Number.isFinite(value) && value > 0
    ? value.toFixed(priceDecimals(props.result.symbol))
    : "Không áp dụng";
}
</script>
