<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>Lịch sử</h1>
        <p>
          Cập nhật kết quả giao dịch người dùng đã tự thực hiện bên ngoài hệ
          thống.
        </p>
      </div>
    </div>
    <AnalysisHistoryTable :records="history" @updated="replaceHistoryRecord" />
  </main>
</template>

<script setup lang="ts">
import type { AnalysisHistoryRecord } from "~/types/trading";

const history = ref<AnalysisHistoryRecord[]>([]);

onMounted(async () => {
  history.value = await $fetch<AnalysisHistoryRecord[]>("/api/history");
});

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) =>
    item.id === record.id ? record : item,
  );
}
</script>
