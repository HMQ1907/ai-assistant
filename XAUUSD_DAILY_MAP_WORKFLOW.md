# XAUUSDm Daily Map & Manual Signal Workflow

## 1. Mục tiêu

Hệ thống phân tích XAUUSDm theo bối cảnh tổng thể trong ngày, theo dõi vùng giá tự động và gửi tín hiệu Telegram sau khi Codex review lần cuối.

Hệ thống **không tự đặt, sửa hoặc đóng lệnh**. Người dùng tự quyết định và tự thao tác trên MT5.

## 2. Kiến trúc tổng thể

```text
Heartbeat theo phiên
        |
        v
Codex đọc H4/H1/M15/M5
        |
        v
Ghi daily watch plan (duy nhất 1 vùng ACTIVE)
        |
        v
Script local quét mỗi 60 giây
        |
        +-- Giá còn xa vùng ----------> tiếp tục theo dõi
        |
        +-- Giá gần vùng -------------> SETUP ARMED -> Telegram ngay + gọi Codex review
        +-- Giá nằm trong vùng --------> ENTRY WINDOW OPEN -> Telegram ngay + gọi Codex review
        |
        +-- M5 đóng đúng trigger -----> CANDIDATE -> gọi Codex final review
        |
        +-- M5 vô hiệu plan ----------> REMAP_REQUIRED -> gọi Codex lập lại map
        +-- M15 đi xa/phá cản --------> FAVORABLE_DISPLACEMENT -> gọi Codex remap ngay
                                            |
                                            v
                         Đủ hard gate và quality-adjusted RR >= 1.2?
                                  |                    |
                                 Có                  Không
                                  |                    |
                                  v                    v
                         Gửi 1 Telegram          Không gửi tín hiệu
                         Người dùng tự đặt lệnh
```

## 3. Lịch lập và review bản đồ

Codex chủ động review toàn bộ thị trường tại phút **01 sau mỗi nến H1 đóng**, từ **08:01 đến 22:01 VN**.

Prefilter local phát `MAP_REVIEW_REQUIRED` ở mọi mốc hourly này và wake-server mở một lượt Codex độc lập. Vì vậy hourly review vẫn chạy ngay cả khi task Desktop đang bận; heartbeat hourly không được dùng để tránh gọi trùng.

Ngay sau mỗi lần lập/review bản đồ phiên, Codex gửi một Telegram `WATCH PLAN XAUUSDm`, kể cả khi kết luận không có vùng đủ chuẩn. Watch-plan Telegram chỉ thông báo những gì hệ thống đang chờ và **chưa phải tín hiệu vào lệnh**.

Hourly review không phải thời điểm duy nhất Codex được gọi. Giữa các lượt, script vẫn quét mỗi phút và đánh thức Codex ngay khi:

- Giá tiến gần vùng đã map.
- Có trigger M5 đóng.
- Plan bị vô hiệu.
- Nến M15 đóng cách vùng ít nhất 1.5 ATR M5 hoặc đóng xuyên cản đầu tiên theo hướng thuận lợi.

Tin USD high-impact có blackout riêng nên thời gian review hoặc gửi tín hiệu có thể bị chặn.

## 4. Phương pháp phân tích

Đây là **price action đa khung thời gian theo hướng intraday tổng thể**:

| Khung | Vai trò |
|---|---|
| H4 | Bối cảnh lớn và regime trong ngày |
| H1 | Bias chính, cấu trúc và hướng ưu tiên |
| M15 | Vùng giao dịch, swing và cản quan trọng |
| M5 | Xác nhận entry bằng nến đã đóng |
| M1 | Không sử dụng trong workflow mới |

EMA, VWAP, ATR và volume chỉ là dữ liệu hỗ trợ. Chúng không được thay thế cấu trúc giá, vị trí hoặc không gian TP.

### Phân loại regime

- **TREND:** chỉ tìm pullback/retest thuận hướng H1/H4.
- **RANGE:** chỉ tìm rejection tại biên; không giao dịch giữa range.
- **TRANSITION:** chỉ giao dịch sau breakout đóng nến và retest xác nhận.

## 5. Daily watch plan

Tại mọi thời điểm chỉ có **một plan `ACTIVE`**. Hourly review ưu tiên giữ nguyên `planId`, direction, zone và `generatedAt` nếu thesis/risk vẫn hợp lệ và plan đó vẫn là cơ hội tốt nhất. Không tạo thêm vùng dự phòng thứ hai.

