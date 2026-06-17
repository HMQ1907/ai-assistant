<template>
  <button class="button" :disabled="loading" @click="$emit('analyze')">
    {{ loading ? "Dang phan tich..." : label }}
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ loading: boolean; label?: string }>(), {
  label: "Hien thi goi y XAUUSD",
});
defineEmits<{ analyze: [] }>();
</script>
