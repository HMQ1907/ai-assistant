<template>
  <button class="button" :disabled="loading" @click="$emit('analyze')">
    {{ loading ? "Đang phân tích..." : label }}
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ loading: boolean; label?: string }>(), {
  label: "Hiển thị gợi ý XAUUSD",
});
defineEmits<{ analyze: [] }>();
</script>
