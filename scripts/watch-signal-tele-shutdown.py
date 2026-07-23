#!/usr/bin/env python3
"""Quét rule-signal mỗi ~60s; TRADE hợp lệ -> Telegram -> tắt Nuxt dev."""
from __future__ import annotations

import json
import os
import subprocess
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
TZ = timezone(timedelta(hours=7))
SCAN_SECONDS = 55


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
    data = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text},
    ).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=30):
        pass


def find_nuxt_pid() -> int | None:
    try:
        out = subprocess.check_output(
            ["netstat", "-ano"],
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
    except subprocess.CalledProcessError:
        return None
    for line in out.splitlines():
        if "[::1]:3000" in line and "LISTENING" in line:
            parts = line.split()
            if parts:
                try:
                    return int(parts[-1])
                except ValueError:
                    return None
    return None


def stop_nuxt() -> None:
    pid = find_nuxt_pid()
    if pid is None:
        print("[watch] Nuxt not listening on :3000")
        return
    subprocess.run(["taskkill", "//PID", str(pid), "//F"], check=False)
    print(f"[watch] stopped Nuxt PID {pid}")


def format_alert(result: dict, history_id: str) -> str:
    entry = result.get("entry_zone") or {}
    entry_text = entry.get("from", "N/A")
    return "\n".join(
        [
            "XAUUSD — setup hợp lệ (M5/M15/H1/H4)",
            "",
            f"{result.get('direction')} {result.get('order_type')}",
            f"Giá hiện tại: {result.get('current_price')}",
            f"Entry: {entry_text}",
            f"SL: {result.get('stop_loss')}",
            f"TP: {result.get('take_profit')}",
            f"RR: {result.get('risk_reward')}",
            "",
            f"Lý do: {result.get('trade_reason') or result.get('summary')}",
            "",
            f"Signal ID: {history_id}",
            "Bạn tự quyết định lot và vào lệnh trên MT5.",
            "",
            "(Bot scanner sẽ tắt sau khi gửi tin này.)",
        ],
    )


def is_valid_trade(result: dict, min_rr: float) -> bool:
    if result.get("decision") != "TRADE":
        return False
    if result.get("direction") not in ("BUY", "SELL"):
        return False
    if not result.get("stop_loss") or not result.get("take_profit"):
        return False
    rr_raw = str(result.get("risk_reward") or "")
    try:
        if ":" in rr_raw:
            rr = float(rr_raw.split(":")[-1])
        else:
            rr = float(rr_raw)
    except ValueError:
        rr = 0.0
    return rr >= min_rr


def main() -> int:
    env = load_env(ENV_PATH)
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    windows = env.get("TRADE_SCANNER_WINDOWS", "14:00-21:30")
    min_rr = float(env.get("TRADE_SCANNER_MIN_RISK_REWARD", "1.5"))

    if not token or not chat_id:
        print("[watch] missing Telegram config", file=sys.stderr)
        return 1

    print(f"[watch] started — scan every {SCAN_SECONDS}s, window {windows} VN", flush=True)

    while True:
        now = datetime.now(TZ)
        if not in_window(now, windows):
            print(f"[watch] {now:%H:%M} outside window — stopping without signal")
            stop_nuxt()
            return 0

        try:
            data = post_json(API_URL, {})
            result = data.get("result") or {}
            history_id = (data.get("history") or {}).get("id", "n/a")
            decision = result.get("decision")
            direction = result.get("direction")
            price = result.get("current_price")
            reason = result.get("no_trade_reason") or result.get("summary")
            print(
                f"[watch] {now:%H:%M:%S} price={price} decision={decision} dir={direction} reason={reason}",
                flush=True,
            )

            if is_valid_trade(result, min_rr):
                alert = format_alert(result, history_id)
                send_telegram(token, chat_id, alert)
                print("[watch] Telegram sent — shutting down scanner")
                stop_nuxt()
                return 0
        except urllib.error.URLError as error:
            print(f"[watch] scan error: {error}", file=sys.stderr)
        except Exception as error:  # noqa: BLE001
            print(f"[watch] unexpected error: {error}", file=sys.stderr)

        time.sleep(SCAN_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
