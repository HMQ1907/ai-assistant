<template>
  <button class="button" :disabled="loading" @click="$emit('analyze')">
    {{ loading ? "Đang phân tích..." : "Hiển thị lệnh gợi ý" }}
  </button>
</template>

<script setup lang="ts">
defineProps<{ loading: boolean }>();
defineEmits<{ analyze: [] }>();
</script>
