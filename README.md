# AI Trading Assistant

Ứng dụng phân tích thủ công cho hai thị trường:

- `XAUUSD`: dữ liệu Twelve Data, tin tức GNews.
- `BTCUSD`: dữ liệu `BTCUSDT` từ Binance Spot và tin tức CryptoPanic.

Hệ thống thu thập dữ liệu thật, tính chỉ báo đa khung M5/M15/H1/H4, gửi AI qua Evolink, hiển thị gợi ý và lưu lịch sử vào Supabase. Hệ thống không tự đặt lệnh, không kết nối broker và không phải auto trading bot.

## Cấu hình

Tạo `.env` từ `.env.example`, sau đó điền các khóa:

```env
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
NEWS_MAX_AGE_HOURS=48

BTC_MARKET_DATA_PROVIDER=binance
BTC_MARKET_DATA_BASE_URL=https://api.binance.com
BTC_NEWS_PROVIDER=cryptopanic
BTC_NEWS_API_KEY=
BTC_NEWS_BASE_URL=https://cryptopanic.com
BTC_NEWS_MAX_AGE_HOURS=48

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

### Lấy API cho BTC

- Binance Spot market data là API công khai, luồng hiện tại không cần API key.
- Tạo tài khoản CryptoPanic tại `https://cryptopanic.com/`, mở trang API/developer của tài khoản và lấy auth token, sau đó đặt vào `BTC_NEWS_API_KEY`.
- Dữ liệu giá BTC dùng cặp `BTCUSDT` làm proxy cho `BTCUSD`; giao diện và lịch sử lưu symbol nội bộ là `BTCUSD`.

Không đưa bất kỳ API key hoặc Supabase service role key nào ra frontend.

## Supabase

Chỉ chạy một file SQL:

```text
supabase/setup.sql
```

Trong Supabase Dashboard, mở `SQL Editor`, dán toàn bộ nội dung file trên và bấm `Run`. File tạo bảng `analysis_history`, các cột lịch sử, constraints và indexes; có thể chạy lại an toàn.

## Luồng sử dụng

1. Nhập mật khẩu truy cập.
2. Dashboard hiển thị hai thị trường XAUUSD và BTCUSD.
3. Mỗi thị trường có ba trang: Phân tích, Lịch sử, Thống kê.
4. Nhập vốn hiện tại và chạy phân tích.
5. Người dùng tự đặt lệnh bên ngoài hệ thống nếu chấp nhận gợi ý.

## Quản trị rủi ro

Rules nằm trong `server/config/tradingRules.ts`:

- Confidence tối thiểu: `65`.
- Risk/reward tối thiểu: `1:1.5`.
- Giới hạn lỗ: `15%` vốn hiện tại.
- XAUUSD: `1 lot = 100 oz`, lot tối thiểu `0.01`.
- BTCUSD: khối lượng tính theo BTC, tối thiểu `0.00001 BTC`.

Validation ép `NO_TRADE` khi dữ liệu LOW, thiếu giá realtime hoặc indicator bắt buộc, confidence/RR không đạt, Entry/SL/TP sai logic hoặc mức lỗ vượt giới hạn.

## Chạy project

```bash
npm install
npm run dev
```

Kiểm tra production:

```bash
npm run typecheck
npm run test
npm run build
```

## Lưu ý

- Không có mock/fake fallback trong luồng production.
- Binance hoạt động 24/7 nhưng `BTCUSDT` không hoàn toàn giống giá BTCUSD tại mọi broker.
- CryptoPanic cần auth token và giới hạn request phụ thuộc gói tài khoản.
- AI có thể phân tích sai. Đây không phải lời khuyên tài chính.
