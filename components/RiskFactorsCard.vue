<template>
  <section class="card">
    <h3>Yếu tố rủi ro</h3>
    <ul class="list">
      <li v-for="item in result.risk_factors" :key="item">{{ item }}</li>
    </ul>
    <h3>Điều kiện vô hiệu</h3>
    <ul class="list">
      <li v-for="item in result.invalid_conditions" :key="item">{{ item }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";

defineProps<{ result: AiTradeRecommendation }>();
</script>
