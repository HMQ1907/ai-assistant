<template>
  <section class="card">
    <h3>Checklist trước khi tự vào lệnh</h3>
    <ul class="list">
      <li v-for="item in listOrDash(result.pre_entry_checklist)" :key="item">{{ item }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";

defineProps<{ result: AiTradeRecommendation }>();
const listOrDash = (items: string[]) => (items.length ? items : ["Không có."]);
</script>