- Nếu plan không đổi: không ghi lại file chỉ để làm mới timestamp; Telegram ghi `GIỮ NGUYÊN PLAN CŨ`.
- Nếu có plan tốt hơn hoặc thesis cũ mất hiệu lực: thay toàn bộ danh sách bằng đúng một plan mới; Telegram ghi `PLAN MỚI`.
- Nếu không còn vùng đủ chuẩn: ghi `plans: []`; Telegram ghi `KHÔNG CÓ WATCH PLAN ACTIVE`.

Ví dụ cấu trúc:

```json
{
  "version": 1,
  "generatedAt": "2026-08-21T08:01:00+07:00",
  "plans": [
    {
      "planId": "xau-20260821-daily-buy-retest",
      "symbol": "XAUUSDm",
      "status": "ACTIVE",
      "priority": 1,
      "generatedAt": "2026-08-21T08:01:00+07:00",
      "expiresAt": "2026-08-21T23:00:00+07:00",
      "regime": "TREND",
      "direction": "BUY",
      "thesis": "H4/H1 bullish; wait for an M15 support retest.",
      "zone": {
        "low": 4500.0,
        "high": 4503.0,
        "proximityAtr": 0.35
      },
      "trigger": {
        "timeframe": "M5",
        "confirmationTimeframe": "M5",
        "mode": "RETEST_HOLD",
        "requireClosed": true,
        "minVolumeRatio": 0.8
      },
      "risk": {
        "invalidationPrice": 4496.0,
        "firstBarrier": 4515.0,
        "conservativeTakeProfit": 4514.0,
        "minimumSlBuffer": 1.0,
        "maxSpread": 0.35,
        "minRrAfterCost": 1.6
      },
      "execution": {
        "mode": "SIGNAL_ONLY",
        "autoExecute": false
      },
      "preMortem": "Reject if H1 loses support or M5 closes below invalidation."
    }
  ]
}
```

Các mức giá trong ví dụ chỉ minh họa cấu trúc file, không phải tín hiệu giao dịch.

Nếu không có vùng rõ ràng hoặc TP bảo thủ không đạt RR sau chi phí tối thiểu 1.2, Codex ghi:

```json
{
  "version": 1,
  "generatedAt": "<ISO VN>",
  "plans": []
}
```

## 6. Các trạng thái do script phát hiện

### `NO_SIGNAL`

Giá chưa tới vùng hoặc chưa có M5 trigger. Script tiếp tục quét, không gọi Telegram.

### `ZONE_APPROACH`

Watcher gửi Telegram trực tiếp theo hai cấp để không phụ thuộc task Codex có đang bận hay không:

- `SETUP ARMED`: quote đã đến gần vùng theo `proximityAtr`.
- `ENTRY WINDOW OPEN`: giá khớp hướng giao dịch (ask cho BUY, bid cho SELL) đang thực sự nằm trong vùng.

Cả hai đều không phải lệnh để đặt trực tiếp từ chính tin nhắn cảnh báo. Codex được gọi song song để ra quyết định. Với `SETUP ARMED`, Codex chỉ chuẩn bị/kiểm tra plan. Với `ENTRY WINDOW OPEN`, Codex có thể phát `TÍN HIỆU SỚM` ngay trong vùng mà không bắt buộc chờ M5 đóng nếu toàn bộ early-entry gate bên dưới đạt; nếu không thì tiếp tục chờ trigger M5 xác nhận. Nếu task chính đang có active writer, wake server chuyển sang một lượt Codex độc lập thay vì bỏ sự kiện.

Mọi WATCH PLAN và cảnh báo vùng phải hiển thị riêng `mức vô hiệu cấu trúc` và `SL cấu trúc dự kiến`. SL dự kiến dùng buffer tối thiểu của plan; khi có trigger, SL chính thức được tính lại bằng `max(1.5 × spread, 0.15 × ATR M5, minimumSlBuffer)`.

Giá đã tiến gần/chạm vùng theo `proximityAtr`.

Codex được gọi để:

- Lấy snapshot mới.
- Kiểm tra H4/H1/M15 thesis còn đúng không.
- Kiểm tra giá có đang chase hoặc cấu trúc đã thay đổi không.
- Giữ, chỉnh hoặc xóa plan.

Tin `ZONE_APPROACH` tự nó **chưa phải tín hiệu vào lệnh**. Chỉ một Telegram mới bắt đầu bằng `TÍN HIỆU XAUUSDm` mới cho phép người dùng tự đặt lệnh.

#### Tín hiệu sớm tại `ENTRY WINDOW OPEN`

Codex được phép quyết đoán phát `Grade EARLY` khi đủ tất cả:

