# AI XAUUSD Trading Assistant

AI XAUUSD Trading Assistant là công cụ phân tích và đưa gợi ý giao dịch thủ công cho XAUUSD. Hệ thống không đặt lệnh, không kết nối broker để giao dịch, không auto trade, không copy trade và không quản lý lệnh đang mở.

Người dùng tự quyết định MUA/BÁN và tự thao tác bên ngoài hệ thống.

## Nguyên Tắc

Hệ thống chỉ:

- Thu thập dữ liệu thị trường thật cho XAUUSD
- Thu thập tin tức thật liên quan đến USD, vàng và rủi ro vĩ mô
- Tính chỉ báo kỹ thuật
- Gửi dữ liệu cho AI phân tích qua Evolink
- Hiển thị gợi ý giao dịch hoặc lý do không giao dịch
- Lưu lịch sử vào Supabase

Hệ thống không dùng dữ liệu tự tạo hoặc dữ liệu thay thế.

## Cấu Hình ENV

Tạo `.env` từ `.env.example`:

```bash
cp .env.example .env
```

Các biến cần cấu hình:

```bash
EVOLINK_API_KEY=
EVOLINK_MODEL=claude-opus-4-8
EVOLINK_BASE_URL=https://api.evolink.ai/v1/chat/completions
AI_TIMEOUT_MS=90000

MARKET_DATA_PROVIDER=twelvedata
MARKET_DATA_API_KEY=
MARKET_DATA_BASE_URL=https://api.twelvedata.com

NEWS_PROVIDER=gnews
NEWS_API_KEY=
NEWS_BASE_URL=https://gnews.io

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Không expose `SUPABASE_SERVICE_ROLE_KEY`, `MARKET_DATA_API_KEY`, `NEWS_API_KEY` hoặc `EVOLINK_API_KEY` ra frontend.

## Supabase

Project chỉ dùng một bảng: `analysis_history`.

Người dùng chỉ cần chạy một file SQL:

```text
supabase/setup.sql
```

Cách chạy:

1. Mở Supabase project.
2. Vào `SQL Editor`.
3. Copy toàn bộ nội dung `supabase/setup.sql`.
4. Paste vào SQL Editor và bấm `Run`.

File setup idempotent ở mức cần thiết: `create extension if not exists`, `create table if not exists`, `add column if not exists`, `create index if not exists`, và kiểm tra constraint trước khi thêm.

## Dữ Liệu Thị Trường

Provider hiện tại: `twelvedata`.

`MarketDataService` chỉ lấy dữ liệu thật cho `XAUUSD`, gồm:

- Current Price
- Bid
- Ask
- Spread
- M5 candles
- M15 candles
- H1 candles
- H4 candles nếu provider trả được

Nếu không lấy được dữ liệu thật hợp lệ, API phân tích báo lỗi. Không tự tạo candle hoặc dữ liệu thay thế.

## Chỉ Báo

Hệ thống tính:

- EMA20
- EMA50
- EMA200
- RSI14
- MACD
- ATR14
- Support
- Resistance
- Swing High
- Swing Low
- Trend Direction
- Momentum Score
- Volatility Score

## Tin Tức

Provider hiện tại: `newsapi`.

Tin tức tập trung vào:

- USD
- Gold
- Fed
- CPI
- NFP
- PPI
- PMI
- Interest Rate
- Geopolitical Risk

Nếu không lấy được tin tức, hệ thống ghi warning và không tự tạo tin giả.

## Evolink Và AI Output

`AiAnalysisService` gọi endpoint OpenAI-compatible chat completion của Evolink. Nếu thiếu `EVOLINK_API_KEY`, hệ thống báo lỗi rõ ràng.

Prompt có thể bằng tiếng Anh, nhưng toàn bộ nội dung hiển thị cho user phải là tiếng Việt. Chỉ enum values như `TRADE`, `NO_TRADE`, `BUY`, `SELL`, `NONE` được giữ tiếng Anh trong JSON nội bộ.

AI chỉ phân tích `XAUUSD` và chỉ trả một trong hai quyết định:

- `TRADE`
- `NO_TRADE`

Nếu setup không rõ ràng, hệ thống ưu tiên `NO_TRADE`.

## Trading Rules

Rules nằm trong `server/config/tradingRules.ts`:

```ts
export const tradingRules = {
  accountSizeUsd: 70,
  maxLossUsdPerTrade: 5,
  minConfidence: 70,
  minRiskReward: 1.5,
  maxHoldingMinutes: 60,
  maxSpreadPercent: 0.08,
} as const;
```

Không hard-code các giá trị này trong service.

## Validation Và NO_TRADE

AI output được parse JSON, validate bằng Zod, rồi kiểm tra cứng trong `TradeValidationService`.

Kết quả bị ép `NO_TRADE` nếu:

- `confidence < minConfidence`
- `risk_reward < minRiskReward`
- `decision = TRADE` nhưng `direction = NONE`
- entry bằng 0 hoặc không hợp lệ
- stop loss bằng 0 hoặc không hợp lệ
- take profit bằng 0 hoặc không hợp lệ
- BUY có SL >= Entry
- BUY có TP <= Entry
- SELL có SL <= Entry
- SELL có TP >= Entry
- `estimated_loss_if_sl_hit > maxLossUsdPerTrade`
- `data_quality = LOW`
- AI JSON lỗi hoặc sai schema
- spread quá cao
- thiếu dữ liệu realtime hợp lệ

## Chạy Project

```bash
npm install
npm run dev
```

Mở Nuxt URL local và bấm `Hiển thị gợi ý XAUUSD`.

## Kiểm Tra

```bash
npm run typecheck
npm run build
```

Luồng cần kiểm tra thủ công:

1. `/`: bấm `Hiển thị gợi ý XAUUSD`.
2. Kiểm tra card nguồn dữ liệu, cảnh báo dữ liệu và gợi ý giao dịch.
3. `/history`: cập nhật kết quả người dùng đã tự giao dịch bên ngoài hệ thống.
4. `/stats`: xem thống kê hiệu quả XAUUSD.

## Rủi Ro

- Dữ liệu phụ thuộc chất lượng và giới hạn của provider.
- NewsAPI không thay thế lịch kinh tế chuyên dụng.
- AI có thể phân tích sai hoặc trả JSON lỗi; hệ thống đã có validation nhưng người dùng vẫn phải tự kiểm tra.
- Đây là AI Trading Assistant, không phải Trading Bot và không phải lời khuyên tài chính.
