<template>
  <div>
    <div class="kv-row">
      <span>Độ tin cậy</span>
      <strong>{{ value }}%</strong>
    </div>
    <div class="track" aria-label="Độ tin cậy">
      <div class="fill" :style="{ width: `${safeValue}%` }" />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ value: number }>();
const safeValue = computed(() => Math.max(0, Math.min(100, props.value)));
</script>

<style scoped>
.track {
  height: 10px;
  overflow: hidden;
  background: #29333b;
  border-radius: 999px;
}

.fill {
  height: 100%;
  background: linear-gradient(90deg, #ef6b73, #e0b15f, #36c58a);
}
</style>
