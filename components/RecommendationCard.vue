<template>
  <section class="grid">
    <div class="card">
      <div class="summary-head">
        <span
          :class="['badge', result.decision === 'TRADE' ? 'trade' : 'no-trade']"
          >{{ decisionLabel(result.decision) }}</span
        >
        <strong
          >{{ result.symbol }} / {{ directionLabel(result.direction) }}</strong
        >
      </div>
      <p>{{ result.summary }}</p>
      <ConfidenceBar :value="result.confidence" />
      <p class="muted">Đây là gợi ý từ AI, không đảm bảo thắng.</p>
      <p class="muted">{{ result.disclaimer }}</p>
      <p v-if="result.no_trade_reason" class="muted">
        <strong>Lý do không giao dịch:</strong> {{ result.no_trade_reason }}
      </p>
      <p v-if="result.next_check_suggestion" class="muted">
        <strong>Gợi ý kiểm tra lại:</strong> {{ result.next_check_suggestion }}
      </p>
    </div>

    <div v-if="history" class="card">
      <h3>Nguồn dữ liệu</h3>
      <div class="kv">
        <div class="kv-row">
          <span>Provider thị trường</span
          ><strong>{{ history.market_data_provider }}</strong>
        </div>
        <div class="kv-row">
          <span>Provider tin tức</span
          ><strong>{{ history.news_provider }}</strong>
        </div>
        <div class="kv-row">
          <span>Cập nhật dữ liệu thị trường</span
          ><strong>{{ formatTime(history.market_data_timestamp) }}</strong>
        </div>
        <div class="kv-row">
          <span>Cập nhật tin tức</span
          ><strong>{{ formatTime(history.news_data_timestamp) }}</strong>
        </div>
        <div class="kv-row">
          <span>Trạng thái tin tức</span
          ><strong>{{
            newsStatusLabel(history.request_payload.newsDataStatus)
          }}</strong>
        </div>
        <div class="kv-row">
          <span>Chất lượng dữ liệu</span
          ><strong>{{ dataQualityLabel(history.data_quality) }}</strong>
        </div>
      </div>
      <h3>Cảnh báo dữ liệu</h3>
      <ul class="list">
        <li v-for="item in listOrDash(history.data_warnings)" :key="item">
          {{ item }}
        </li>
      </ul>
      <h3>Symbol bị bỏ qua</h3>
      <ul class="list">
        <li v-for="item in history.skipped_symbols" :key="item.symbol">
          {{ item.symbol }}: {{ item.reason }}
        </li>
        <li v-if="history.skipped_symbols.length === 0">Không có.</li>
      </ul>
    </div>

    <div class="grid three">
      <TradeLevelsCard :result="result" />
      <TechnicalAnalysisCard :result="result" />
      <NewsAnalysisCard :result="result" />
    </div>

    <div class="grid two">
      <section class="card">
        <h3>Vì sao chọn symbol này</h3>
        <p class="muted">{{ result.why_this_symbol }}</p>
        <h3>Vì sao không chọn symbol khác</h3>
        <ul class="list">
          <li v-for="item in result.why_not_others" :key="item">{{ item }}</li>
        </ul>
      </section>

      <section class="card">
        <h3>Lý do chính</h3>
        <ul class="list">
          <li v-for="item in result.main_reasons" :key="item">{{ item }}</li>
        </ul>
        <h3>Kịch bản</h3>
        <p class="muted">
          <strong>Tốt nhất:</strong> {{ result.best_case_scenario }}
        </p>
        <p class="muted">
          <strong>Xấu nhất:</strong> {{ result.worst_case_scenario }}
        </p>
      </section>
    </div>

    <div class="grid two">
      <section class="card">
        <h3>Điểm từng symbol</h3>
        <table class="history-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Điểm</th>
              <th>Bias</th>
              <th>Lý do</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in result.symbol_scores" :key="item.symbol">
              <td>{{ item.symbol }}</td>
              <td>{{ item.score }}</td>
              <td>{{ directionLabel(item.bias) }}</td>
              <td class="muted">{{ item.reason }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <RiskFactorsCard :result="result" />
      <PreEntryChecklist :result="result" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiTradeRecommendation } from "~/types/ai";
import type { AnalysisHistoryRecord } from "~/types/trading";
import {
  dataQualityLabel,
  decisionLabel,
  directionLabel,
} from "~/utils/display";

defineProps<{
  result: AiTradeRecommendation;
  history?: AnalysisHistoryRecord | null;
}>();

const listOrDash = (items: string[]) => (items.length ? items : ["Không có."]);

function formatTime(value: string): string {
  if (!value) return "Không rõ";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function newsStatusLabel(value: string): string {
  return value === "AVAILABLE" ? "CÓ DỮ LIỆU" : "KHÔNG CÓ DỮ LIỆU";
}
</script>

<style scoped>
.summary-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
</style>
