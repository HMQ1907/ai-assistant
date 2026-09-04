#!/usr/bin/env python3
"""Send one deduplicated XAUUSDm update to Telegram.

This helper has no MT5 access. The caller must provide the final user-facing
message after validating the fresh local market snapshot or completing review.
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
STATE_PATH = ROOT / ".runtime-logs" / "codex-xau-telegram-signals.json"
WAKE_TOKEN_PATH = ROOT / ".runtime-logs" / "codex-thread-wake-token"
TELEGRAM_RELAY_URL = "http://127.0.0.1:8776/telegram"
VN = timezone(timedelta(hours=7))


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_PATH.exists():
        return values
    for raw in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_state() -> dict[str, object]:
    try:
        value = json.loads(STATE_PATH.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {"signals": {}}
    except (OSError, ValueError):
        return {"signals": {}}


def save_state(value: dict[str, object]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, STATE_PATH)


def send_via_local_relay(chat_id: str, message: str) -> dict[str, object]:
    token = WAKE_TOKEN_PATH.read_text(encoding="utf-8-sig").strip()
    body = json.dumps({"chat_id": chat_id, "text": message}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        TELEGRAM_RELAY_URL,
        data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError("local Telegram relay returned ok=false")
    return {"ok": True, "result": {"message_id": payload.get("messageId")}}


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a reviewed XAUUSDm watch plan or manual signal")
    parser.add_argument("--signature", required=True)
    parser.add_argument("--message", required=True)
    args = parser.parse_args()
    signature = args.signature.strip()
    # Callers pass literal \\n so formatting survives PowerShell/CLI argument parsing.
    message = args.message.replace("\\n", "\n").strip()
    allowed_prefixes = ("TÍN HIỆU XAUUSDm", "WATCH PLAN XAUUSDm")
    if not signature or not message.startswith(allowed_prefixes):
        raise SystemExit(
            "signature is required and message must start with "
            "'TÍN HIỆU XAUUSDm' or 'WATCH PLAN XAUUSDm'"
        )

    state = read_state()
    signals = state.setdefault("signals", {})
    if not isinstance(signals, dict):
        signals = {}
        state["signals"] = signals
    if signature in signals:
        print(json.dumps({"ok": True, "deduped": True, "signature": signature}))
        return 0

    now = datetime.now(VN).isoformat(timespec="seconds")
    signals[signature] = {"status": "ATTEMPTED", "at": now}
    save_state(state)  # Persist before network POST; an ambiguous timeout is never retried.

    env = load_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        signals[signature] = {"status": "FAILED", "at": now, "reason": "missing Telegram config"}
        save_state(state)
        raise SystemExit("missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")

    try:
        if WAKE_TOKEN_PATH.exists():
            payload = send_via_local_relay(chat_id, message)
        else:
            data = urllib.parse.urlencode({"chat_id": chat_id, "text": message}).encode("utf-8")
            request = urllib.request.Request(
                f"https://api.telegram.org/bot{token}/sendMessage", data=data, method="POST"
            )
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:  # Network timeout is ambiguous: keep signature consumed.
        signals[signature] = {"status": "UNCERTAIN", "at": now, "reason": str(error)[:240]}
        save_state(state)
        raise SystemExit("Telegram result uncertain; signature will not retry") from error

    if not payload.get("ok"):
        signals[signature] = {"status": "FAILED", "at": now, "reason": "Telegram returned ok=false"}
        save_state(state)
        raise SystemExit("Telegram returned ok=false")
    message_id = ((payload.get("result") or {}).get("message_id"))
    signals[signature] = {"status": "VERIFIED", "at": now, "messageId": message_id}
    save_state(state)
    print(json.dumps({"ok": True, "deduped": False, "signature": signature, "messageId": message_id}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
