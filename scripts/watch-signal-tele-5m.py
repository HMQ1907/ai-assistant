#!/usr/bin/env python3
"""Quét rule-signal mỗi 2 phút (local, không tốn Cursor quota).
Chỉ Telegram khi có TRADE hợp lệ (BUY NOW / SELL NOW).
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
API_URL = "http://localhost:3000/api/rule-signal"
SNAPSHOT_URL = "http://127.0.0.1:8765/snapshot?symbol=XAUUSDm"
TZ = timezone(timedelta(hours=7))
SCAN_EVERY_MINUTES = 5
LOCK_PATH = ROOT / "scripts" / ".watch-signal-tele.lock"


def acquire_lock() -> object | None:
    """Chỉ cho 1 watcher — tránh spam Telegram khi nhiều process."""
    import atexit
    import os

    try:
        fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_RDWR)
    except OSError as error:
        print(f"[watch] lock open failed: {error}", flush=True)
        return None
    try:
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        print("[watch] another watcher already running — exit", flush=True)
        return None

    def _release() -> None:
        try:
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            os.close(fd)
        except OSError:
            pass
        try:
            LOCK_PATH.unlink(missing_ok=True)
        except OSError:
            pass

    atexit.register(_release)
    os.write(fd, str(os.getpid()).encode("ascii", "ignore"))
    return fd


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def in_window(now: datetime, windows: str) -> bool:
    if not windows:
        return True
    minutes = now.hour * 60 + now.minute
    for part in windows.split(","):
        part = part.strip()
        if "-" not in part:
            continue
        start_s, end_s = part.split("-", 1)
        sh, sm = (int(x) for x in start_s.split(":"))
        eh, em = (int(x) for x in end_s.split(":"))
        if sh * 60 + sm <= minutes < eh * 60 + em:
            return True
    return False


def seconds_until_scan_slot(now: datetime, every_minutes: int = SCAN_EVERY_MINUTES) -> float:
    """Chờ tới ~giây 5 của phút chia hết cho every_minutes."""
    minute = now.minute
    second = now.second + now.microsecond / 1_000_000
    rem = minute % every_minutes
    if rem == 0 and second < 5:
        return max(1.0, 5.0 - second)
    if rem == 0:
        wait = every_minutes * 60 - second + 5
    else:
        wait = (every_minutes - rem) * 60 - second + 5
    return max(1.0, wait)


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def send_telegram(token: str, chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=30):
        pass


def parse_rr(raw: object) -> float:
    text = str(raw or "")
    try:
        if ":" in text:
            return float(text.split(":")[-1])
        return float(text)
    except ValueError:
        return 0.0


def is_valid_trade(result: dict, min_rr: float) -> bool:
    if result.get("decision") != "TRADE":
        return False
    if result.get("direction") not in ("BUY", "SELL"):
        return False
    if not result.get("stop_loss") or not result.get("take_profit"):
        return False
    return parse_rr(result.get("risk_reward")) >= min_rr


def signal_signature(result: dict) -> str:
    entry = result.get("entry_zone") or {}
    entry_from = entry.get("from")
    try:
        bucket = round(float(entry_from) / 5) * 5 if entry_from is not None else "x"
    except (TypeError, ValueError):
        bucket = "x"
    return f"{result.get('direction')}|{bucket}|{result.get('stop_loss')}"


def format_alert(result: dict, history_id: str) -> str:
    direction = result.get("direction")
    entry = result.get("entry_zone") or {}
    entry_text = entry.get("from", "N/A")
    action = "BUY NOW" if direction == "BUY" else "SELL NOW"
    return "\n".join(
        [
            f"XAUUSD — {action}",
            "",
            f"{direction} {result.get('order_type')}",
            f"Giá hiện tại: {result.get('current_price')}",
            f"Entry: {entry_text}",
            f"SL: {result.get('stop_loss')}",
            f"TP: {result.get('take_profit')}",
            f"RR: {result.get('risk_reward')}",
            "",
            f"Lý do: {result.get('trade_reason') or result.get('summary')}",
            "",
            f"Signal ID: {history_id}",
            "Chỉ là tín hiệu — bạn tự quyết định lot và vào lệnh trên MT5.",
        ],
    )


def safe_print(msg: str) -> None:
    """Windows cp1252 console không in được tiếng Việt — fallback ascii."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("ascii", "replace").decode("ascii"), flush=True)


def main() -> int:
    lock = acquire_lock()
    if lock is None:
        return 1

    env = load_env(ENV_PATH)
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    windows = env.get("TRADE_SCANNER_WINDOWS", "08:00-21:30")
    min_rr = float(env.get("TRADE_SCANNER_MIN_RISK_REWARD", "1.5"))
    dedup_minutes = float(env.get("TRADE_SCANNER_DEDUP_MINUTES", "45"))

    if not token or not chat_id:
        safe_print("[watch] missing Telegram config")
        return 1

    last_sig: str | None = None
    last_sig_at = 0.0

    safe_print(
        f"[watch] started — every {SCAN_EVERY_MINUTES}m, window {windows} VN, "
        "Tele ONLY on TRADE (BUY/SELL NOW)",
    )
    send_telegram(
        token,
        chat_id,
        f"Monitor ON — setup đẹp, quét mỗi {SCAN_EVERY_MINUTES} phút.\n"
        "Không auto trade. Chỉ Tele khi BUY NOW / SELL NOW.\n"
        f"Khung: {windows} (giờ VN).",
    )

    while True:
        now = datetime.now(TZ)
        if not in_window(now, windows):
            safe_print(f"[watch] {now:%H:%M} outside window — exit")
            return 0

        wait = seconds_until_scan_slot(now)
        safe_print(f"[watch] sleep {wait:.0f}s until next {SCAN_EVERY_MINUTES}m slot")
        time.sleep(wait)

        now = datetime.now(TZ)
        if not in_window(now, windows):
            safe_print(f"[watch] {now:%H:%M} outside window — exit")
            return 0

        try:
            data = post_json(API_URL, {})
            result = data.get("result") or {}
            history_id = (data.get("history") or {}).get("id", "n/a")
            decision = result.get("decision")
            direction = result.get("direction")
            price = result.get("current_price")
            reason = result.get("no_trade_reason") or result.get("summary")
            safe_print(
                f"[watch] {now:%H:%M:%S} price={price} decision={decision} "
                f"dir={direction} reason={reason}",
            )

            if is_valid_trade(result, min_rr):
                sig = signal_signature(result)
                now_ts = time.time()
                if last_sig == sig and now_ts - last_sig_at < dedup_minutes * 60:
                    safe_print("[watch] duplicate TRADE — skip Tele")
                else:
                    send_telegram(token, chat_id, format_alert(result, history_id))
                    last_sig = sig
                    last_sig_at = now_ts
                    safe_print(f"[watch] Telegram sent: {direction}")
            else:
                safe_print("[watch] NO_TRADE — no Tele")
        except urllib.error.URLError as error:
            safe_print(f"[watch] scan error: {error}")
            time.sleep(SCAN_EVERY_MINUTES * 60)
        except Exception as error:  # noqa: BLE001
            safe_print(f"[watch] unexpected: {error}")
            time.sleep(SCAN_EVERY_MINUTES * 60)


if __name__ == "__main__":
    raise SystemExit(main())
