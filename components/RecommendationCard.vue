<template>
  <section class="grid">
    <div class="card">
      <div class="summary-head">
        <span :class="['badge', result.decision === 'TRADE' ? 'trade' : 'no-trade']">
          {{ decisionLabel(result.decision) }}
        </span>
        <strong>{{ result.symbol }} / {{ directionLabel(result.direction) }}</strong>
      </div>

      <div class="price-strip">
        <div>
          <span>Giá hiện tại</span>
          <strong>
            {{ latestPriceLoading ? "Đang cập nhật..." : formatPrice(latestPrice) }}
          </strong>
        </div>
        <div>
          <span>Giá lúc bấm phân tích</span>
          <strong>{{ formatPrice(currentMarket?.price ?? result.current_price) }}</strong>
        </div>
        <div>
          <span>Bid / Ask</span>
          <strong>{{ formatPrice(currentMarket?.bid) }} / {{ formatPrice(currentMarket?.ask) }}</strong>
        </div>
        <div>
          <span>Spread</span>
          <strong>{{ formatNumber(currentMarket?.spread) }}</strong>
        </div>
        <div>
          <span>% win keo</span>
          <strong>{{ winProbability }}%</strong>
        </div>
      </div>

      <p>{{ result.summary }}</p>
      <ConfidenceBar :value="winProbability" />
      <p class="muted">{{ result.disclaimer }}</p>
    </div>

    <div class="card">
      <h3>Bối cảnh thị trường</h3>
      <p class="muted">{{ result.market_context }}</p>
      <div v-if="currentIndicators" class="kv">
        <div class="kv-row">
          <span>Hỗ trợ gần nhất</span>
          <strong>{{ formatPrice(currentIndicators.nearestSupport) }}</strong>
        </div>
        <div class="kv-row">
          <span>Kháng cự gần nhất</span>
          <strong>{{ formatPrice(currentIndicators.nearestResistance) }}</strong>
        </div>
        <div class="kv-row">
          <span>RSI14 / ATR14</span>
          <strong>{{ formatNumber(currentIndicators.rsi14) }} / {{ formatNumber(currentIndicators.atr14) }}</strong>
        </div>
        <div class="kv-row">
          <span>Xu hướng M15 / H1</span>
          <strong>{{ currentIndicators.trendM15 }} / {{ currentIndicators.trendH1 }}</strong>
        </div>
      </div>
    </div>

    <div class="grid two">
      <section class="card">
        <h3>Lý do có thể vào lệnh</h3>
        <p class="muted">{{ result.trade_reason }}</p>
        <ul class="list">
          <li v-for="item in listOrDash(result.main_reasons)" :key="item">
            {{ item }}
          </li>
        </ul>
      </section>

      <section class="card">
        <h3>Lý do chưa vào lệnh</h3>
        <p class="muted">{{ result.no_trade_reason || 'Không có lý do cấm giao dịch từ AI.' }}</p>
        <ul class="list">
          <li v-for="item in listOrDash(result.invalid_conditions)" :key="item">
            {{ item }}
          </li>
        </ul>
      </section>
    </div>

    <TradeLevelsCard :result="result" />

    <section
      v-if="result.decision === 'NO_TRADE' && result.risky_trade?.enabled"
      class="card risky-card"
    >
      <div class="risky-head">
        <div>
          <p class="risky-eyebrow">Kịch bản phụ</p>
          <h3>{{ result.risky_trade.title || "Trade mạo hiểm" }}</h3>
        </div>
        <strong class="risky-win">
          {{ result.risky_trade.estimated_win_probability }}% AI đánh giá
        </strong>
      </div>

      <p class="muted">{{ result.risky_trade.reason }}</p>

      <div class="risky-grid">
        <div>
          <span>Loại lệnh</span>
          <strong>{{ riskyOrderLabel(result.risky_trade.order_type) }}</strong>
        </div>
        <div>
          <span>Hướng</span>
          <strong>{{ directionLabel(result.risky_trade.direction) }}</strong>
        </div>
        <div>
          <span>Vùng entry</span>
          <strong>
            {{ formatPrice(result.risky_trade.entry_zone.from) }} -
            {{ formatPrice(result.risky_trade.entry_zone.to) }}
          </strong>
        </div>
        <div>
          <span>Stop loss</span>
          <strong>{{ formatPrice(result.risky_trade.stop_loss) }}</strong>
        </div>
        <div>
          <span>Take profit</span>
          <strong>{{ formatPrice(result.risky_trade.take_profit) }}</strong>
        </div>
        <div>
          <span>Risk reward</span>
          <strong>{{ result.risky_trade.risk_reward }}</strong>
        </div>
        <div>
          <span>Hủy nếu chưa khớp sau</span>
          <strong>{{ result.risky_trade.cancel_after_minutes ?? 30 }} phút</strong>
        </div>
        <div>
          <span>Lot gợi ý</span>
          <strong>{{ formatLot(result.risky_trade.suggested_lot) }}</strong>
        </div>
        <div>
          <span>Lỗ nếu chạm SL</span>
          <strong>{{ formatUsd(result.risky_trade.estimated_loss_if_sl_hit) }}</strong>
        </div>
      </div>

      <div class="grid two">
        <div>
          <h4>Điều kiện vào lệnh</h4>
          <ul class="list">
            <li
              v-for="item in listOrDash(result.risky_trade.entry_conditions)"
              :key="item"
            >
              {{ item }}
            </li>
          </ul>
        </div>
        <div>
          <h4>Điều kiện hủy kèo</h4>
          <ul class="list">
            <li
              v-for="item in listOrDash(result.risky_trade.cancel_conditions)"
              :key="item"
            >
              {{ item }}
            </li>
          </ul>
        </div>
      </div>

      <p class="risky-warning">{{ result.risky_trade.warning }}</p>
    </section>

    <section
      v-else-if="result.decision === 'NO_TRADE'"
      class="card no-risky-card"
    >
      <h3>Không có trade mạo hiểm hợp lệ</h3>
      <p class="muted">
        Rule Engine không tìm được setup chính đủ điều kiện, và nhánh phụ mạo hiểm
        cũng chưa có entry/SL/TP/RR/risk rõ ràng để cân nhắc. Hệ thống không bịa
        thêm lệnh chỉ để có tín hiệu.
      </p>
      <ul class="list">
        <li>Scalp dự phòng chưa đạt điều kiện tối thiểu, hoặc đang bị chặn bởi RR/spread/risk-cap.</li>
        <li>Nếu thị trường đổi cấu trúc hoặc có nến M5/M15 mới rõ hơn, hãy quét lại.</li>
      </ul>
    </section>

    <div v-if="history" class="card">
      <h3>Dữ liệu gửi AI</h3>
      <div class="kv">
        <div class="kv-row">
          <span>Vốn hiện tại</span>
          <strong>${{ history.request_payload.accountSizeUsd }}</strong>
        </div>
        <div class="kv-row">
          <span>Risk tối đa</span>
          <strong>
            ${{ history.request_payload.maxLossUsdPerTrade }}
            ({{ history.request_payload.maxLossPercentPerTrade }}%)
          </strong>
        </div>
        <div class="kv-row">
          <span>Provider thị trường</span><strong>{{ history.market_data_provider }}</strong>
        </div>
        <div class="kv-row">
          <span>Provider tin tức</span><strong>{{ history.news_provider }}</strong>
        </div>
        <div class="kv-row">
          <span>Cập nhật thị trường</span>
          <strong>{{ formatTime(history.market_data_timestamp) }}</strong>
        </div>
        <div class="kv-row">
          <span>Cập nhật tin tức</span><strong>{{ formatTime(history.news_data_timestamp) }}</strong>
        </div>
        <div class="kv-row">
          <span>Trạng thái tin tức</span>
          <strong>{{ newsStatusLabel(history.request_payload.newsDataStatus) }}</strong>
        </div>
        <div class="kv-row">
          <span>Chất lượng dữ liệu</span><strong>{{ dataQualityLabel(history.data_quality) }}</strong>
        </div>
        <div class="kv-row">
          <span>Số nến gửi AI</span>
          <strong>{{ candleSummary }}</strong>
        </div>
        <div class="kv-row">
          <span>Trạng thái Bid/Ask</span><strong>{{ bidAskStatusLabel }}</strong>
        </div>
        <div class="kv-row">
          <span>Tuổi quote</span><strong>{{ quoteAgeLabel }}</strong>
        </div>
        <div class="kv-row">
          <span>Chất lượng timeframe</span>
          <strong>{{ timeframeQualitySummary }}</strong>
        </div>
        <div class="kv-row">
          <span>Nến bị lọc</span>
          <strong>{{ candleDiagnosticsSummary }}</strong>
        </div>
        <div class="kv-row">
          <span>Số tin tức gửi AI</span>
          <strong>{{ history.request_payload.news.items.length }}</strong>
        </div>
      </div>
      <h3>Cảnh báo dữ liệu</h3>
      <ul class="list">
        <li v-for="item in listOrDash(history.data_warnings)" :key="item">
          {{ item }}
        </li>
      </ul>
    </div>

    <div class="grid three">
      <TechnicalAnalysisCard :result="result" />
      <NewsAnalysisCard :result="result" />
      <RiskFactorsCard :result="result" />
    </div>

    <div class="grid two">
      <section class="card">
        <h3>Kịch bản</h3>
        <p class="muted">
          <strong>Tốt nhất:</strong> {{ result.best_case_scenario }}
        </p>
        <p class="muted">
          <strong>Xấu nhất:</strong> {{ result.worst_case_scenario }}
        </p>
      </section>

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
  formatPrice as formatPriceForSymbol,
} from "~/utils/display";

