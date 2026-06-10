<template>
  <button class="button" :disabled="loading" @click="$emit('analyze')">
    {{ loading ? "Đang phân tích..." : `Hiển thị gợi ý ${symbol}` }}
  </button>
</template>

<script setup lang="ts">
defineProps<{ loading: boolean; symbol: "XAUUSD" | "BTCUSD" }>();
defineEmits<{ analyze: [] }>();
</script>
