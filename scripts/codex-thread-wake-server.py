#!/usr/bin/env python3
"""Authenticated localhost bridge from XAU prefilter packets to a Codex thread."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import secrets
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime-logs"
ENV_PATH = ROOT / ".env"
PACKET_PATH = RUNTIME / "codex-xau-prefilter-signal.json"
CONFIG_PATH = RUNTIME / "codex-thread-wake-config.json"
TOKEN_PATH = RUNTIME / "codex-thread-wake-token"
STATE_PATH = RUNTIME / "codex-thread-wake-state.json"
LOG_PATH = RUNTIME / "codex-thread-wake.log"
OUTPUT_PATH = RUNTIME / "codex-thread-wake-last-message.txt"
EVENTS_PATH = RUNTIME / "codex-thread-wake-events.jsonl"
CODEX_STDOUT_PATH = RUNTIME / "codex-thread-wake-codex.stdout.log"
CODEX_STDERR_PATH = RUNTIME / "codex-thread-wake-codex.stderr.log"

VN = timezone(timedelta(hours=7))
DEFAULT_THREAD_ID = "019ffe00-b62b-7850-810f-9cb897653e9c"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8776
WATCH_SECONDS = 2.0
CANDIDATE_DEDUPE_SECONDS = 45 * 60
ZONE_APPROACH_DEDUPE_SECONDS = 4 * 60 * 60
FOLLOW_STATE_DEDUPE_SECONDS = 45 * 60
FOLLOW_M5_DEDUPE_SECONDS = 45 * 60
PROTECT_RETRY_SECONDS = 3 * 60
REMAP_DEDUPE_SECONDS = 60 * 60
MAP_REVIEW_DEDUPE_SECONDS = 60 * 60
FAILURE_RETRY_SECONDS = 3 * 60
MAX_BODY_BYTES = 128 * 1024
ALLOWED_STATUSES = {"FOLLOW_REQUIRED", "REMAP_REQUIRED", "MAP_REVIEW_REQUIRED"}


def load_env_values() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for raw in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def relay_telegram(chat_id: str, message: str) -> dict[str, Any]:
    env = load_env_values()
    configured_chat = env.get("TELEGRAM_CHAT_ID", "")
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    if not token or not configured_chat or chat_id != configured_chat:
        raise ValueError("invalid Telegram relay destination")
    data = urllib.parse.urlencode({"chat_id": configured_chat, "text": message}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=data, method="POST"
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError("Telegram returned ok=false")
    return payload


def now_vn() -> datetime:
    return datetime.now(VN)


def iso(value: datetime | None = None) -> str:
    return (value or now_vn()).isoformat(timespec="seconds")


def log(message: str) -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    line = f"{iso()} {message}"
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    print(line, flush=True)


def read_json(path: Path, default: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else (default or {})
    except (OSError, ValueError):
        return default or {}


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temporary, path)


def append_event(value: dict[str, Any]) -> None:
    with EVENTS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def parse_time(value: object) -> datetime | None:
    try:
        text = str(value or "")
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(VN)
    except ValueError:
        return None


def packet_is_fresh(packet: dict[str, Any], current: datetime | None = None) -> bool:
    expires = parse_time(packet.get("expiresAt"))
    return bool(expires and expires > (current or now_vn()))


def ticket_from_packet(packet: dict[str, Any]) -> str:
    for order in packet.get("activeOrders") or []:
        ticket = order.get("ticket") or order.get("position_ticket") or order.get("order")
        if ticket:
            return str(ticket)
    return "unknown"


def event_identity(packet: dict[str, Any], current: datetime | None = None) -> tuple[str, int]:
    status = str(packet.get("status") or "").upper()
    current = current or now_vn()
    if status == "CANDIDATE":
        candidate = packet.get("candidate") or {}
        signature = str(candidate.get("signature") or "")
        if not signature:
            raw = json.dumps(candidate, sort_keys=True, separators=(",", ":"))
            signature = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
        return f"candidate:{signature}", CANDIDATE_DEDUPE_SECONDS
    if status == "ZONE_APPROACH":
        proximity = packet.get("proximity") or {}
        signature = str(proximity.get("signature") or "")
        if not signature:
            raw = json.dumps(proximity, sort_keys=True, separators=(",", ":"))
            signature = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
        return f"zone:{signature}", ZONE_APPROACH_DEDUPE_SECONDS
    if status == "FOLLOW_REQUIRED":
        follow = packet.get("follow") or {}
        signature = str(follow.get("signature") or f"{ticket_from_packet(packet)}|UNKNOWN")
        kind = str(follow.get("kind") or "ORDER_STATE").upper()
        dedupe = PROTECT_RETRY_SECONDS if kind == "PROTECT_0_8R" else (
            FOLLOW_M5_DEDUPE_SECONDS if kind == "FILLED_M5_REVIEW" else FOLLOW_STATE_DEDUPE_SECONDS
        )
        return f"follow:{signature}", dedupe
    if status == "REMAP_REQUIRED":
        remap = packet.get("remap") or {}
        signature = str(remap.get("signature") or "")
        if not signature:
            raw = json.dumps(remap, sort_keys=True, separators=(",", ":"))
            signature = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
        return f"remap:{signature}", REMAP_DEDUPE_SECONDS
    if status == "MAP_REVIEW_REQUIRED":
        review = packet.get("mapReview") or {}
        signature = str(review.get("signature") or review.get("closedM15At") or "")
        if not signature:
            raw = json.dumps(review, sort_keys=True, separators=(",", ":"))
            signature = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
        return f"map:{signature}", MAP_REVIEW_DEDUPE_SECONDS
    return f"ignored:{status}", CANDIDATE_DEDUPE_SECONDS


def compact_packet(packet: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "version", "generatedAt", "expiresAt", "symbol", "status", "reason",
        "dailyPlUsd", "newsGate", "health", "activeOrders", "candidate", "diagnostics",
        "watchState", "watchPlan", "proximity", "remap", "follow", "mapReview",
    }
    return {key: packet[key] for key in allowed if key in packet}


def build_prompt(packet: dict[str, Any]) -> str:
    status = str(packet.get("status") or "UNKNOWN").upper()
    packet_json = json.dumps(compact_packet(packet), ensure_ascii=False, separators=(",", ":"))
    telegram_chat_id = ""
    try:
        for line in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
            if line.startswith("TELEGRAM_CHAT_ID="):
                telegram_chat_id = line.split("=", 1)[1].strip()
                break
    except OSError:
        pass
    telegram_authorization = (
        f"Đích Telegram cấu hình chính xác là chat ID {telegram_chat_id}; đây là chat riêng của chính người dùng "
        "và người dùng đã yêu cầu, ủy quyền rõ việc gửi WATCH PLAN/tín hiệu vào chat này. "
        if telegram_chat_id else
        "Chỉ gửi Telegram nếu scripts/send-codex-xau-signal.py xác minh được đích đã cấu hình. "
    )
    return (
        f"WAKE EVENT XAUUSDm SIGNAL-ONLY: {status}. Script chỉ theo dõi daily watch plan và tuyệt đối không đặt lệnh. "
        "Đây là một lượt Codex độc lập, không phải resume task Desktop. Hãy đọc "
        "C:/Users/pc/.codex/automations/codex-auto-trade-xauusd-m-i-n-n-m5/memory.md, "
        ".runtime-logs/codex-xau-review-state.json và packet hiện tại; xác minh lại "
        ".runtime-logs/codex-xau-watch-plan.json, MT5/news/daily gate theo rule mới nhất trong task. "
        "Nếu MAP_REVIEW_REQUIRED và mapReview.requiresNewsRefresh=true, trước hết tra lịch USD high-impact từ nguồn uy tín, cập nhật codex-usd-news-cache.json đúng ngày VN; nếu đang trong blackout thật thì DONT_NOTIFY và tuyệt đối không đọc MT5. Nếu cache đã clear, tiếp tục review bản đồ. "
        "Nếu MAP_REVIEW_REQUIRED, lập/review bản đồ ngày từ H4/H1/M15/M5 và chỉ cho phép DUY NHẤT 1 plan ACTIVE có hiệu lực đến 23:00 VN; M1 không dùng để xác lập cấu trúc/regime. "
        "Plan mới phải đặt risk.minRrAfterCost=1.00 để quality-adjusted RR hoạt động: 1.00-1.19 là Grade C khi đủ 5/5 lớp và momentum/volume xác nhận; 1.20-1.59 là Grade B khi đủ lớp; >=1.60 là Grade A; không ép mọi plan thành 1.60. "
        "trigger.mode phải là CHÍNH XÁC một trong REJECTION, RETEST_HOLD, BREAKOUT_RETEST, CLOSE_THROUGH; không được tạo tên mô tả ghép như BULLISH_REJECTION_RETEST. "
        "Mỗi plan phải có trigger.entryPolicy và trigger.minVolumeRatio mặc định 0.70. Trend hoặc transition pullback/retest có hướng rõ được đặt EARLY_ALLOWED để M1 đóng làm timing. BREAKOUT_RETEST cũng được EARLY_ALLOWED nhưng M1 chỉ xác nhận retest SAU KHI breakout M5 đã đóng; RANGE và CLOSE_THROUGH phải đặt M5_REQUIRED. "
        "Trước khi ghi, so sánh plan hiện tại. Nếu plan hiện tại vẫn là cơ hội tốt nhất và thesis, direction, zone, invalidation, TP còn nguyên thì "
        "KHÔNG tạo planId mới, KHÔNG đổi generatedAt/zone và KHÔNG ghi lại file chỉ để làm mới timestamp; gửi Telegram ngắn với tiêu đề "
        "WATCH PLAN XAUUSDm - GIỮ NGUYÊN PLAN CŨ, signature MAP_HOLD|closedH1At|planId, rồi nêu planId, vùng, hướng, trigger và expiry. "
        "Nếu có cấu trúc/vùng tốt hơn hoặc plan cũ mất hiệu lực thì thay toàn bộ plans bằng đúng 1 plan mới và gửi WATCH PLAN XAUUSDm - PLAN MỚI "
        "với signature MAP|generatedAt. Không tạo vùng dự phòng thứ hai. Nếu không có plan đủ chuẩn thì ghi plans rỗng và gửi KHÔNG CÓ WATCH PLAN ACTIVE. "
        + telegram_authorization +
        "Sau khi ghi watch plan, gửi đúng một Telegram WATCH PLAN bằng scripts/send-codex-xau-signal.py với signature MAP|generatedAt; "
        "nêu bias/regime, vùng duy nhất, hướng, trigger M5, invalidation, TP/cản, expiry và ghi rõ CHƯA PHẢI TÍN HIỆU VÀO LỆNH. "
        "Trong tham số --message phải dùng chuỗi literal \\n giữa từng mục; tránh emoji, em dash và ký tự trang trí để Telegram hiển thị rõ. "
        "Nếu ZONE_APPROACH, local watcher đã gửi SETUP ARMED hoặc ENTRY WINDOW OPEN có điều kiện; không gửi trùng cảnh báo đó. "
        "SETUP_ARMED chỉ chuẩn bị và review plan. Riêng ENTRY_WINDOW_OPEN phải được xử lý như một quyết định giao dịch ngay, không được mặc định trả lời CHỜ chỉ vì M5 chưa đóng. "
        "Codex được phép phát TÍN HIỆU XAUUSDm - TÍN HIỆU SỚM (Grade EARLY, rủi ro cao hơn tín hiệu xác nhận) để người dùng tự đặt MARKET hoặc LIMIT trong vùng nếu và chỉ nếu: "
        "(1) H4/H1 bias và M15 location còn cùng hướng; (2) executable quote đang trong vùng, plan chưa invalidated và không chase; "
        "(3) spread <= maxSpread, news/daily/order gates clear; (4) SL cấu trúc nằm ngoài invalidation với buffer đầy đủ, TP trước cản đầu tiên và RR sau chi phí >=1.00; "
        "(5) nến M5 đóng gần nhất không phải expansion mạnh ngược hướng (body >=0.60 ATR M5 và volume >=1.20x) và không có hai bằng chứng độc lập phá thesis. "
        "Với RR 1.00-1.19 chỉ phát Grade C khi đủ 5/5 lớp và momentum/volume xác nhận; tuyệt đối không nới SL hay kéo TP để đạt ngưỡng. "
        "Tín hiệu sớm phải ghi rõ EARLY/HIGHER RISK, Entry hoặc vùng entry còn hiệu lực tối đa 90 giây, SL CHÍNH THỨC, TP, RR, lý do và 'Bạn tự đặt lệnh'; tuyệt đối không gọi endpoint MT5 write. "
        "Nếu thiếu bất kỳ gate nào thì không phát tín hiệu sớm; tiếp tục chờ CANDIDATE M5 đóng. Nếu plan sai thì cập nhật/huỷ plan và gửi WATCH PLAN HỦY/CẬP NHẬT. "
        "Nếu CANDIDATE có signalTier=EARLY hoặc triggerCandle.timeframe=M1, recheck ngay như tín hiệu sớm: M1 chỉ timing, H4/H1/M15 phải còn cùng hướng, quote còn trong vùng, tuổi tín hiệu tối đa 90 giây; nếu đạt thì tiêu đề TÍN HIỆU XAUUSDm - EARLY/HIGHER RISK. "
        "Nếu CANDIDATE M5, chấp nhận cả nến directional close rõ hoặc chuỗi chạm vùng ở M5 trước rồi M5 sau đóng tiếp diễn; không đòi mẫu textbook. Recheck nến M5 đóng, news, quote/spread, orders/P&L, dynamic SL/TP và quality-adjusted RR: "
        "Grade A cần RR sau chi phí >=1.60 và ít nhất 3 lớp; Grade B cần RR 1.20-1.59, ít nhất 4/5 lớp và momentum/volume đạt; Grade C cần RR 1.00-1.19, đủ 5/5 lớp và momentum/volume đạt; RR<1.00 thì bác. "
        "Nếu candidate.orderTypeHint=LIMIT thì đây là limit sau xác nhận, không phải limit mù: recheck vùng/SL/TP/RR rồi gửi đúng BUY LIMIT hoặc SELL LIMIT tại candidate.entry kèm limitExpiresAt; không đổi thành MARKET nếu giá đã chạy xa. "
        "Nếu đạt, KHÔNG gọi bất kỳ endpoint đặt lệnh nào; gửi đúng một Telegram bằng scripts/send-codex-xau-signal.py với tiêu đề TÍN HIỆU XAUUSDm - CONFIRMED để người dùng tự đặt. "
        "Nếu candidate.testOnly=true, đây là kiểm thử end-to-end: không phát tín hiệu giao dịch; chỉ recheck read-only health/orders/deals/snapshot rồi gửi "
        "WATCH PLAN XAUUSDm - E2E TEST RESULT ghi rõ KHONG PHAI TIN HIEU VAO LENH. "
        "Nếu không đạt thì không Telegram và lưu lý do. Nếu REMAP_REQUIRED kind=FAVORABLE_DISPLACEMENT, lấy quote mới và nến H4/H1/M15/M5 đóng, "
        "đánh giá plan cũ đã quá xa/phá cản hay chưa rồi áp dụng rule một plan: giữ nguyên nếu vẫn thật sự là vùng tốt nhất, nếu không thì thay bằng đúng một plan mới hoặc plans rỗng. "
        "Các REMAP_REQUIRED khác cũng chỉ lập lại bản đồ. Fail closed nếu packet "
        "hết hạn hoặc dữ liệu stale. Tiến trình codex exec hiện tại và record wake event đang queued/running là chính lượt "
        "được wake-server giao, hoàn toàn bình thường và KHÔNG được coi là Codex turn xung đột. Chỉ fail vì trùng khi có "
        "một event khác đã VERIFIED/ATTEMPTED cùng signature hoặc có bằng chứng rõ một tiến trình khác đang ghi đúng cùng plan. "
        "Sau mọi MAP_REVIEW_REQUIRED hoàn tất, phải lưu chính xác packet.mapReview.signature vào lastPrefilterReviewedSignature cùng lastPrefilterReviewedAt để packet đầu giờ được nhả ngay. "
        "Sau khi review candidate, lưu lastPrefilterReviewedSignature và lastPrefilterReviewedAt vào state để chống lặp. "
        f"Packet nén: {packet_json}"
    )


def is_active_writer_conflict(output: str) -> bool:
    normalized = output.lower()
    return "active writer" in normalized or "thread-store conflict" in normalized


def discover_codex() -> Path:
    configured = os.environ.get("CODEX_WAKE_EXECUTABLE")
    candidates = [
        Path(configured) if configured else None,
        Path.home() / ".codex" / ".sandbox-bin" / "codex.exe",
        Path.home() / ".codex" / "plugins" / ".plugin-appserver" / "codex.exe",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate
    raise FileNotFoundError("Không tìm thấy Codex CLI; đặt CODEX_WAKE_EXECUTABLE")


def codex_subprocess_env() -> dict[str, str]:
    """Use normal Codex auth/config without sharing Desktop thread state."""
    environment = os.environ.copy()
    environment.pop("CODEX_SQLITE_HOME", None)
    return environment


def load_config() -> dict[str, Any]:
    config = read_json(CONFIG_PATH, {})
    config.setdefault("threadId", os.environ.get("CODEX_WAKE_THREAD_ID", DEFAULT_THREAD_ID))
    config.setdefault("cwd", str(ROOT))
    config.setdefault("model", os.environ.get("CODEX_WAKE_MODEL", ""))
    config.setdefault("timeoutSeconds", 12 * 60)
    return config


def ensure_token() -> str:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    if TOKEN_PATH.exists():
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    TOKEN_PATH.write_text(token + "\n", encoding="utf-8")
    return token


@dataclass(frozen=True)
class WakeEvent:
    key: str
    packet: dict[str, Any]
    accepted_at: str


class WakeCoordinator:
    def __init__(self, dry_run: bool = False) -> None:
        self.dry_run = dry_run
        self.events: queue.Queue[WakeEvent] = queue.Queue(maxsize=16)
        self.lock = threading.Lock()
        self.state = read_json(STATE_PATH, {"events": {}})
        self.state.setdefault("events", {})
        self.running_key: str | None = None

    def _persist(self) -> None:
        atomic_json(STATE_PATH, self.state)

    def submit(self, packet: dict[str, Any], source: str) -> tuple[bool, str, str]:
        status = str(packet.get("status") or "").upper()
        if status not in ALLOWED_STATUSES:
            return False, "ignored_status", ""
        if not packet_is_fresh(packet):
            return False, "stale_packet", ""
        key, dedupe_seconds = event_identity(packet)
        current = now_vn()
        with self.lock:
            previous = (self.state.get("events") or {}).get(key) or {}
            previous_at = parse_time(previous.get("acceptedAt"))
            previous_status = str(previous.get("result") or "")
            retry_after = FAILURE_RETRY_SECONDS if previous_status == "failed" else dedupe_seconds
            if previous_at and (current - previous_at).total_seconds() < retry_after:
                return False, "duplicate", key
            event = WakeEvent(key=key, packet=packet, accepted_at=iso(current))
            try:
                self.events.put_nowait(event)
            except queue.Full:
                return False, "queue_full", key
            self.state["events"][key] = {
                "acceptedAt": event.accepted_at,
                "source": source,
                "result": "queued",
            }
            self.state["lastAcceptedKey"] = key
            self._persist()
        append_event({"at": event.accepted_at, "event": "queued", "key": key, "source": source})
        log(f"queued key={key} source={source}")
        return True, "queued", key

    def run_worker(self) -> None:
        while True:
            event = self.events.get()
            self.running_key = event.key
            result, detail = "failed", ""
            try:
                result, detail = self._run(event)
            except Exception as error:  # noqa: BLE001
                detail = str(error).replace("\n", " ")[:500]
                log(f"failed key={event.key} error={detail}")
            completed_at = iso()
            with self.lock:
                record = self.state["events"].setdefault(event.key, {})
                record.update({"completedAt": completed_at, "result": result, "detail": detail[:500]})
                self.state["lastCompletedKey"] = event.key
                self._persist()
            append_event({"at": completed_at, "event": result, "key": event.key, "detail": detail[:500]})
            self.running_key = None
            self.events.task_done()

    def _run(self, event: WakeEvent) -> tuple[str, str]:
        if self.dry_run:
            log(f"dry-run key={event.key}")
            return "dry_run", "Codex CLI was not invoked"
        config = load_config()
        command = [
            str(discover_codex()), "exec", "--ephemeral", "--approve-for-me", "--json",
            "--output-last-message", str(OUTPUT_PATH),
        ]
        model = str(config.get("model") or "").strip()
        if model:
            command.extend(["--model", model])
        command.append(build_prompt(event.packet))
        log(f"dispatch standalone key={event.key}")
        # Windows sandbox setup may leave a long-lived ACL helper running. If
        # stdout/stderr are PIPEs, that helper can inherit them and keep
        # subprocess.run() blocked after the actual Codex process exits. Real
        # files avoid that inherited-pipe EOF deadlock and retain diagnostics.
        with CODEX_STDOUT_PATH.open("w", encoding="utf-8") as stdout_handle, \
                CODEX_STDERR_PATH.open("w", encoding="utf-8") as stderr_handle:
            completed = subprocess.run(
                command,
                cwd=str(config.get("cwd") or ROOT),
                env=codex_subprocess_env(),
                stdout=stdout_handle,
                stderr=stderr_handle,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=int(config.get("timeoutSeconds") or 720),
                check=False,
            )
        stdout_text = CODEX_STDOUT_PATH.read_text(encoding="utf-8", errors="replace")
        stderr_text = CODEX_STDERR_PATH.read_text(encoding="utf-8", errors="replace")
        stdout_tail, stderr_tail = stdout_text[-4000:], stderr_text[-2000:]
        append_event({
            "at": iso(), "event": "codex_exit", "key": event.key,
            "exitCode": completed.returncode, "stdoutTail": stdout_tail, "stderrTail": stderr_tail,
        })
        if completed.returncode != 0:
            raise RuntimeError(f"Codex exit {completed.returncode}: {stderr_tail or stdout_tail}")
        log(f"completed key={event.key}")
        return "completed", f"Codex exit {completed.returncode}"


class WakeHandler(BaseHTTPRequestHandler):
    server_version = "CodexWake/1.0"

    def _json(self, status: HTTPStatus, value: dict[str, Any]) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False})
            return
        coordinator: WakeCoordinator = self.server.coordinator  # type: ignore[attr-defined]
        self._json(HTTPStatus.OK, {
            "ok": True, "queueDepth": coordinator.events.qsize(),
            "runningKey": coordinator.running_key, "threadId": load_config().get("threadId"),
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/wake", "/telegram"}:
            self._json(HTTPStatus.NOT_FOUND, {"ok": False})
            return
        expected = "Bearer " + self.server.token  # type: ignore[attr-defined]
        if not secrets.compare_digest(self.headers.get("Authorization", ""), expected):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "reason": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "reason": "invalid_body_size"})
            return
        try:
            packet = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(packet, dict):
                raise ValueError("packet must be an object")
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "reason": str(error)})
            return
        if self.path == "/telegram":
            try:
                chat_id = str(packet.get("chat_id") or "")
                message = str(packet.get("text") or "")
                if not message or len(message) > 12000:
                    raise ValueError("invalid Telegram message")
                payload = relay_telegram(chat_id, message)
                message_id = ((payload.get("result") or {}).get("message_id"))
                self._json(HTTPStatus.OK, {"ok": True, "messageId": message_id})
            except Exception as error:  # noqa: BLE001
                log(f"telegram relay failed={str(error)[:240]}")
                self._json(HTTPStatus.BAD_GATEWAY, {"ok": False, "reason": str(error)[:240]})
            return
        coordinator: WakeCoordinator = self.server.coordinator  # type: ignore[attr-defined]
        accepted, reason, key = coordinator.submit(packet, "api")
        self._json(HTTPStatus.ACCEPTED if accepted else HTTPStatus.OK, {
            "ok": True, "accepted": accepted, "reason": reason, "key": key,
        })

    def log_message(self, format_: str, *args: object) -> None:
        log("http " + (format_ % args))


def watch_packet(coordinator: WakeCoordinator) -> None:
    while True:
        try:
            raw = PACKET_PATH.read_bytes()
            packet = json.loads(raw.decode("utf-8-sig"))
            if isinstance(packet, dict):
                # submit() performs status-aware dedupe. Rechecking the same packet lets a
                # failed dispatch retry after FAILURE_RETRY_SECONDS while it is still fresh.
                coordinator.submit(packet, "watcher")
        except (OSError, ValueError, json.JSONDecodeError) as error:
            log(f"watch warning={str(error)[:300]}")
        time.sleep(WATCH_SECONDS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Wake a Codex thread from XAU prefilter events")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Wake API chỉ được bind localhost")
    coordinator = WakeCoordinator(dry_run=args.dry_run)
    threading.Thread(target=coordinator.run_worker, name="codex-wake-worker", daemon=True).start()
    threading.Thread(target=watch_packet, args=(coordinator,), name="packet-watcher", daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), WakeHandler)
    server.coordinator = coordinator  # type: ignore[attr-defined]
    server.token = ensure_token()  # type: ignore[attr-defined]
    log(f"listening http://{args.host}:{args.port} dryRun={args.dry_run}")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
