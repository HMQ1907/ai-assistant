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
EVOLINK_MODEL=gemini-3.5-flash
EVOLINK_BASE_URL=https://api.evolink.ai/v1/chat/completions
AI_TIMEOUT_MS=90000

MARKET_DATA_PROVIDER=twelvedata
MARKET_DATA_API_KEY=
MARKET_DATA_BASE_URL=https://api.twelvedata.com
MAX_QUOTE_AGE_SECONDS=180
MARKET_DATA_DEBUG=false

NEWS_PROVIDER=gnews
NEWS_API_KEY=
NEWS_BASE_URL=https://gnews.io
NEWS_MAX_AGE_HOURS=48

ACCOUNT_SIZE_USD=200
MAX_LOSS_PERCENT_PER_TRADE=15
MAX_DAILY_LOSS_PERCENT=15

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Không expose `SUPABASE_SERVICE_ROLE_KEY`, `MARKET_DATA_API_KEY`, `NEWS_API_KEY` hoặc `EVOLINK_API_KEY` ra frontend.

## Codex Watch Plan + Prefilter/Executor XAU 1 Phút

Luồng mặc định tách việc đọc thị trường và việc canh trigger:

1. Heartbeat Codex 15 phút đọc H4/H1/M15/M5 và ghi tối đa hai vùng chờ vào
   `.runtime-logs/codex-xau-watch-plan.json`.
2. Prefilter local đọc bridge MT5 mỗi phút, chỉ dùng nến đã đóng và không gọi
   LLM.
3. Giá gần vùng chỉ chuyển plan sang `ARMED`. Một trigger M1/M5 đóng hợp lệ mới
   tạo `CANDIDATE`.
4. Plan có `execution.autoExecute=true` được script recheck news, health,
   orders, daily P/L, snapshot, spread, drift và RR rồi đặt đúng một MARKET
   order. Plan không cấp quyền này và mọi broad candidate vẫn chờ Codex review.

Khởi động:

```powershell
npm run mt5:bridge
npm run xau:prefilter
```

Chạy một lượt để kiểm tra:

```powershell
npm run xau:prefilter:once
```

Kết quả được ghi vào `.runtime-logs/codex-xau-prefilter-signal.json`, còn trạng
thái từng plan nằm ở `.runtime-logs/codex-xau-watch-state.json`. Các trạng thái
watch gồm `NO_PLAN`, `WATCHING`, `ARMED`, `TRIGGER_REJECTED`, `TRIGGERED`,
`INVALIDATED` và `EXPIRED`. Chỉ `TRIGGERED` sinh `CANDIDATE`. Script chỉ được
đặt lệnh mới từ watch plan cấp quyền rõ ràng; không sửa/đóng lệnh và không được
auto-trade broad discovery.

Schema tham khảo nằm tại `scripts/codex-xau-watch-plan.example.json`. Mỗi plan
phải có `planId`, `expiresAt`, `direction`, vùng `zone`, `trigger.mode`,
`risk.invalidationPrice`, `risk.firstBarrier`, giới hạn spread và RR tối thiểu.
Muốn script tự thực thi, plan còn phải có `execution.autoExecute=true`, MARKET,
volume đúng `0.04`, `maxEntryDriftAtr` và `maxTriggerAgeSeconds`. Thiếu bất kỳ
trường nào đều fail closed. Signature được ghi `ATTEMPTED` trước POST nên lỗi
timeout cũng không thể retry và đặt trùng.
Trigger hỗ trợ:

- `REJECTION`: rejection/engulfing đóng trong vùng.
- `RETEST_HOLD`: chạm vùng rồi đóng giữ lại phía thuận hướng.
- `BREAKOUT_RETEST`: đã có breakout trước đó, sau đó retest và đóng giữ vùng.
- `CLOSE_THROUGH`: nến đóng xuyên vùng theo đúng hướng; chỉ dùng khi Codex chủ
  động chọn vì dễ thành chase hơn các mode retest.

