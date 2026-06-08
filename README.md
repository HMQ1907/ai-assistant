# AI Trading Assistant

AI Trading Assistant là công cụ phân tích và đưa gợi ý giao dịch thủ công. Hệ thống không đặt lệnh, không kết nối broker để giao dịch, và không tự quyết định Buy/Sell thay người dùng.

Project này chỉ dùng dữ liệu thị trường thật và tin tức thật. Nếu chưa cấu hình API dữ liệu thật, hệ thống sẽ báo lỗi rõ ràng và không tự tạo dữ liệu thay thế.

## Cấu Hình ENV

Tạo `.env` từ `.env.example`:

```bash
cp .env.example .env
```

Các biến bắt buộc:

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

## Dữ Liệu Thị Trường

Provider hiện tại: `twelvedata`.

Hệ thống gọi Twelve Data để lấy current price, bid/ask nếu provider hỗ trợ, spread nếu provider hỗ trợ, và candles M5/M15/H1/H4. M5, M15 và H1 cần tối thiểu 100 candles nếu provider hỗ trợ.

Nếu symbol không được provider hỗ trợ hoặc candle không đủ, symbol đó bị bỏ qua và lý do được lưu trong `skipped_symbols`. Nếu không còn symbol hợp lệ, API analyze sẽ báo lỗi.

## Tin Tức

Provider hiện tại: `newsapi`.

Hệ thống gọi NewsAPI-compatible `/v2/everything` để lấy tin liên quan đến USD, gold, crypto, forex, Fed, CPI, NFP, PPI, PMI, interest rate và geopolitical risk.

Nếu không lấy được tin tức, hệ thống không tự tạo tin. AI sẽ nhận `newsDataStatus = UNAVAILABLE` và validation có thể ép `NO_TRADE`.

## Supabase

1. Tạo Supabase project.
2. Chạy migration:
   - `supabase/migrations/001_analysis_history.sql`
   - `supabase/migrations/002_analysis_history_data_metadata.sql`
3. Cấu hình `SUPABASE_URL`.
4. Cấu hình `SUPABASE_SERVICE_ROLE_KEY`.

Nếu migrate từ bản lưu trữ cũ, export dữ liệu cũ thủ công rồi insert vào `analysis_history`. Field `entry` cũ map sang `entry_from` và `entry_to`; ID cũ dạng number được thay bằng UUID.

## Evolink

`AiAnalysisService` gọi endpoint OpenAI-compatible chat completion. Nếu thiếu `EVOLINK_API_KEY`, hệ thống báo lỗi thay vì tạo AI response thay thế.

## Chạy Project

```bash
npm install
npm run dev
```

Mở Nuxt URL local và bấm `Hiển thị lệnh gợi ý`. Khi bấm, hệ thống lấy dữ liệu thật tại thời điểm đó, tính indicator, gọi AI, validate kết quả, lưu Supabase và hiển thị UI tiếng Việt.

## Kiểm Tra

```bash
npm run typecheck
npm run build
```

Luồng kiểm tra:

1. `/`: bấm `Hiển thị lệnh gợi ý`.
2. Kiểm tra card nguồn dữ liệu: provider, timestamp, chất lượng dữ liệu, trạng thái tin tức, cảnh báo, symbol bị bỏ qua.
3. `/history`: cập nhật entry/exit/P/L/status/note.
4. `/stats`: xem tổng phân tích, tỷ lệ thắng, độ tin cậy và hiệu suất symbol.

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

## Nguyên Tắc An Toàn

- Không auto trade.
- Không đặt lệnh.
- Không kết nối broker để giao dịch.
- Không cam kết thắng.
- Không dùng winrate tự tạo.
- Người dùng tự quyết định và tự thao tác bên ngoài hệ thống.
