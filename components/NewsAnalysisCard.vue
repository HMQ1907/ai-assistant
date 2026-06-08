<template>
  <section class="card">
    <h3>Phân tích tin tức</h3>
    <p class="muted">{{ result.news_analysis.sentiment }}</p>
    <h3>Tin hỗ trợ</h3>
    <ul class="list">
      <li
        v-for="item in listOrDash(result.news_analysis.supporting_news)"
        :key="item"
      >
        {{ item }}
      </li>
    </ul>
    <h3>Tin rủi ro</h3>
    <ul class="list">
      <li
        v-for="item in listOrDash(result.news_analysis.risk_news)"
        :key="item"
      >
        {{ item }}
      </li>
    </ul>
    <h3>Tin mạnh sắp tới</h3>
    <ul class="list">
      <li
        v-for="item in listOrDash(
          result.news_analysis.upcoming_high_impact_events,
        )"
        :key="item"
      >
        {{ item }}
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";

defineProps<{ result: AiTradeRecommendation }>();
const listOrDash = (items: string[]) => (items.length ? items : ["Không có."]);
</script>
