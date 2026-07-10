<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>XAUUSD Trading Assistant</h1>
        <p>
          Tín hiệu chính do Rule Engine tất định phát ra (cùng engine với
          auto-bot, kèm kiểm tra an toàn + AI veto). Công cụ chỉ đưa gợi ý,
          không đặt lệnh — bạn tự quyết định trên MT5.
        </p>
      </div>
      <div class="action-panel">
        <label>
          <span>Vốn hiện tại (USD)</span>
          <input
            v-model.number="accountSizeUsd"
            class="input capital-input"
            min="1"
            step="1"
            type="number"
          />
        </label>
        <AnalyzeButton
          :loading="loading"
          label="Quét setup Rule Engine"
          @analyze="scanRuleSignal"
        />
        <button
          class="button secondary-button"
          :disabled="loading"
          @click="analyze"
        >
          {{ loading && loadingSource === 'ai' ? "Đang phân tích..." : "Phân tích AI (tham khảo)" }}
        </button>
      </div>
    </div>

    <div v-if="error" class="card">
      <strong>Phân tích thất bại</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <div v-if="loading" class="card">
      <strong>
        {{
          loadingSource === "rule"
            ? "Đang lấy dữ liệu MT5 và quét setup bằng Rule Engine..."
            : "Đang lấy dữ liệu XAUUSD, tin tức và gửi AI phân tích..."
        }}
      </strong>
      <p class="muted">
        {{
          loadingSource === "rule"
            ? "Thường 5-30 giây (lâu hơn nếu có setup cần AI veto duyệt)."
            : "Quá trình này có thể mất 60-120 giây."
        }}
      </p>
    </div>

    <RecommendationCard
      v-if="result"
      :history="latestHistory"
      :latest-price="latestPrice"
      :latest-price-loading="latestPriceLoading"
      :result="result"
    />

    <AnalysisHistoryTable
      v-if="hasAnalyzed"
      :records="history"
      class="history-block"
      @updated="replaceHistoryRecord"
    />
  </main>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";
import type { AnalysisHistoryRecord } from "~/types/trading";

const loading = ref(false);
const loadingSource = ref<"rule" | "ai">("rule");
const error = ref("");
const result = ref<AiTradeRecommendation | null>(null);
const history = ref<AnalysisHistoryRecord[]>([]);
const hasAnalyzed = ref(false);
const accountSizeUsd = ref(200);
const latestPrice = ref<number | null>(null);
const latestPriceLoading = ref(false);
const latestHistory = computed(() =>
  result.value ? (history.value[0] ?? null) : null,
);

// Luồng CHÍNH: tín hiệu tất định từ rule engine (cùng engine với auto-bot).
async function scanRuleSignal(): Promise<void> {
  await runScan("rule", "/api/rule-signal", {
    accountSizeUsd: normalizeAccountSize(accountSizeUsd.value),
  });
}

// Luồng phụ: AI phân tích tổng hợp (chỉ để tham khảo thêm góc nhìn/tin tức).
async function analyze(): Promise<void> {
  await runScan("ai", "/api/analyze", {
    accountSizeUsd: normalizeAccountSize(accountSizeUsd.value),
    symbol: "XAUUSD",
  });
}

async function runScan(
  source: "rule" | "ai",
  endpoint: string,
  body: Record<string, unknown>,
): Promise<void> {
  loading.value = true;
  loadingSource.value = source;
  error.value = "";
  hasAnalyzed.value = true;
  latestPrice.value = null;
  try {
    const response = await $fetch<{
      result: AiTradeRecommendation;
      history: AnalysisHistoryRecord;
    }>(endpoint, { method: "POST", body });
    result.value = response.result;
    history.value = [
      response.history,
      ...history.value.filter((record) => record.id !== response.history.id),
    ];
    await refreshLatestPrice();
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : "Lỗi không xác định";
  } finally {
    loading.value = false;
  }
}

async function refreshLatestPrice(): Promise<void> {
  latestPriceLoading.value = true;
  try {
    const response = await $fetch<{ price: number }>("/api/market/price", {
      query: { symbol: "XAUUSD", timestamp: Date.now() },
    });
    latestPrice.value = response.price;
  } catch {
    latestPrice.value = null;
  } finally {
    latestPriceLoading.value = false;
  }
}

function normalizeAccountSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Number(value) : 200;
}

function replaceHistoryRecord(record: AnalysisHistoryRecord): void {
  history.value = history.value.map((item) =>
    item.id === record.id ? record : item,
  );
}
</script>

<style scoped>
.history-block {
  margin-top: 24px;
}

.action-panel {
  display: grid;
  gap: 10px;
  justify-items: end;
  min-width: 220px;
}

.action-panel label {
  display: grid;
  gap: 6px;
  width: 100%;
  color: #9fb4cc;
  font-size: 13px;
}

.capital-input {
  width: 100%;
}

/* Nút AI tham khảo: mờ hơn nút chính để phân cấp rõ luồng chính/phụ */
.secondary-button {
  opacity: 0.75;
  width: 100%;
}

@media (max-width: 760px) {
  /* Ô vốn + nút phân tích nằm cùng hàng cho gọn, nút chiếm phần lớn để dễ bấm */
  .action-panel {
    align-items: end;
    grid-template-columns: minmax(110px, 0.8fr) 1.2fr;
    justify-items: stretch;
    min-width: 0;
    width: 100%;
  }
}

@media (max-width: 380px) {
  .action-panel {
    grid-template-columns: 1fr;
  }
}
</style>
