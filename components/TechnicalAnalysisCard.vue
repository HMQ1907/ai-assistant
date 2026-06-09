<template>
  <section class="card">
    <h3>Phân tích kỹ thuật</h3>
    <div class="kv">
      <div class="kv-row">
        <span>Xu hướng</span><span>{{ result.technical_analysis.trend }}</span>
      </div>
      <div class="kv-row">
        <span>Động lượng</span><span>{{ result.technical_analysis.momentum }}</span>
      </div>
      <div class="kv-row">
        <span>Hỗ trợ / Kháng cự</span><span>{{ result.technical_analysis.support_resistance }}</span>
      </div>
      <div class="kv-row">
        <span>Biến động</span><span>{{ result.technical_analysis.volatility }}</span>
      </div>
      <div class="kv-row">
        <span>Khung thời gian</span><span>{{ result.technical_analysis.timeframe_alignment }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";

defineProps<{ result: AiTradeRecommendation }>();
</script>