const props = defineProps<{
  result: AiTradeRecommendation;
  history?: AnalysisHistoryRecord | null;
  latestPrice?: number | null;
  latestPriceLoading?: boolean;
}>();

const currentSymbol = computed(() =>
  props.history?.request_payload.symbols.find(
    (item) => item.market.symbol === props.result.symbol,
  ),
);
const currentMarket = computed(() => currentSymbol.value?.market);
const currentIndicators = computed(() => currentSymbol.value?.indicators);
const winProbability = computed(() =>
  Number.isFinite(props.result.estimated_win_probability)
    ? (props.result.estimated_win_probability ?? props.result.confidence)
    : props.result.confidence,
);
const bidAskStatusLabel = computed(() => {
  const status = currentMarket.value?.bidAskStatus;
  if (status === "AVAILABLE") return "Có bid/ask thật";
  if (status === "INVALID") return "Bid/ask không hợp lệ";
  if (status === "UNAVAILABLE") return "Bid/Ask không khả dụng";
  return "Không rõ";
});
const quoteAgeLabel = computed(() => {
  const market = currentMarket.value;
  if (!market) return "Không rõ";
  if (!market.quoteTimestampReliable) return "Timestamp quote không đáng tin";
  if (market.quoteAgeSeconds === null) return "Không rõ";
  return `${market.quoteAgeSeconds}s`;
});
const candleSummary = computed(() => {
  const market = currentMarket.value;
  if (!market) return "Không rõ";

  if (market.candle_summary) {
    return Object.entries(market.candle_summary)
      .map(([timeframe, summary]) => {
        const sent = market.recent_candles[summary.timeframe]?.length ?? 0;
        return `${timeframe}: ${sent}/${summary.candleCount}`;
      })
      .join(", ");
  }

  const legacyMarket = market as unknown as {
    candles?: Record<string, unknown[]>;
  };
  if (!legacyMarket.candles) return "Không rõ";
  return Object.entries(legacyMarket.candles)
    .map(([timeframe, items]) => `${timeframe}: ${items.length}`)
    .join(", ");
});
const timeframeQualitySummary = computed(() => {
  const quality = currentMarket.value?.timeframe_quality;
  if (!quality) return "Không rõ";
  return Object.entries(quality)
    .map(
      ([timeframe, item]) =>
        `${timeframe}: ${dataQualityLabel(item.quality)} (${item.validCandleCount}/${item.requiredCandleCount})`,
    )
    .join(", ");
});
const candleDiagnosticsSummary = computed(() => {
  const diagnostics = currentMarket.value?.candle_diagnostics;
  if (!diagnostics) return "Không rõ";
  return Object.entries(diagnostics)
    .map(([timeframe, item]) => {
      const reasons = Object.entries(item.reasons)
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(", ");
      return `${timeframe}: ${item.filteredCount}${reasons ? ` (${reasons})` : ""}`;
    })
    .join("; ");
});

