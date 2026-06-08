<template>
  <button class="button" :disabled="loading" @click="$emit('analyze')">
    {{ loading ? 'Dang phan tich...' : 'Hien thi lenh goi y' }}
  </button>
</template>

<script setup lang="ts">
defineProps<{ loading: boolean }>()
defineEmits<{ analyze: [] }>()
</script>