- H4/H1 bias và M15 location cùng hướng với plan.
- Quote thực thi đang trong zone, không chase, chưa chạm invalidation.
- News, daily P/L, order-state và spread gate đều clear.
- SL nằm ngoài invalidation với buffer đầy đủ; TP trước cản đầu tiên; RR sau chi phí tối thiểu `1.20`.
- M5 đóng gần nhất không phải expansion mạnh ngược hướng (`body >= 0.60 ATR` và `volume >= 1.20x`) và thesis không có hai bằng chứng vô hiệu.

Telegram phải ghi `TÍN HIỆU SỚM - HIGHER RISK`, entry/vùng entry hiệu lực tối đa 90 giây, SL chính thức, TP, RR và `Bạn tự đặt lệnh`. Không đủ bất kỳ gate nào thì không phát tín hiệu sớm và chờ M5 đóng xác nhận.

Mỗi phiên bản plan chỉ phát tối đa một `SETUP ARMED` và một `ENTRY WINDOW OPEN`; mỗi signature Telegram được tiêu thụ trước khi gửi mạng để không gửi trùng khi timeout.

### `CANDIDATE`

Một nến M5 đã đóng và khớp trigger của watch plan. Candidate chỉ là shortlist, không phải tín hiệu chắc chắn.

Candidate có hiệu lực tối đa bảy phút sau khi nến trigger đóng. Codex phải lấy dữ liệu mới và review lại toàn bộ trước khi gửi Telegram.

### `REMAP_REQUIRED`

Một nến M5 đóng đã vô hiệu plan. Codex không được dùng plan cũ để phát tín hiệu mà phải cập nhật hoặc xóa bản đồ.

Ngoài ra, script phát `REMAP_REQUIRED/FAVORABLE_DISPLACEMENT` sau một nến M15 đóng nếu giá đã đi thuận hướng quá xa vùng (ít nhất 1.5 ATR M5) hoặc đã phá cản đầu tiên. Nến M15 đó phải bắt đầu sau thời điểm plan được tạo; nến đang hình thành lúc Codex vừa lập plan không được kích wake ngược lại. Wake được latch một lần cho mỗi chu kỳ dịch chuyển, nên scanner một phút không gọi Codex lặp lại. Codex lấy giá mới và quyết định giữ, thay hoặc xóa plan duy nhất ngay, không chờ H1 tiếp theo.

### `MAP_REVIEW_REQUIRED`

Đến lượt hourly/checkpoint và cần review tổng thể H4/H1/M15/M5.

## 7. Final review trước Telegram

Khi nhận `CANDIDATE`, Codex phải recheck:

1. News cache đúng ngày và không nằm trong blackout USD high-impact ±30 phút.
2. `/health`, `/orders` và `/deals` xác minh được.
3. Quote và nến mới, spread bình thường.
4. Plan chưa hết hạn hoặc bị vô hiệu.
5. Bias H4/H1 còn nguyên.
6. Candidate nằm đúng vùng M15, không chase và không ở giữa range.
7. Trigger đến từ nến M5 đã đóng.
8. SL nằm ngoài swing invalidation với buffer hợp lệ.
9. TP đặt trước cản đối diện đầu tiên.
10. RR sau spread và slippage tối thiểu 1.2. Nhóm 1.2–1.59 phải đạt ít nhất 4/5 lớp và bắt buộc có momentum/volume; RR từ 1.6 là grade A.

Tín hiệu cần ít nhất ba lớp độc lập trong các nhóm:

- Structure/regime H4/H1.
- Location M15.
- Closed-M5 trigger.
- Momentum/volume.
- Không gian tới TP.

Nếu cản đầu tiên nằm trước +1R hoặc giá phải phá cản mới đạt RR đã khai báo, candidate bị bác.

## 8. Telegram

Chỉ Codex được gửi Telegram. Script theo dõi không tự gửi message.

### Telegram watch plan

Được gửi sau mỗi hourly review từ 08:01–22:01 hoặc một lần remap cấu trúc hoàn tất. Telegram ghi rõ plan được GIỮ NGUYÊN, CẬP NHẬT hay HỦY. Nội dung gồm:

- Bias/regime hiện tại.
- Một vùng duy nhất đang theo dõi.
- Hướng BUY/SELL của vùng đó.
- Trigger M5 cần chờ.
- Invalidation, first barrier và TP bảo thủ.
- Thời hạn plan.
- Dòng cảnh báo: **CHƯA PHẢI TÍN HIỆU VÀO LỆNH**.

Nếu không có vùng đạt chuẩn, Telegram ghi rõ `KHÔNG CÓ WATCH PLAN ACTIVE`.

### Telegram tín hiệu

Chỉ được gửi sau final review một `CANDIDATE` M5.

Telegram phải gồm:

