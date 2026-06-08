# AI Trading Assistant

AI Trading Assistant là công cụ phân tích và đưa gợi ý giao dịch thủ công. Hệ thống không đặt lệnh, không kết nối broker để giao dịch, không tự quyết định Buy/Sell thay người dùng.

Project này không dùng mock/fake/demo market data hoặc news data. Nếu chưa cấu hình API dữ liệu thật, hệ thống sẽ báo lỗi rõ ràng và không fallback sang dữ liệu giả.

## Cấu hình ENV

Tạo `.env` từ `.env.example`:

```bash
cp .env.example .env
```

Các biến cần cấu hình:

```bash
EVOLINK_API_KEY=
EVOLINK_MODEL=claude-opus-4.8
EVOLINK_BASE_URL=https://api.evolink.ai/v1/chat/completions
AI_TIMEOUT_MS=90000

MARKET_DATA_PROVIDER=twelvedata
MARKET_DATA_API_KEY=
MARKET_DATA_BASE_URL=https://api.twelvedata.com

NEWS_PROVIDER=newsapi
NEWS_API_KEY=
NEWS_BASE_URL=https://newsapi.org

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Không expose `SUPABASE_SERVICE_ROLE_KEY`, `MARKET_DATA_API_KEY`, `NEWS_API_KEY`, hoặc `EVOLINK_API_KEY` ra frontend.

## Dữ liệu thị trường thật

Provider hiện tại: `twelvedata`.

Hệ thống gọi Twelve Data để lấy:

- current price
- bid/ask nếu provider hỗ trợ
- spread nếu provider hỗ trợ
- candles M5, M15, H1, H4
- tối thiểu 100 candles cho M5, M15, H1

Nếu symbol không được provider hỗ trợ hoặc candle không đủ, symbol đó bị bỏ qua và lý do được lưu trong `skipped_symbols`. Nếu không còn symbol hợp lệ, API analyze sẽ báo lỗi.

## Tin tức thật

Provider hiện tại: `newsapi`.

Hệ thống gọi NewsAPI-compatible `/v2/everything` để lấy tin liên quan đến USD, gold, crypto, forex, Fed, CPI, NFP, PPI, PMI, interest rate và geopolitical risk.

Provider này không cung cấp lịch tin mạnh sắp tới theo cấu hình hiện tại, nên `upcomingEvents` có thể rỗng và hệ thống sẽ ghi warning. Nếu không lấy được news, hệ thống không bịa tin; AI sẽ nhận `newsDataStatus = UNAVAILABLE`.

## Supabase

1. Tạo Supabase project.
2. Chạy migration:
   - `supabase/migrations/001_analysis_history.sql`
   - `supabase/migrations/002_analysis_history_data_metadata.sql`
3. Cấu hình `SUPABASE_URL`.
4. Cấu hình `SUPABASE_SERVICE_ROLE_KEY`.

Nếu migrate từ SQLite cũ, export dữ liệu cũ thủ công rồi insert vào `analysis_history`. Field `entry` cũ map sang `entry_from` và `entry_to`; ID cũ dạng number được thay bằng UUID.

## Evolink

`AiAnalysisService` gọi endpoint OpenAI-compatible chat completion. Nếu thiếu `EVOLINK_API_KEY`, hệ thống báo lỗi thay vì tạo AI response giả.

## Chạy project

```bash
npm install
npm run dev
```

Mở Nuxt URL local và bấm `Hiển thị lệnh gợi ý`. Khi bấm, hệ thống lấy dữ liệu thật tại thời điểm đó, tính indicator, gọi AI, validate kết quả, lưu Supabase và hiển thị UI tiếng Việt.

## Kiểm tra flow

1. `/`: bấm `Hiển thị lệnh gợi ý`.
2. Kiểm tra card nguồn dữ liệu: market provider, news provider, timestamp, data quality, news status, warnings, skipped symbols.
3. `/history`: cập nhật entry/exit/P/L/status/note.
4. `/stats`: xem tổng phân tích, win rate, confidence stats và symbol performance.
5. Chạy:

```bash
npm run typecheck
npm run build
```

## Validation

AI output được parse JSON, validate bằng Zod, rồi kiểm tra cứng trong `TradeValidationService`.

Kết quả bị ép `NO_TRADE` nếu:

- confidence thấp hơn `minConfidence`
- risk reward thấp hơn `minRiskReward`
- data quality tổng thể là `LOW`
- symbol không có realtime data
- candle data thiếu
- entry, SL, TP bằng 0
- BUY/SELL có SL/TP sai logic
- spread vượt ngưỡng cấu hình
- news unavailable trong khi AI vẫn trả `TRADE`

Rules nằm trong `server/config/tradingRules.ts`.

## Nguyên tắc an toàn

- Không auto trade.
- Không đặt lệnh.
- Không kết nối broker để giao dịch.
- Không cam kết thắng.
- Không dùng winrate giả.
- Người dùng tự quyết định và tự thao tác bên ngoài hệ thống.
