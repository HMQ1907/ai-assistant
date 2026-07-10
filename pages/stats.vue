<template>
  <main class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>Thống kê hiệu quả XAUUSD</h1>
        <p>
          So sánh toàn bộ lượt phân tích với riêng các tín hiệu được hệ thống
          cho phép giao dịch. Lọc theo nguồn/ngày để tách giai đoạn tiền thật
          khỏi dữ liệu cũ.
        </p>
      </div>
      <div class="filter-panel">
        <label>
          <span>Nguồn tín hiệu</span>
          <select v-model="sourceFilter" class="input" @change="loadStats">
            <option value="all">Tất cả</option>
            <option value="rule">Rule Engine (bot + quét tay)</option>
            <option value="ai">AI phân tích (cũ/tham khảo)</option>
          </select>
        </label>
        <label>
          <span>Từ ngày (giờ VN)</span>
          <input
            v-model="fromDate"
            class="input"
            type="date"
            @change="loadStats"
          />
        </label>
        <div class="filter-actions">
          <button class="button" @click="setFromToday">Từ hôm nay</button>
          <button class="button secondary" @click="clearFilters">
            Toàn bộ lịch sử
          </button>
        </div>
      </div>
    </div>

    <p v-if="activeFilterLabel" class="muted filter-note">
      Đang lọc: {{ activeFilterLabel }}
    </p>

    <div v-if="error" class="card">
      <strong>Không tải được thống kê</strong>
      <p class="muted">{{ error }}</p>
    </div>

    <StatsSection
      title="Các phân tích được phép TRADE"
      description="Chỉ tính những lần rule engine/AI và validation trả kết quả TRADE."
      :stats="stats.tradeAnalyses"
    />

    <StatsSection
      title="Tổng tất cả phân tích"
      description="Bao gồm cả TRADE và NO_TRADE."
      :stats="stats.allAnalyses"
    />

    <section class="stats-section">
      <div class="section-heading">
        <h2>Chất lượng thực thi (đo tự động)</h2>
        <p class="muted">
          Hệ thống tự đối chiếu đường đi giá M5 sau mỗi tín hiệu TRADE, không phụ
          thuộc việc nhập tay. Cần tích lũy ~30+ tín hiệu để có ý nghĩa thống kê.
        </p>
      </div>
      <div class="stats-grid exec-grid">
        <div v-for="card in executionCards" :key="card.label" class="card stat-card">
          <span class="muted">{{ card.label }}</span>
          <strong>{{ card.value }}</strong>
          <span class="muted hint">{{ card.hint }}</span>
        </div>
      </div>
    </section>

    <section class="stats-section">
      <div class="card">
        <h2>Hiệu suất tín hiệu TRADE</h2>
        <SymbolPerformanceTable :items="stats.bestSymbols" />
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import StatsSection from "~/components/StatsSection.vue";
import type {
  ExecutionStats,
  PerformanceStats,
  PerformanceStatsSummary,
} from "~/types/trading";

const emptySummary = (): PerformanceStatsSummary => ({
  totalAnalysis: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  skipped: 0,
  winRate: 0,
  avgConfidence: 0,
  avgConfidenceOfWinners: 0,
  avgConfidenceOfLosers: 0,
});

const emptyExecution = (): ExecutionStats => ({
  tracked: 0,
  filled: 0,
  notFilled: 0,
  fillRate: 0,
  wins: 0,
  losses: 0,
  open: 0,
  expired: 0,
  winRate: 0,
  sweptThenReversed: 0,
  sweptThenReversedRate: 0,
  avgMae: 0,
  avgMfe: 0,
  avgMaeToStopRatio: 0,
});

const stats = ref<PerformanceStats>({
  ...emptySummary(),
  allAnalyses: emptySummary(),
  tradeAnalyses: emptySummary(),
  bestSymbols: [],
  worstSymbols: [],
  execution: emptyExecution(),
});
const error = ref("");
const sourceFilter = ref<"all" | "rule" | "ai">("all");
const fromDate = ref("");

const activeFilterLabel = computed(() => {
  const parts: string[] = [];
  if (sourceFilter.value === "rule") parts.push("chỉ tín hiệu Rule Engine");
  if (sourceFilter.value === "ai") parts.push("chỉ AI phân tích");
  if (fromDate.value) parts.push(`từ ${fromDate.value} (00:00 VN)`);
  return parts.join(", ");
});

// Ngày hôm nay theo múi giờ VN (không dùng toISOString vì lệch UTC).
function todayInVietnam(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Saigon",
  }).format(new Date());
}

function setFromToday(): void {
  fromDate.value = todayInVietnam();
  void loadStats();
}

function clearFilters(): void {
  sourceFilter.value = "all";
  fromDate.value = "";
  void loadStats();
}

const executionCards = computed(() => {
  const exec = stats.value.execution;
  return [
    {
      label: "Đã theo dõi",
      value: exec.tracked,
      hint: `${exec.filled} khớp / ${exec.notFilled} không khớp`,
    },
    {
      label: "Tỷ lệ khớp entry",
      value: `${exec.fillRate}%`,
      hint: "Giá có chạm vùng entry không",
    },
    {
      label: "Win rate thực",
      value: `${exec.winRate}%`,
      hint: `${exec.wins} TP / ${exec.losses} SL (đã resolve)`,
    },
    {
      label: "Bị quét SL rồi đảo",
      value: `${exec.sweptThenReversedRate}%`,
      hint: `${exec.sweptThenReversed}/${exec.losses} lệnh thua là stop-hunt`,
    },
    {
      label: "MAE trung bình",
      value: exec.avgMae,
      hint: "Đi ngược TB sau khi khớp (USD)",
    },
    {
      label: "MAE / khoảng SL",
      value: exec.avgMaeToStopRatio,
      hint: ">0.8 = thường sát SL trước khi đi đúng",
    },
  ];
});

onMounted(loadStats);

async function loadStats(): Promise<void> {
  error.value = "";
  try {
    const query: Record<string, string> = {};
    if (sourceFilter.value !== "all") query.source = sourceFilter.value;
    if (fromDate.value) query.from = fromDate.value;
    stats.value = await $fetch<PerformanceStats>("/api/stats", { query });
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : "Lỗi không xác định";
  }
}
</script>

<style scoped>
.filter-panel {
  align-items: end;
  display: grid;
  gap: 10px;
  grid-template-columns: auto auto auto;
}

.filter-panel label {
  color: #9fb4cc;
  display: grid;
  font-size: 13px;
  gap: 6px;
}

.filter-actions {
  display: flex;
  gap: 8px;
}

.filter-actions .secondary {
  opacity: 0.75;
}

.filter-note {
  margin: 6px 0 0;
}

@media (max-width: 860px) {
  .filter-panel {
    grid-template-columns: 1fr 1fr;
    width: 100%;
  }
  .filter-actions {
    grid-column: 1 / -1;
  }
}

.stats-section {
  margin-top: 18px;
}
.section-heading {
  margin-bottom: 12px;
}
.section-heading h2 {
  margin: 0 0 4px;
}
.stats-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
.exec-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.stat-card {
  display: grid;
  gap: 6px;
}
.stat-card strong {
  font-size: 26px;
  font-weight: 800;
}
.stat-card .hint {
  font-size: 12px;
}
@media (max-width: 920px) {
  .exec-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 520px) {
  .exec-grid {
    grid-template-columns: 1fr;
  }
}
</style>