Signature là `planId + direction + trigger mode + confirmation timeframe + thời gian nến đóng`.
Vì vậy cùng một nến không wake lặp, nhưng một retest hợp lệ mới ở nến khác không
bị cooldown 45 phút chặn nhầm. Có thể bật bộ quét rộng cũ bằng biến môi trường
`CODEX_XAU_ENABLE_BROAD_PREFILTER=1`; mặc định tắt để script chỉ canh vùng do
Codex lập.

Mỗi vòng 1 phút cũng ghi một dòng JSON vào
`.runtime-logs/codex-xau-prefilter-history-YYYY-MM-DD.jsonl`. Dòng audit gồm
`decision`, regime, P/L ngày, quote/spread, nến M5 đóng gần nhất, cấu trúc,
trigger, volume và risk gate. Đây là kết luận deterministic (`llmCalled=false`,
`quotaUsed=false`), không phải quyết định giao dịch cuối của Codex. Chỉ packet
`CANDIDATE`/`FOLLOW_REQUIRED` mới kích hoạt wake và dùng quota.

### Đánh thức đúng Codex task khi có candidate

Chạy wake server song song với prefilter:

```powershell
npm run xau:wake
```

Server chỉ bind `127.0.0.1:8776`, tự quan sát packet và resume task Codex bằng
Codex CLI local. Candidate được chống lặp theo signature của đúng nến trigger;
`FOLLOW_REQUIRED` tối đa một wake mỗi 5 phút; chỉ một turn được chạy tại một
thời điểm. Heartbeat 15 phút vẫn là fallback nếu wake server tạm dừng.

Cấu hình tùy chọn tại `.runtime-logs/codex-thread-wake-config.json`:

```json
{
  "threadId": "019ffe00-b62b-7850-810f-9cb897653e9c",
  "cwd": "D:\\hmq\\AI ASSISTANT",
  "model": "",
  "timeoutSeconds": 720
}
```

Kiểm tra toàn luồng mà không gọi Codex/quota:

```powershell
npm run xau:wake:dry
```

API thủ công dùng `POST http://127.0.0.1:8776/wake`, body là packet JSON và
header `Authorization: Bearer <token>`. Token tự sinh tại
`.runtime-logs/codex-thread-wake-token`; không đưa token vào source hoặc log.

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

Provider hiện tại: `gnews`.

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
  accountSizeUsd: 200,
  maxLossPercentPerTrade: 15,
  maxDailyLossPercent: 15,
  minConfidence: 75,
  minRiskReward: 1.5,
  maxHoldingMinutes: 60,
  maxSpreadPercent: 0.08,
  minLot: 0.01,
  lotStep: 0.01,
  xauUsdOuncesPerLot: 100,
} as const;
```

Giới hạn lỗ mỗi lệnh được tính theo vốn hiện tại người dùng nhập. Ví dụ vốn `70 USD` và `MAX_LOSS_PERCENT_PER_TRADE=15` thì mức lỗ tối đa mỗi lệnh là `10.5 USD`. Đây là hard cap, không phải mục tiêu phải dùng hết.

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
npm run lint
npm run test
npm run build
```

Luồng cần kiểm tra thủ công:

1. `/`: bấm `Hiển thị gợi ý XAUUSD`.
2. Kiểm tra card nguồn dữ liệu, cảnh báo dữ liệu và gợi ý giao dịch.
3. `/history`: cập nhật kết quả người dùng đã tự giao dịch bên ngoài hệ thống.
4. `/stats`: xem thống kê hiệu quả XAUUSD.

## Rủi Ro

- Dữ liệu phụ thuộc chất lượng và giới hạn của provider.
- GNews không thay thế lịch kinh tế chuyên dụng như CPI, NFP hoặc FOMC calendar.
- AI có thể phân tích sai hoặc trả JSON lỗi; hệ thống đã có validation nhưng người dùng vẫn phải tự kiểm tra.
- Đây là AI Trading Assistant, không phải Trading Bot và không phải lời khuyên tài chính.
