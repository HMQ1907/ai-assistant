<template>
  <section class="card">
    <h3>Pre-entry checklist</h3>
    <ul class="list">
      <li v-for="item in result.pre_entry_checklist" :key="item">{{ item }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from '~/types/ai'

defineProps<{ result: AiTradeRecommendation }>()
</script>