const listOrDash = (items: string[]) => (items.length ? items : ["Không có."]);

function formatTime(value: string): string {
  if (!value) return "Không rõ";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}

function newsStatusLabel(value: string): string {
  return value === "AVAILABLE" ? "CÓ DỮ LIỆU" : "KHÔNG CÓ DỮ LIỆU";
}

function formatPrice(value: number | null | undefined): string {
  return formatPriceForSymbol(value, props.result.symbol);
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "Không rõ";
  }
  return String(Number(value.toFixed(4)));
}
function riskyOrderLabel(value: string): string {
  const labels: Record<string, string> = {
    MARKET: "MARKET (vào ngay)",
    BUY_LIMIT: "BUY LIMIT",
    SELL_LIMIT: "SELL LIMIT",
    BUY_STOP: "BUY STOP",
    SELL_STOP: "SELL STOP",
  };
  return labels[value] ?? value;
}

function formatLot(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "Không rõ";
  }
  return `${value.toFixed(2)} lot`;
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "Không rõ";
  }
  return `$${Number(value.toFixed(2))}`;
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

.price-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.price-strip div {
  border: 1px solid #2d3b4f;
  border-radius: 8px;
  padding: 10px;
}

.price-strip span {
  display: block;
  color: #9fb4cc;
  font-size: 13px;
  margin-bottom: 4px;
}

