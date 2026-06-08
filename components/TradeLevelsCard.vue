<template>
  <section class="card">
    <h3>Entry / SL / TP</h3>
    <div class="kv">
      <div class="kv-row">
        <span>Vùng entry</span>
        <strong>{{ result.entry_zone.from }} - {{ result.entry_zone.to }}</strong>
      </div>
      <div class="kv-row">
        <span>Stop loss</span><strong>{{ result.stop_loss }}</strong>
      </div>
      <p class="muted">{{ result.stop_loss_reason }}</p>
      <div class="kv-row">
        <span>Take profit</span><strong>{{ result.take_profit }}</strong>
      </div>
      <p class="muted">{{ result.take_profit_reason }}</p>
      <div class="kv-row">
        <span>Risk reward</span><strong>{{ result.risk_reward }}</strong>
      </div>
      <div class="kv-row">
        <span>Thời gian giữ dự kiến</span>
        <strong>{{ result.expected_holding_time }}</strong>
      </div>
      <div class="kv-row">
        <span>Lỗ ước tính nếu chạm SL</span>
        <strong>${{ result.position_sizing.estimated_loss_if_sl_hit }}</strong>
      </div>
      <div class="kv-row">
        <span>Giới hạn lỗ tối đa</span>
        <strong>${{ result.position_sizing.max_loss_usd }}</strong>
      </div>
      <p class="muted">{{ result.position_sizing.position_sizing_explanation }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";

defineProps<{ result: AiTradeRecommendation }>();
</script>