- BUY hoặc SELL.
- Entry tham khảo hoặc vùng entry.
- SL.
- TP bảo thủ.
- RR sau chi phí.
- Lý do chính.
- Mức vô hiệu.
- Dòng nhắc: **Bạn tự đặt lệnh**.

Ví dụ:

```text
TÍN HIỆU XAUUSDm — BUY
Vùng entry tham khảo: 4500.5–4502.0
SL: 4496.0
TP: 4514.0
RR sau chi phí: 1.75
Lý do: H1 bullish, M15 retest support, M5 rejection đóng nến.
Invalidation: M5/H1 mất 4497.0.
Bạn tự đặt lệnh.
```

Telegram được chống gửi trùng bằng candidate signature. Trạng thái được lưu trước khi gọi Telegram; timeout không được retry cùng signature để tránh gửi hai lần.

### Chuẩn định dạng Telegram

- Mỗi trường nằm trên một dòng riêng.
- Khi gọi helper qua command line, dùng chuỗi literal `\\n`; helper sẽ chuyển thành xuống dòng thật.
- Dùng dấu câu đơn giản, hạn chế emoji, em dash và ký tự trang trí để tránh lỗi hiển thị.
- Mẫu watch plan chuẩn:

```text
WATCH PLAN XAUUSDm
Thoi gian: 09:34 VN
Regime: TRANSITION/RANGE
Bias: SELL tai bien tren

Vung theo doi: 4541.2 - 4543.9
Trigger: M5 rejection da dong
Invalidation: 4543.877
First barrier: 4533.513
TP bao thu: 4534.0
RR yeu cau: toi thieu 1.6
Het han: 23:00 VN

CHUA PHAI TIN HIEU VAO LENH.
```

## 9. Các lớp an toàn

- `execution.mode` luôn là `SIGNAL_ONLY`.
- `autoExecute` luôn là `false`.
- Prefilter có chặn cứng mọi POST tới bridge MT5.
- Không gọi `/order`, `/order/modify` hoặc `/order/cancel`.
- Broad discovery bị tắt; script chỉ theo dõi plan do Codex lập.
- M1 trigger bị tắt.
- Candidate stale bị bác.
- News, dữ liệu hoặc trạng thái MT5 không xác minh được thì fail closed.
- Daily P/L ≤ -40 USD hoặc ≥ +200 USD thì không phát tín hiệu mới.

## 10. File và tiến trình chính

| Thành phần | Đường dẫn/vai trò |
|---|---|
| Prefilter | `scripts/codex-xau-prefilter.py` — quét mỗi phút, không ghi MT5 |
| Wake server | `scripts/codex-thread-wake-server.py` — chỉ khi có event mới, mở một lượt Codex CLI độc lập `--ephemeral` để đọc chung memory/state, review và gửi Telegram; không resume task Desktop |
| Watchdog Windows | Scheduled Tasks `Codex-XAU-Prefilter` và `Codex-XAU-WakeServer` — chạy khi đăng nhập, không cho chạy trùng và tự khởi động lại sau lỗi mỗi 1 phút |
| Telegram helper | `scripts/send-codex-xau-signal.py` — gửi tín hiệu đã review và chống trùng |
| Watch plan | `.runtime-logs/codex-xau-watch-plan.json` |
| Watch state | `.runtime-logs/codex-xau-watch-state.json` |
| Signal packet | `.runtime-logs/codex-xau-prefilter-signal.json` |
| Snapshot local | `.runtime-logs/codex-xau-prefilter-snapshot.json` |
| Review state | `.runtime-logs/codex-xau-review-state.json` |
| Telegram state | `.runtime-logs/codex-xau-telegram-signals.json` |

## 11. Tóm tắt trách nhiệm

### Codex

- Đọc bối cảnh ngày.
- Lập và cập nhật watch plan.
- Review khi giá gần vùng.
- Final review khi có M5 candidate.
- Gửi Telegram nếu tất cả hard gate đạt.

### Script local

- Chạy mỗi phút mà không dùng quota LLM.
- Theo dõi vùng và nến M5 đóng.
- Ghi packet và gọi lại Codex.
- Không đưa ra quyết định cuối cùng.
- Không thao tác lệnh MT5.

### Người dùng

- Nhận Telegram.
- Tự đánh giá thêm nếu muốn.
- Tự đặt và quản lý lệnh trên MT5.

## 12. Nguyên tắc cốt lõi

```text
Codex quyết định vùng và chất lượng setup.
Script quyết định khi nào cần gọi lại Codex.
Codex quyết định có gửi tín hiệu hay không.
Người dùng quyết định có đặt lệnh hay không.
```