.risky-card {
  background:
    linear-gradient(180deg, rgba(245, 158, 11, 0.08), transparent 34%),
    var(--panel);
  border-color: rgba(245, 158, 11, 0.42);
}

.risky-head {
  align-items: flex-start;
  display: flex;
  gap: 14px;
  justify-content: space-between;
  margin-bottom: 12px;
}

.risky-eyebrow {
  color: #fbbf24;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.12em;
  margin: 0 0 6px;
  text-transform: uppercase;
}

.risky-head h3,
.risky-card h4 {
  margin-top: 0;
}

.risky-win {
  border: 1px solid rgba(245, 158, 11, 0.45);
  border-radius: 999px;
  color: #fbbf24;
  flex: 0 0 auto;
  padding: 7px 10px;
}

.risky-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 14px 0;
}

.risky-grid div {
  border: 1px solid #2d3b4f;
  border-radius: 8px;
  padding: 10px;
}

.risky-grid span {
  color: #9fb4cc;
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}

.risky-warning {
  border-left: 3px solid #f59e0b;
  color: #f8d48a;
  margin: 12px 0 0;
  padding-left: 10px;
}

.no-risky-card {
  background:
    linear-gradient(180deg, rgba(148, 163, 184, 0.07), transparent 38%),
    var(--panel);
  border-color: rgba(148, 163, 184, 0.24);
}

.no-risky-card h3 {
  color: #cbd5e1;
  margin-top: 0;
}

@media (max-width: 800px) {
  .summary-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .price-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .risky-head {
    flex-direction: column;
  }

  .risky-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* Giữ 2 cột trên điện thoại để các ô không bị xếp dọc quá dài */
@media (max-width: 460px) {
  .price-strip,
  .risky-grid {
    gap: 8px;
  }

  .price-strip div,
  .risky-grid div {
    padding: 9px 10px;
  }

  .price-strip span,
  .risky-grid span {
    font-size: 12px;
  }
}
</style>


