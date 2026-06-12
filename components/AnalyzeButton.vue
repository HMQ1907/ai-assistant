<template>
  <button class="button" :disabled="loading" @click="$emit('analyze')">
    {{ loading ? "Đang phân tích..." : `Hiển thị gợi ý ${symbol}` }}
  </button>
</template>

<script setup lang="ts">
import type { SymbolCode } from "~/types/trading";

defineProps<{ loading: boolean; symbol: SymbolCode }>();
defineEmits<{ analyze: [] }>();
</script>
