<template>
  <section class="card">
    <h3>Entry / SL / TP</h3>
    <p class="muted">{{ result.entry_plan }}</p>
    <div class="kv">
      <div v-if="result.decision === 'TRADE'" class="kv-row">
        <span>Loai lenh</span>
        <strong>{{ orderTypeLabel(result.order_type, result.direction) }}</strong>
      </div>
      <div class="kv-row">
        <span>% win keo</span>
        <strong>{{ winProbability }}%</strong>
      </div>
      <div class="kv-row">
        <span>Vung entry de xuat</span>
        <strong>{{ formatEntryZone }}</strong>
      </div>
      <div class="kv-row">
        <span>Stop loss</span>
        <strong>{{ formatLevel(result.stop_loss) }}</strong>
      </div>
      <p class="muted">
        {{ result.stop_loss_reason || "Khong co SL vi chua co setup giao dich hop le." }}
      </p>
      <div class="kv-row">
        <span>Take profit</span>
        <strong>{{ formatLevel(result.take_profit) }}</strong>
      </div>
      <p class="muted">
        {{ result.take_profit_reason || "Khong co TP vi chua co setup giao dich hop le." }}
      </p>
      <div class="kv-row">
        <span>Risk reward</span>
        <strong>{{ result.risk_reward ?? "Khong ap dung" }}</strong>
      </div>
      <div class="kv-row">
        <span>Thoi gian giu du kien</span>
        <strong>{{ result.expected_holding_time ?? "Khong ap dung" }}</strong>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation, OrderType } from "~/types/ai";
import type { TradeDirection } from "~/types/trading";

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
    : "Khong ap dung",
);

function formatLevel(value: number | null): string {
  return value !== null && Number.isFinite(value) && value > 0
    ? value.toFixed(props.result.symbol === "EURUSD" ? 5 : 2)
    : "Khong ap dung";
}
</script>
