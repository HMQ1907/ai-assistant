#!/usr/bin/env python3
"""Local XAUUSDm daily-map watcher (signal only).

Runs every minute without calling an LLM. It writes a compact candidate
packet and wakes Codex when price approaches a mapped zone or a closed M5
trigger confirms. It never places, modifies, or closes an order.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime-logs"
STATE_PATH = RUNTIME / "codex-xau-review-state.json"
NEWS_PATH = RUNTIME / "codex-usd-news-cache.json"
PACKET_PATH = RUNTIME / "codex-xau-prefilter-signal.json"
SNAPSHOT_PATH = RUNTIME / "codex-xau-prefilter-snapshot.json"
WATCH_PLAN_PATH = RUNTIME / "codex-xau-watch-plan.json"
WATCH_STATE_PATH = RUNTIME / "codex-xau-watch-state.json"
EXECUTION_STATE_PATH = RUNTIME / "codex-xau-auto-execution.json"
ENV_PATH = ROOT / ".env"
LOCK_PATH = RUNTIME / "codex-xau-prefilter.lock"
LOG_PATH = RUNTIME / "codex-xau-prefilter.log"
HISTORY_PREFIX = "codex-xau-prefilter-history"

VN = timezone(timedelta(hours=7))
SYMBOL = "XAUUSDm"
BRIDGE = "http://127.0.0.1:8765"
ACTIVE_START_MINUTE = 8 * 60
ACTIVE_END_MINUTE = 23 * 60
SCAN_SECONDS = 60
FOLLOW_SCAN_SECONDS = 60
DEFAULT_PACKET_TTL_MINUTES = 20
CANDIDATE_TTL_MINUTES_AFTER_CLOSE = 7
FAST_CANDIDATE_TTL_SECONDS_AFTER_CLOSE = 90
MAP_REVIEW_TTL_MINUTES = 7
MAP_REVIEW_GRACE_MINUTES = 10
# Hourly H1 review is emitted locally so it is not skipped when the Desktop
# heartbeat thread is already busy. The event-driven wake server launches an
# independent ephemeral Codex review for each slot.
DAILY_MAP_REVIEW_SLOTS = {(hour, 1) for hour in range(8, 23)}
MIN_RR = 1.00
GRADE_A_RR = 1.60
GRADE_B_RR = 1.20
GRADE_B_MIN_LAYERS = 4
GRADE_C_MIN_LAYERS = 5
BROAD_MIN_RR = 1.40
BROAD_MIN_VOLUME_RATIO = 0.80
BROAD_MIN_BODY_ATR = 0.45
BROAD_MIN_REWARD_ATR = 0.75
# A mapped M5 setup does not need a textbook engulf/wick pattern to become a
# review candidate. A clearly directional close is sufficient because volume,
# RR, structural SL/TP and Codex's final review remain separate hard gates.
DIRECTIONAL_CLOSE_MIN_BODY_ATR = 0.12
DIRECTIONAL_CLOSE_MIN_BODY_RATIO = 0.30
DIRECTIONAL_CLOSE_EDGE = 0.55
DEFAULT_PROXIMITY_ATR = 0.35
FAVORABLE_DISPLACEMENT_ATR = 1.50
FAVORABLE_DISPLACEMENT_RESET_ATR = 0.75
SUPPORTED_TRIGGER_MODES = {"REJECTION", "RETEST_HOLD", "BREAKOUT_RETEST", "CLOSE_THROUGH"}
AUTO_VOLUME = 0.04
AUTO_COMMENT = "codex-xau-plan-auto"

TIMEFRAME_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "H1": 3600, "H4": 14400}


@dataclass(frozen=True)
class Candle:
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    spread: float

    @property
    def body(self) -> float:
        return abs(self.close - self.open)

    @property
    def range(self) -> float:
        return max(0.0, self.high - self.low)


def now_vn() -> datetime:
    return datetime.now(VN)


def iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def parse_time(value: object) -> datetime:
    text = str(value or "")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temporary, path)


def log(message: str) -> None:
    line = f"{iso(now_vn())} {message}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def audit_path(current: datetime) -> Path:
    """Use one JSONL file per VN day so the history stays bounded and searchable."""
    return RUNTIME / f"{HISTORY_PREFIX}-{current.astimezone(VN).date().isoformat()}.jsonl"


def audit_record(packet: dict[str, Any]) -> dict[str, Any]:
    """Build a deterministic Codex-like summary without calling any model."""
    generated = parse_time(packet.get("generatedAt")).astimezone(VN)
    status = str(packet.get("status") or "UNKNOWN").upper()
    diagnostics = packet.get("diagnostics") or {}
    candidate = packet.get("candidate") or {}
    if status == "CANDIDATE":
        decision = "DIRECT_TELEGRAM_SIGNAL"
    elif status == "ZONE_APPROACH":
        decision = "LOCAL_ZONE_ALERT"
    elif status == "REMAP_REQUIRED":
        decision = "REMAP_REQUIRED"
    elif status == "FOLLOW_REQUIRED":
        decision = "FOLLOW_REQUIRED"
    elif status == "MAP_REVIEW_REQUIRED":
        decision = "MAP_REVIEW_REQUIRED"
    elif status in {"OUTSIDE_HOURS", "NEWS_BLACKOUT"}:
        decision = "DONT_NOTIFY"
    else:
        decision = "NO_TRADE"
    regime = str(diagnostics.get("regime") or "N/A")
    reason = str(packet.get("reason") or "")
    return {
        "at": iso(generated),
        "symbol": packet.get("symbol", SYMBOL),
        "status": status,
        "decision": decision,
        "regime": regime,
        "dailyPlUsd": packet.get("dailyPlUsd"),
        "reason": reason,
        "conclusion": (
            f"{decision} — {regime}; P/L ngày "
            f"{packet.get('dailyPlUsd', 'N/A')} USD; {reason}"
        ),
        "quote": {
            "bid": diagnostics.get("bid"),
            "ask": diagnostics.get("ask"),
            "spread": diagnostics.get("spread"),
            "ageSeconds": diagnostics.get("quoteAgeSeconds"),
        },
        "closedM5": diagnostics.get("latestClosedM5"),
        "structure": {
            "direction": diagnostics.get("structuralDirection"),
            "support": diagnostics.get("support"),
            "resistance": diagnostics.get("resistance"),
            "ema20M5": diagnostics.get("ema20M5"),
            "ema50M5": diagnostics.get("ema50M5"),
            "sessionVwap": diagnostics.get("sessionVwap"),
        },
        "trigger": {
            "direction": diagnostics.get("triggerDirection"),
            "labels": diagnostics.get("triggerLabels") or [],
            "volumeRatio": diagnostics.get("volumeRatio"),
        },
        "risk": {
            "rrAfterCost": candidate.get("rrAfterCost", diagnostics.get("rrAfterCost")),
            "stopLoss": candidate.get("stopLoss"),
            "takeProfit": candidate.get("conservativeTakeProfit"),
            "firstBarrier": candidate.get("firstOpposingBarrier"),
            "layers": candidate.get("layers", diagnostics.get("layers") or []),
        },
        "candidateSignature": candidate.get("signature"),
        "watchState": packet.get("watchState"),
        "watchPlan": packet.get("watchPlan"),
        "codexWake": status in {"FOLLOW_REQUIRED", "REMAP_REQUIRED", "MAP_REVIEW_REQUIRED"},
        "llmCalled": False,
        "quotaUsed": False,
    }


def append_audit(packet: dict[str, Any]) -> dict[str, Any]:
    record = audit_record(packet)
    path = audit_path(parse_time(record["at"]))
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return record


def acquire_lock() -> object | None:
    import atexit

    RUNTIME.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_RDWR)
    try:
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None

    def release() -> None:
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

    atexit.register(release)
    os.write(fd, str(os.getpid()).encode("ascii"))
    return fd


def get_json(path: str) -> dict[str, Any]:
    request = urllib.request.Request(BRIDGE + path, method="GET")
    with urllib.request.urlopen(request, timeout=25) as response:
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Bridge returned non-object for {path}")
    return value


def post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    del path, payload
    raise RuntimeError("signal-only invariant: prefilter cannot POST to MT5 bridge")


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def send_telegram(text: str) -> bool:
    env = load_env(ENV_PATH)
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        log("auto execution verified but Telegram config is missing")
        return False
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=data, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=20):
            return True
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        log(f"auto execution Telegram failed: {str(error)[:180]}")
        return False


def in_active_window(current: datetime) -> bool:
    minute = current.hour * 60 + current.minute
    return ACTIVE_START_MINUTE <= minute < ACTIVE_END_MINUTE


def parse_news_event_time(event: dict[str, Any], current: datetime) -> datetime | None:
    for key in ("time_vn", "datetime_vn", "starts_at", "time"):
        raw = event.get(key)
        if not raw:
            continue
        text = str(raw)
        try:
            if "T" in text or "+" in text or text.endswith("Z"):
                return parse_time(text).astimezone(VN)
            hour, minute = (int(part) for part in text.split(":", 1))
            return current.replace(hour=hour, minute=minute, second=0, microsecond=0)
        except (TypeError, ValueError):
            continue
    return None


def news_gate(current: datetime, news: dict[str, Any]) -> tuple[bool, str]:
    if news.get("date_vn") != current.date().isoformat():
        return False, "news cache missing or stale"
    for event in news.get("events") or []:
        if not isinstance(event, dict):
            continue
        impact = str(event.get("impact") or event.get("importance") or "HIGH").upper()
        if impact not in {"HIGH", "HIGH IMPACT", "RED"}:
            continue
        event_at = parse_news_event_time(event, current)
        if event_at and abs((current - event_at).total_seconds()) <= 30 * 60:
            return False, f"USD high-impact blackout around {event_at:%H:%M} VN"
    return True, "same-day news cache clear"


def candle_from(raw: dict[str, Any]) -> Candle:
    return Candle(
        time=parse_time(raw["time"]),
        open=float(raw["open"]),
        high=float(raw["high"]),
        low=float(raw["low"]),
        close=float(raw["close"]),
        volume=float(raw.get("volume") or 0),
        spread=float(raw.get("spread") or 0),
    )


def closed_candles(snapshot: dict[str, Any], timeframe: str, current: datetime) -> list[Candle]:
    duration = TIMEFRAME_SECONDS[timeframe]
    current_utc = current.astimezone(timezone.utc)
    rows: list[Candle] = []
    for raw in (snapshot.get("candles") or {}).get(timeframe) or []:
        candle = candle_from(raw)
        if candle.time.astimezone(timezone.utc) + timedelta(seconds=duration) <= current_utc:
            rows.append(candle)
    return sorted(rows, key=lambda item: item.time)


def ema(values: Iterable[float], period: int) -> list[float]:
    rows = list(values)
    if not rows:
        return []
    alpha = 2.0 / (period + 1.0)
    output = [rows[0]]
    for value in rows[1:]:
        output.append(alpha * value + (1.0 - alpha) * output[-1])
    return output


def atr(candles: list[Candle], period: int = 14) -> float:
    if len(candles) < 2:
        return 0.0
    true_ranges: list[float] = []
    for previous, current in zip(candles, candles[1:]):
        true_ranges.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )
    return statistics.fmean(true_ranges[-period:]) if true_ranges else 0.0


def session_vwap(candles: list[Candle], current: datetime) -> float:
    day = current.astimezone(VN).date()
    selected = [item for item in candles if item.time.astimezone(VN).date() == day]
    if not selected:
        selected = candles[-30:]
    total_volume = sum(max(item.volume, 1.0) for item in selected)
    return sum(
        ((item.high + item.low + item.close) / 3.0) * max(item.volume, 1.0)
        for item in selected
    ) / max(total_volume, 1.0)


def slope(values: list[float], lookback: int = 5) -> float:
    if len(values) < lookback + 1:
        return 0.0
    return (values[-1] - values[-1 - lookback]) / lookback


def pivots(candles: list[Candle], side: str, wing: int = 2) -> list[float]:
    output: list[float] = []
    for index in range(wing, len(candles) - wing):
        sample = candles[index - wing : index + wing + 1]
        value = candles[index].high if side == "high" else candles[index].low
        values = [row.high if side == "high" else row.low for row in sample]
        if (side == "high" and value == max(values)) or (side == "low" and value == min(values)):
            output.append(value)
    return output


def classify_regime(m15: list[Candle], h1: list[Candle], atr_m15: float) -> tuple[str, str | None]:
    if len(m15) < 55 or len(h1) < 55 or atr_m15 <= 0:
        return "UNAVAILABLE", None
    m15_close = [row.close for row in m15]
    h1_close = [row.close for row in h1]
    m20, m50 = ema(m15_close, 20), ema(m15_close, 50)
    h20, h50 = ema(h1_close, 20), ema(h1_close, 50)
    m_up = m20[-1] > m50[-1] and slope(m20) > 0
    m_down = m20[-1] < m50[-1] and slope(m20) < 0
    h_up = h20[-1] > h50[-1] and slope(h20, 3) > 0
    h_down = h20[-1] < h50[-1] and slope(h20, 3) < 0
    if m_up and h_up:
        return "TREND", "BUY"
    if m_down and h_down:
        return "TREND", "SELL"

    prior = m15[-13:-1]
    upper = max(row.high for row in prior)
    lower = min(row.low for row in prior)
    last = m15[-1]
    if last.close > upper + 0.10 * atr_m15:
        return "TRANSITION", "BUY"
    if last.close < lower - 0.10 * atr_m15:
        return "TRANSITION", "SELL"
    return "RANGE", None


def trigger_direction(last: Candle, previous: Candle, atr_m5: float) -> tuple[str | None, list[str]]:
    if last.range <= 0 or atr_m5 <= 0:
        return None, []
    lower_wick = min(last.open, last.close) - last.low
    upper_wick = last.high - max(last.open, last.close)
    close_location = (last.close - last.low) / last.range
    bullish_engulf = last.close > last.open and last.close >= previous.open and last.open <= previous.close
    bearish_engulf = last.close < last.open and last.close <= previous.open and last.open >= previous.close
    bullish_rejection = lower_wick >= max(last.body * 1.35, 0.12 * atr_m5) and close_location >= 0.62
    bearish_rejection = upper_wick >= max(last.body * 1.35, 0.12 * atr_m5) and close_location <= 0.38
    bullish_displacement = last.close > last.open and last.body >= 0.62 * atr_m5
    bearish_displacement = last.close < last.open and last.body >= 0.62 * atr_m5
    body_ratio = last.body / max(last.range, 1e-9)
    bullish_directional_close = (
        last.close > last.open
        and last.body >= DIRECTIONAL_CLOSE_MIN_BODY_ATR * atr_m5
        and body_ratio >= DIRECTIONAL_CLOSE_MIN_BODY_RATIO
        and close_location >= DIRECTIONAL_CLOSE_EDGE
    )
    bearish_directional_close = (
        last.close < last.open
        and last.body >= DIRECTIONAL_CLOSE_MIN_BODY_ATR * atr_m5
        and body_ratio >= DIRECTIONAL_CLOSE_MIN_BODY_RATIO
        and close_location <= 1.0 - DIRECTIONAL_CLOSE_EDGE
    )
    if bullish_engulf or bullish_rejection or bullish_displacement or bullish_directional_close:
        labels = []
        if bullish_engulf:
            labels.append("bullish engulfing")
        if bullish_rejection:
            labels.append("bullish rejection")
        if bullish_displacement:
            labels.append("bullish displacement")
        if bullish_directional_close and not labels:
            labels.append("bullish directional close")
        return "BUY", labels
    if bearish_engulf or bearish_rejection or bearish_displacement or bearish_directional_close:
        labels = []
        if bearish_engulf:
            labels.append("bearish engulfing")
        if bearish_rejection:
            labels.append("bearish rejection")
        if bearish_displacement:
            labels.append("bearish displacement")
        if bearish_directional_close and not labels:
            labels.append("bearish directional close")
        return "SELL", labels
    return None, []


def nearest_barrier(direction: str, entry: float, candles: list[Candle], atr_m5: float) -> float | None:
    if direction == "BUY":
        candidates = [value for value in pivots(candles[-80:], "high") if value > entry + 0.45 * atr_m5]
        return min(candidates) if candidates else None
    candidates = [value for value in pivots(candles[-80:], "low") if value < entry - 0.45 * atr_m5]
    return max(candidates) if candidates else None


def watch_plans(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Return only the single highest-priority ACTIVE plan."""
    rows = document.get("plans")
    if isinstance(rows, list):
        active = [
            row for row in rows
            if isinstance(row, dict) and str(row.get("status") or "ACTIVE").upper() == "ACTIVE"
        ]
        def priority(row: dict[str, Any]) -> float:
            try:
                return float(row.get("priority", 999999))
            except (TypeError, ValueError):
                return 999999

        active.sort(key=priority)
        return active[:1]
    if document.get("planId"):
        return [document] if str(document.get("status") or "ACTIVE").upper() == "ACTIVE" else []
    return []


def plan_value(plan: dict[str, Any], section: str, key: str, flat_key: str, default: Any = None) -> Any:
    nested = plan.get(section)
    if isinstance(nested, dict) and key in nested:
        return nested[key]
    return plan.get(flat_key, default)


def normalized_trigger_mode(plan: dict[str, Any]) -> str:
    raw = str(plan_value(plan, "trigger", "mode", "triggerMode", "")).upper().strip()
    aliases = {
        "BULLISH_REJECTION": "REJECTION",
        "BEARISH_REJECTION": "REJECTION",
        "REJECTION_RETEST": "REJECTION",
        "BULLISH_REJECTION_RETEST": "REJECTION",
        "BEARISH_REJECTION_RETEST": "REJECTION",
        "BULLISH_RETEST_HOLD": "RETEST_HOLD",
        "BEARISH_RETEST_HOLD": "RETEST_HOLD",
    }
    return aliases.get(raw, raw)


def normalized_entry_policy(plan: dict[str, Any]) -> str:
    trigger = plan.get("trigger") if isinstance(plan.get("trigger"), dict) else {}
    regime = str(plan.get("regime") or "").upper()
    mode = normalized_trigger_mode(plan)
    # Default to fast timing only for explicitly directional trend plans.
    # Explicit M5_REQUIRED remains authoritative; transition needs opt-in.
    trend_timing = regime.startswith("TREND") and any(
        tag in regime for tag in ("BULLISH", "BEARISH")
    ) and "COUNTER" not in regime
    default_policy = "EARLY_ALLOWED" if trend_timing else "M5_REQUIRED"
    raw = str(trigger.get("entryPolicy") or plan.get("entryPolicy") or default_policy).upper().strip()
    # Breakout M1 timing still requires a prior closed M5 breakout below.
    early_regime = "TREND" in regime or "TRANSITION" in regime
    if raw == "EARLY_ALLOWED" and early_regime and mode in {
        "REJECTION", "RETEST_HOLD", "BREAKOUT_RETEST",
    }:
        return "EARLY_ALLOWED"
    return "M5_REQUIRED"


def validate_watch_plan(plan: dict[str, Any], current: datetime) -> list[str]:
    errors: list[str] = []
    plan_id = str(plan.get("planId") or "").strip()
    direction = str(plan.get("direction") or "").upper()
    mode = normalized_trigger_mode(plan)
    if not plan_id:
        errors.append("missing planId")
    if str(plan.get("symbol") or SYMBOL) != SYMBOL:
        errors.append("symbol must be XAUUSDm")
    if direction not in {"BUY", "SELL"}:
        errors.append("direction must be BUY or SELL")
    if mode not in SUPPORTED_TRIGGER_MODES:
        errors.append("unsupported trigger mode")
    try:
        expires = parse_time(plan.get("expiresAt")).astimezone(VN)
        if expires <= current:
            errors.append("plan expired")
    except (TypeError, ValueError):
        errors.append("invalid expiresAt")
    try:
        zone_low = float(plan_value(plan, "zone", "low", "zoneLow"))
        zone_high = float(plan_value(plan, "zone", "high", "zoneHigh"))
        if zone_low >= zone_high:
            errors.append("zone.low must be below zone.high")
    except (TypeError, ValueError):
        errors.append("invalid zone")
    for section, key, flat_key in (
        ("risk", "invalidationPrice", "invalidationPrice"),
        ("risk", "firstBarrier", "firstBarrier"),
    ):
        try:
            if float(plan_value(plan, section, key, flat_key)) <= 0:
                errors.append(f"invalid {flat_key}")
        except (TypeError, ValueError):
            errors.append(f"invalid {flat_key}")
    return errors


def watch_plan_summary(plan: dict[str, Any]) -> dict[str, Any]:
    mode = normalized_trigger_mode(plan)
    confirmation_timeframe = str(
        plan_value(plan, "trigger", "confirmationTimeframe", "confirmationTimeframe", "M5")
    ).upper()
    return {
        "planId": plan.get("planId"),
        "expiresAt": plan.get("expiresAt"),
        "regime": plan.get("regime"),
        "direction": str(plan.get("direction") or "").upper(),
        "zoneLow": plan_value(plan, "zone", "low", "zoneLow"),
        "zoneHigh": plan_value(plan, "zone", "high", "zoneHigh"),
        "triggerMode": mode,
        "entryPolicy": normalized_entry_policy(plan),
        "confirmationTimeframe": confirmation_timeframe,
        "minVolumeRatio": plan_value(plan, "trigger", "minVolumeRatio", "minVolumeRatio", 0.8),
        "invalidationPrice": plan_value(plan, "risk", "invalidationPrice", "invalidationPrice"),
        "firstBarrier": plan_value(plan, "risk", "firstBarrier", "firstBarrier"),
        "conservativeTakeProfit": plan_value(
            plan, "risk", "conservativeTakeProfit", "conservativeTakeProfit"
        ),
        "minimumSlBuffer": plan_value(plan, "risk", "minimumSlBuffer", "minimumSlBuffer", 0.0),
        "minRrAfterCost": plan_value(plan, "risk", "minRrAfterCost", "minRrAfterCost", MIN_RR),
        "thesis": plan.get("thesis"),
    }


def zone_alert_message(packet: dict[str, Any], current: datetime) -> str:
    """Build a clearly conditional Telegram alert for a mapped daily zone."""
    plan = packet.get("watchPlan") or {}
    proximity = packet.get("proximity") or {}
    kind = str(proximity.get("kind") or "SETUP_ARMED")
    direction = str(proximity.get("direction") or plan.get("direction") or "UNKNOWN")
    label = "ENTRY WINDOW OPEN" if kind == "ENTRY_WINDOW_OPEN" else "SETUP ARMED"
    def price(value: Any) -> str:
        try:
            return f"{float(value):.3f}"
        except (TypeError, ValueError):
            return "chưa xác định"

    invalidation = plan.get("invalidationPrice")
    try:
        buffer = float(plan.get("minimumSlBuffer") or 0.0)
        projected_sl = float(invalidation) - buffer if direction == "BUY" else float(invalidation) + buffer
    except (TypeError, ValueError):
        projected_sl = None
    return "\n".join([
        "WATCH PLAN XAUUSDm",
        "",
        f"LOẠI: {label}",
        f"Thời gian: {current.astimezone(VN).strftime('%H:%M:%S VN - %d/%m/%Y')}",
        f"Hướng theo dõi: {direction}",
        f"Vùng giá: {price(proximity.get('zoneLow'))} - {price(proximity.get('zoneHigh'))}",
        f"Giá hiện tại: {price(proximity.get('price'))}",
        f"Trigger cần chờ: M5 {plan.get('triggerMode') or 'UNKNOWN'} đóng",
        f"Volume tối thiểu: {float(plan.get('minVolumeRatio') or 0.8):.2f}x",
        f"Mức vô hiệu: {price(plan.get('invalidationPrice'))}",
        f"SL cấu trúc dự kiến: {price(projected_sl)}",
        f"Cản đầu tiên: {price(plan.get('firstBarrier'))}",
        f"TP bảo thủ tham chiếu: {price(plan.get('conservativeTakeProfit'))}",
        f"RR tối thiểu sau chi phí: {float(plan.get('minRrAfterCost') or MIN_RR):.2f}",
        f"Plan hết hạn: {plan.get('expiresAt')}",
        "",
        "KHÔNG ĐẶT LỆNH TỪ TIN NHẮN NÀY.",
        f"CHƯA PHẢI LỆNH {direction} MARKET/LIMIT.",
        "Script đang quét mỗi phút; khi đủ rule sẽ tự gửi TÍN HIỆU XAUUSDm ngay.",
        "Chỉ tin nhắn bắt đầu bằng TÍN HIỆU XAUUSDm mới là tín hiệu để bạn tự đặt lệnh.",
        "SL chính thức sẽ được tính lại theo spread và ATR tại nến trigger.",
    ])


def send_zone_telegram(packet: dict[str, Any], current: datetime) -> dict[str, Any]:
    """Send one deduplicated local alert without blocking market monitoring on failure."""
    if str(packet.get("status") or "").upper() != "ZONE_APPROACH":
        return packet
    proximity = packet.get("proximity") or {}
    raw_signature = str(proximity.get("signature") or "").strip()
    if not raw_signature:
        packet["zoneTelegram"] = {"status": "SKIPPED", "reason": "missing proximity signature"}
        return packet
    command = [
        sys.executable,
        str(ROOT / "scripts" / "send-codex-xau-signal.py"),
        "--signature", f"ZONE|{raw_signature}",
        "--message", zone_alert_message(packet, current),
    ]
    try:
        completed = subprocess.run(
            command, cwd=str(ROOT), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=25, check=False,
        )
        detail = (completed.stdout or completed.stderr).strip()[-1000:]
        packet["zoneTelegram"] = {
            "status": "VERIFIED" if completed.returncode == 0 else "FAILED",
            "signature": f"ZONE|{raw_signature}",
            "detail": detail,
        }
    except Exception as error:  # Alert failure must never stop the one-minute watcher.
        packet["zoneTelegram"] = {
            "status": "UNCERTAIN", "signature": f"ZONE|{raw_signature}",
            "detail": str(error)[:500],
        }
    return packet


def candidate_signal_message(packet: dict[str, Any], current: datetime) -> str:
    """Build the final manual signal from a locally validated candidate."""
    candidate = packet.get("candidate") or {}
    direction = str(candidate.get("direction") or "UNKNOWN").upper()
    order_type = str(candidate.get("orderTypeHint") or "MARKET").upper()
    tier = str(candidate.get("signalTier") or "CONFIRMED_M5").upper()
    title = (
        "TÍN HIỆU XAUUSDm - EARLY/HIGHER RISK"
        if tier == "EARLY" else "TÍN HIỆU XAUUSDm - CONFIRMED"
    )

    def price(value: Any) -> str:
        try:
            return f"{float(value):.3f}"
        except (TypeError, ValueError):
            return "chưa xác định"

    layers = candidate.get("qualityLayers") or []
    passed = candidate.get("qualityLayersPassed")
    if passed is None:
        passed = sum(1 for layer in layers if isinstance(layer, dict) and layer.get("passed"))
    expiry = candidate.get("limitExpiresAt") if order_type == "LIMIT" else packet.get("expiresAt")
    trigger = candidate.get("triggerCandle") or {}
    labels = ", ".join(str(value) for value in (candidate.get("triggerLabels") or []))
    return "\n".join([
        title,
        "",
        f"Thời gian phát: {current.astimezone(VN).strftime('%H:%M:%S VN - %d/%m/%Y')}",
        f"Lệnh: {direction} {order_type}",
        f"Entry: {price(candidate.get('entry'))}",
        f"SL CHÍNH THỨC: {price(candidate.get('stopLoss'))}",
        f"TP: {price(candidate.get('conservativeTakeProfit'))}",
        f"RR sau chi phí: {float(candidate.get('rrAfterCost') or 0.0):.2f}",
        f"Grade: {candidate.get('qualityGrade') or 'UNKNOWN'} | Layers: {passed}/5",
        f"Trigger: {trigger.get('timeframe') or candidate.get('confirmationTimeframe') or 'UNKNOWN'} {labels or candidate.get('triggerMode') or 'UNKNOWN'}",
        f"Plan ID: {candidate.get('planId') or 'UNKNOWN'}",
        f"Tín hiệu hết hạn: {expiry}",
        "",
        "Bạn tự đặt lệnh. Script không ghi lệnh vào MT5.",
        "Không đặt nếu đã qua thời gian hết hạn hoặc giá MARKET/LIMIT không còn đúng như tin nhắn.",
    ])


def send_candidate_telegram(packet: dict[str, Any], current: datetime) -> dict[str, Any]:
    """Send one final signal directly; no Codex review or MT5 write is involved."""
    if str(packet.get("status") or "").upper() != "CANDIDATE":
        return packet
    candidate = packet.get("candidate") or {}
    raw_signature = str(candidate.get("signature") or "").strip()
    if not raw_signature:
        packet["directSignal"] = {"status": "SKIPPED", "reason": "missing candidate signature"}
        return packet
    signature = f"SIGNAL|{raw_signature}"
    command = [
        sys.executable,
        str(ROOT / "scripts" / "send-codex-xau-signal.py"),
        "--signature", signature,
        "--message", candidate_signal_message(packet, current),
    ]
    try:
        completed = subprocess.run(
            command, cwd=str(ROOT), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=25, check=False,
        )
        detail = (completed.stdout or completed.stderr).strip()[-1000:]
        packet["directSignal"] = {
            "status": "VERIFIED" if completed.returncode == 0 else "FAILED",
            "signature": signature,
            "detail": detail,
        }
    except Exception as error:
        packet["directSignal"] = {
            "status": "UNCERTAIN", "signature": signature,
            "detail": str(error)[:500],
        }
    packet["codexReviewRequired"] = False
    return packet


def distance_to_zone(price: float, low: float, high: float) -> float:
    if low <= price <= high:
        return 0.0
    return min(abs(price - low), abs(price - high))


def watch_trigger_matches(
    plan: dict[str, Any],
    m5: list[Candle],
    atr_m5: float,
    breakout_seen: bool = False,
    breakout_closed_at: datetime | None = None,
) -> tuple[bool, list[str]]:
    latest, previous = m5[-1], m5[-2]
    direction = str(plan.get("direction") or "").upper()
    mode = normalized_trigger_mode(plan)
    zone_low = float(plan_value(plan, "zone", "low", "zoneLow"))
    zone_high = float(plan_value(plan, "zone", "high", "zoneHigh"))
    trigger, labels = trigger_direction(latest, previous, atr_m5)
    latest_touched = latest.high >= zone_low and latest.low <= zone_high
    previous_touched = previous.high >= zone_low and previous.low <= zone_high
    # The most common confirmation sequence is a zone-touch candle followed by
    # a directional close. Requiring the confirmation candle itself to touch
    # the zone discarded these otherwise valid mapped setups.
    touched = latest_touched or previous_touched
    midpoint = (zone_low + zone_high) / 2.0
    favorable_close = latest.close >= midpoint if direction == "BUY" else latest.close <= midpoint

    if mode == "REJECTION":
        return touched and favorable_close and trigger == direction, labels
    if mode == "RETEST_HOLD":
        held = latest.close > zone_high if direction == "BUY" else latest.close < zone_low
        return touched and held and trigger == direction, labels
    if mode == "BREAKOUT_RETEST":
        prior_breakout = breakout_seen or any(
            row.close > zone_high if direction == "BUY" else row.close < zone_low
            for row in m5[-4:-1]
        )
        held = latest.close > zone_high if direction == "BUY" else latest.close < zone_low
        retest_touch = latest_touched
        if previous_touched and breakout_closed_at is not None:
            retest_touch = retest_touch or previous.time > breakout_closed_at
        return prior_breakout and retest_touch and held and trigger == direction, labels
    if mode == "CLOSE_THROUGH":
        crossed = latest.close > zone_high if direction == "BUY" else latest.close < zone_low
        return crossed and trigger == direction, labels
    return False, labels


def fast_m1_trigger_matches(
    plan: dict[str, Any],
    m1: list[Candle],
    atr_m1: float,
    breakout_after: datetime | None = None,
) -> tuple[bool, list[str], float]:
    """Confirm a mapped zone with closed M1 bars; M1 never establishes structure."""
    latest, previous = m1[-1], m1[-2]
    direction = str(plan.get("direction") or "").upper()
    mode = normalized_trigger_mode(plan)
    zone_low = float(plan_value(plan, "zone", "low", "zoneLow"))
    zone_high = float(plan_value(plan, "zone", "high", "zoneHigh"))
    if breakout_after and latest.time.astimezone(timezone.utc) < breakout_after.astimezone(timezone.utc):
        return False, ["M1 predates closed-M5 breakout"], 0.0

    latest_touched = latest.high >= zone_low and latest.low <= zone_high
    previous_touched = previous.high >= zone_low and previous.low <= zone_high
    midpoint = (zone_low + zone_high) / 2.0
    if mode == "REJECTION":
        latest_held = latest.close >= midpoint if direction == "BUY" else latest.close <= midpoint
        previous_held = previous.close >= midpoint if direction == "BUY" else previous.close <= midpoint
    else:
        latest_held = latest.close > zone_high if direction == "BUY" else latest.close < zone_low
        previous_held = previous.close > zone_high if direction == "BUY" else previous.close < zone_low

    close_location = (latest.close - latest.low) / max(latest.range, 1e-9)
    close_at_edge = close_location >= 0.70 if direction == "BUY" else close_location <= 0.30
    body_ratio = latest.body / max(latest.range, 1e-9)
    latest_direction, latest_labels = trigger_direction(latest, previous, atr_m1)
    prior_direction, prior_labels = trigger_direction(previous, m1[-3], atr_m1)
    volume_median = statistics.median([row.volume for row in m1[-21:-1]] or [1.0])
    volume_ratio = latest.volume / max(volume_median, 1.0)

    rejection_label = "bullish rejection" if direction == "BUY" else "bearish rejection"
    one_bar_rejection = (
        mode == "REJECTION" and latest_touched and latest_held and close_at_edge
        and latest_direction == direction and rejection_label in latest_labels and volume_ratio >= 1.0
    )
    one_bar = (
        latest_touched and latest_held and close_at_edge
        and latest_direction == direction and body_ratio >= 0.45 and volume_ratio >= 1.0
    )
    strong_one_bar = one_bar and body_ratio >= 0.55 and volume_ratio >= 1.20
    favorable_progress = latest.close >= previous.close if direction == "BUY" else latest.close <= previous.close
    two_bar_hold = (
        (latest_touched or previous_touched) and latest_held and previous_held and close_at_edge
        and favorable_progress and (latest_direction == direction or prior_direction == direction)
        and (latest.body + previous.body) / max(latest.range + previous.range, 1e-9) >= 0.35
    )
    matched = strong_one_bar or one_bar_rejection or one_bar or two_bar_hold
    labels = [f"closed M1 {label}" for label in latest_labels]
    if strong_one_bar:
        labels.append("strong one-bar M1 confirmation")
    elif one_bar_rejection:
        labels.append("wick-dominant M1 rejection with normal volume")
    elif one_bar:
        labels.append("M1 confirmation with normal volume")
    elif two_bar_hold:
        labels.extend(f"prior M1 {label}" for label in prior_labels)
        labels.append("two consecutive M1 holds")
    return matched, labels, volume_ratio


def evaluate_watch_plans(
    snapshot: dict[str, Any],
    current: datetime,
    document: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    """Monitor daily zones; M1 may time approved trend pullbacks, never structure."""
    m1 = closed_candles(snapshot, "M1", current)
    m5 = closed_candles(snapshot, "M5", current)
    m15 = closed_candles(snapshot, "M15", current)
    if len(m5) < 30:
        return {"status": "NO_SIGNAL", "watchState": "NO_DATA", "reason": "insufficient closed M5 history for daily watch plans"}

    bid = float(snapshot.get("bid") or snapshot.get("price") or 0)
    ask = float(snapshot.get("ask") or 0)
    spread = float(snapshot.get("spread") or max(0.0, ask - bid))
    quote_at = parse_time(snapshot.get("time"))
    quote_age = (current.astimezone(timezone.utc) - quote_at.astimezone(timezone.utc)).total_seconds()
    atr5 = atr(m5)
    atr1 = atr(m1) if len(m1) >= 20 else 0.0
    if bid <= 0 or ask <= bid or quote_age > 180 or atr5 <= 0:
        return {"status": "NO_SIGNAL", "watchState": "NO_DATA", "reason": "stale/invalid quote or ATR for watch plans"}

    state.setdefault("version", 1)
    state.setdefault("plans", {})
    latest = m5[-1]
    latest_key = iso(latest.time.astimezone(VN))
    latest_m15 = m15[-1] if m15 else None
    latest_m15_key = iso(latest_m15.time.astimezone(VN)) if latest_m15 else None
    base_diagnostics = {
        "latestClosedM5": latest_key,
        "latestClosedM15": latest_m15_key,
        "bid": round(bid, 3),
        "ask": round(ask, 3),
        "spread": round(spread, 3),
        "quoteAgeSeconds": round(quote_age, 1),
        "atrM5": round(atr5, 3),
    }
    candidates: list[tuple[int, dict[str, Any]]] = []
    proximity_events: list[tuple[int, dict[str, Any]]] = []
    observations: list[tuple[int, dict[str, Any]]] = []

    for plan in watch_plans(document):
        priority = int(plan.get("priority") or 0)
        summary = watch_plan_summary(plan)
        plan_id = str(plan.get("planId") or "")
        record = state["plans"].setdefault(plan_id or "invalid", {})
        errors = validate_watch_plan(plan, current)
        if errors:
            watch_state = "EXPIRED" if errors == ["plan expired"] else "INVALID_PLAN"
            record.update({"status": watch_state, "updatedAt": iso(current), "errors": errors})
            observations.append((priority, {"status": "NO_SIGNAL", "watchState": watch_state, "reason": "; ".join(errors), "watchPlan": summary}))
            continue

        direction = str(plan.get("direction") or "").upper()
        mode = normalized_trigger_mode(plan)
        entry_policy = normalized_entry_policy(plan)
        confirmation_timeframe = "M5"
        zone_low = float(plan_value(plan, "zone", "low", "zoneLow"))
        zone_high = float(plan_value(plan, "zone", "high", "zoneHigh"))
        invalidation = float(plan_value(plan, "risk", "invalidationPrice", "invalidationPrice"))
        latched_invalidation = str(record.get("invalidatedByClosedM5") or "")
        if latched_invalidation:
            first_invalidation = not bool(record.get("remapWakeClosedM5"))
            record.update({"status": "INVALIDATED", "updatedAt": iso(current)})
            if first_invalidation:
                record["remapWakeClosedM5"] = latched_invalidation
                candidates.append((priority, {
                    "status": "REMAP_REQUIRED",
                    "watchState": "INVALIDATED",
                    "reason": f"plan {plan_id} remains invalidated; Codex must remap structure",
                    "watchPlan": summary,
                    "remap": {
                        "signature": f"{plan_id}|INVALIDATED|{latched_invalidation}",
                        "planId": plan_id,
                        "invalidatedByClosedM5": latched_invalidation,
                    },
                    "diagnostics": {**base_diagnostics, "latestClosedM5": latched_invalidation},
                }))
            else:
                observations.append((priority, {
                    "status": "NO_SIGNAL", "watchState": "INVALIDATED",
                    "reason": f"plan {plan_id} remains invalidated; remap wake already emitted",
                    "watchPlan": summary,
                }))
            continue
        breakout_seen_before = bool(record.get("breakoutSeen"))
        breakout_now = latest.close > zone_high if direction == "BUY" else latest.close < zone_low
        if mode == "BREAKOUT_RETEST" and breakout_now and not record.get("breakoutSeen"):
            record["breakoutSeen"] = True
            record["breakoutClosedM5"] = latest_key
        invalidation_active = mode != "BREAKOUT_RETEST" or bool(record.get("breakoutSeen"))
        invalidated = invalidation_active and (
            latest.close < invalidation if direction == "BUY" else latest.close > invalidation
        )
        if invalidated:
            invalidated_key = str(record.get("invalidatedByClosedM5") or latest_key)
            first_invalidation = not bool(record.get("remapWakeClosedM5"))
            record.update({"status": "INVALIDATED", "updatedAt": iso(current), "invalidatedByClosedM5": invalidated_key})
            if first_invalidation:
                record["remapWakeClosedM5"] = invalidated_key
                candidates.append((priority, {
                    "status": "REMAP_REQUIRED",
                    "watchState": "INVALIDATED",
                    "reason": f"closed M5 invalidated plan {plan_id}; Codex must remap structure",
                    "watchPlan": summary,
                    "remap": {
                        "signature": f"{plan_id}|INVALIDATED|{invalidated_key}",
                        "planId": plan_id,
                        "invalidatedByClosedM5": invalidated_key,
                    },
                    "diagnostics": {**base_diagnostics, "latestClosedM5": invalidated_key},
                }))
            else:
                observations.append((priority, {
                    "status": "NO_SIGNAL", "watchState": "INVALIDATED",
                    "reason": f"closed M5 invalidated plan {plan_id}; remap wake already emitted",
                    "watchPlan": summary,
                }))
            continue

        # A one-plan workflow should not keep watching a stale pullback zone
        # until the next H1 review after price has repriced materially. Only a
        # closed M15 can wake Codex, and each displacement cycle is latched so
        # the one-minute scanner cannot spend quota repeatedly.
        first_barrier = float(plan_value(plan, "risk", "firstBarrier", "firstBarrier"))
        plan_generated_at = parse_time(plan.get("generatedAt")).astimezone(VN)
        # Ignore a candle that was already forming when Codex created the
        # plan: its displacement was visible in the fresh quote used for that
        # review. Require one completely new M15 candle to avoid an immediate
        # remap loop after every new plan.
        full_m15_after_plan = bool(
            latest_m15 is not None
            and latest_m15.time.astimezone(VN) >= plan_generated_at
        )
        if latest_m15 is not None and latest_m15_key is not None and full_m15_after_plan:
            favorable_distance = (
                latest_m15.close - zone_high if direction == "BUY"
                else zone_low - latest_m15.close
            )
            displacement_atr = favorable_distance / max(atr5, 1e-9)
            first_barrier_broken = (
                latest_m15.close > first_barrier if direction == "BUY"
                else latest_m15.close < first_barrier
            )
            if displacement_atr <= FAVORABLE_DISPLACEMENT_RESET_ATR and not first_barrier_broken:
                record.pop("favorableDisplacementWakeClosedM15", None)
            already_checked_m15 = record.get("lastDisplacementCheckedClosedM15") == latest_m15_key
            record["lastDisplacementCheckedClosedM15"] = latest_m15_key
            displacement_latched = bool(record.get("favorableDisplacementWakeClosedM15"))
            if (
                not already_checked_m15
                and not displacement_latched
                and (displacement_atr >= FAVORABLE_DISPLACEMENT_ATR or first_barrier_broken)
            ):
                record.update({
                    "status": "FAVORABLE_DISPLACEMENT",
                    "updatedAt": iso(current),
                    "favorableDisplacementWakeClosedM15": latest_m15_key,
                })
                candidates.append((priority, {
                    "status": "REMAP_REQUIRED",
                    "watchState": "FAVORABLE_DISPLACEMENT",
                    "reason": (
                        f"closed M15 moved {max(displacement_atr, 0.0):.2f} ATR beyond plan {plan_id} zone"
                        f"{' and broke first barrier' if first_barrier_broken else ''}; Codex must refresh the single active plan"
                    ),
                    "watchPlan": summary,
                    "remap": {
                        "signature": f"{plan_id}|FAVORABLE_DISPLACEMENT|{latest_m15_key}",
                        "kind": "FAVORABLE_DISPLACEMENT",
                        "planId": plan_id,
                        "closedM15OpenTime": latest_m15_key,
                        "closedM15Close": round(latest_m15.close, 3),
                        "distanceAtrM5": round(displacement_atr, 2),
                        "firstBarrierBroken": first_barrier_broken,
                    },
                    "diagnostics": {
                        **base_diagnostics,
                        "closedM15Close": round(latest_m15.close, 3),
                        "distanceAtrM5": round(displacement_atr, 2),
                        "firstBarrier": round(first_barrier, 3),
                    },
                }))
                continue

        executable = ask if direction == "BUY" else bid
        proximity_atr = float(plan_value(plan, "zone", "proximityAtr", "proximityAtr", DEFAULT_PROXIMITY_ATR))
        price_in_zone = zone_low <= executable <= zone_high
        near_zone = distance_to_zone(executable, zone_low, zone_high) <= max(0.0, proximity_atr) * atr5
        touched = any(row.high >= zone_low and row.low <= zone_high for row in m5[-2:])
        trigger_candle = latest
        trigger_key = latest_key
        matched = False
        trigger_labels: list[str] = []
        volume_average = statistics.fmean([row.volume for row in m5[-20:]])
        volume_ratio = latest.volume / max(volume_average, 1.0)
        breakout_after = None
        if mode == "BREAKOUT_RETEST" and record.get("breakoutClosedM5"):
            try:
                breakout_after = parse_time(record["breakoutClosedM5"]) + timedelta(minutes=5)
            except (TypeError, ValueError):
                pass
        breakout_ready = mode != "BREAKOUT_RETEST" or breakout_after is not None
        early_eligible = (
            entry_policy == "EARLY_ALLOWED"
            and breakout_ready
            and (price_in_zone or near_zone)
            and len(m1) >= 30
            and atr1 > 0
        )
        if early_eligible:
            latest_m1 = m1[-1]
            latest_m1_key = iso(latest_m1.time.astimezone(VN))
            if record.get("lastEvaluatedClosedM1") != latest_m1_key:
                record["lastEvaluatedClosedM1"] = latest_m1_key
                early_matched, early_labels, early_volume_ratio = fast_m1_trigger_matches(
                    plan, m1, atr1, breakout_after=breakout_after,
                )
                if early_matched:
                    confirmation_timeframe = "M1"
                    trigger_candle = latest_m1
                    trigger_key = latest_m1_key
                    touched = any(row.high >= zone_low and row.low <= zone_high for row in m1[-2:])
                    matched = True
                    trigger_labels = early_labels
                    volume_ratio = early_volume_ratio
        watch_state = "ARMED" if near_zone or touched else "WATCHING"
        reason = f"plan {plan_id} {'armed near' if watch_state == 'ARMED' else 'waiting for'} zone {zone_low:.3f}-{zone_high:.3f}"

        record.update({
            "status": watch_state,
            "updatedAt": iso(current),
            "lastQuote": round(executable, 3),
            "lastClosedM5": latest_key,
        })
        proximity_key = f"{plan_id}|{plan.get('generatedAt')}|{zone_low:.3f}|{zone_high:.3f}"
        alert_kind = "ENTRY_WINDOW_OPEN" if price_in_zone else "SETUP_ARMED"
        alert_state_key = "touchWakeKey" if price_in_zone else "approachWakeKey"
        if near_zone and record.get(alert_state_key) != proximity_key:
            record[alert_state_key] = proximity_key
            proximity_events.append((priority, {
                "status": "ZONE_APPROACH",
                "watchState": "ARMED",
                "reason": reason + f"; {alert_kind} alert sent while local watcher waits for a valid trigger",
                "watchPlan": summary,
                "proximity": {
                    "signature": f"{proximity_key}|{'TOUCH' if price_in_zone else 'APPROACH'}",
                    "kind": alert_kind,
                    "planId": plan_id,
                    "direction": direction,
                    "zoneLow": zone_low,
                    "zoneHigh": zone_high,
                    "price": round(executable, 3),
                    "latestClosedM5": latest_key,
                },
                "diagnostics": base_diagnostics,
            }))
        if not matched:
            evaluated_field = "lastEvaluatedClosedM5"
            if record.get(evaluated_field) == latest_key:
                observations.append((priority, {"status": "NO_SIGNAL", "watchState": watch_state, "reason": reason + "; closed M5 already evaluated", "watchPlan": summary}))
                continue
            record[evaluated_field] = latest_key
            breakout_closed_at = None
            if record.get("breakoutClosedM5"):
                try:
                    breakout_closed_at = parse_time(record["breakoutClosedM5"])
                except (TypeError, ValueError):
                    pass
            matched, trigger_labels = watch_trigger_matches(
                plan,
                m5,
                atr5,
                breakout_seen=breakout_seen_before,
                breakout_closed_at=breakout_closed_at,
            )
        if not matched:
            observations.append((priority, {"status": "NO_SIGNAL", "watchState": watch_state, "reason": reason + f"; no closed-{confirmation_timeframe} confirmation", "watchPlan": summary}))
            continue

        min_volume = float(plan_value(plan, "trigger", "minVolumeRatio", "minVolumeRatio", 0.80))
        max_spread = float(plan_value(plan, "risk", "maxSpread", "maxSpread", max(0.08 * atr5, spread * 1.8)))
        minimum_buffer = float(plan_value(plan, "risk", "minimumSlBuffer", "minimumSlBuffer", 0.0))
        noise_buffer = max(1.5 * spread, 0.15 * atr5, minimum_buffer)
        structural_swing = (
            min(invalidation, trigger_candle.low) if direction == "BUY"
            else max(invalidation, trigger_candle.high)
        )
        stop_loss = structural_swing - noise_buffer if direction == "BUY" else structural_swing + noise_buffer
        entry = ask if direction == "BUY" else bid
        configured_tp = plan_value(plan, "risk", "conservativeTakeProfit", "conservativeTakeProfit")
        target_buffer = max(1.5 * spread, 0.10 * atr5)
        take_profit = float(configured_tp) if configured_tp is not None else (
            first_barrier - target_buffer if direction == "BUY" else first_barrier + target_buffer
        )
        risk = entry - stop_loss if direction == "BUY" else stop_loss - entry
        reward = take_profit - entry if direction == "BUY" else entry - take_profit
        trading_cost = spread * 1.25
        rr_after_cost = (reward - trading_cost) / (risk + trading_cost) if risk > 0 else -1.0
        min_rr = max(MIN_RR, float(plan_value(plan, "risk", "minRrAfterCost", "minRrAfterCost", MIN_RR)))
        order_type_hint = "MARKET"
        limit_expires_at: str | None = None
        # A valid closed confirmation often moves price too far for a market
        # entry. In that case preserve the confirmed thesis as a short-lived
        # manual LIMIT back at the mapped retest edge. This is never a blind
        # pre-trigger limit: it is considered only after `matched` is true.
        if rr_after_cost < min_rr and confirmation_timeframe == "M5" and mode in {
            "REJECTION", "RETEST_HOLD", "BREAKOUT_RETEST",
        }:
            zone_midpoint = (zone_low + zone_high) / 2.0
            limit_entry = (
                zone_high if direction == "BUY" and mode != "REJECTION"
                else zone_low if direction == "SELL" and mode != "REJECTION"
                else zone_midpoint
            )
            valid_pending_side = limit_entry < ask if direction == "BUY" else limit_entry > bid
            limit_risk = limit_entry - stop_loss if direction == "BUY" else stop_loss - limit_entry
            limit_reward = take_profit - limit_entry if direction == "BUY" else limit_entry - take_profit
            limit_rr = (
                (limit_reward - trading_cost) / (limit_risk + trading_cost)
                if limit_risk > 0 else -1.0
            )
            if valid_pending_side and limit_reward > 0 and limit_rr >= min_rr:
                entry = limit_entry
                risk = limit_risk
                reward = limit_reward
                rr_after_cost = limit_rr
                order_type_hint = "LIMIT"
                limit_expires_at = iso(current + timedelta(minutes=15))
        momentum_pass = (
            volume_ratio >= min_volume
            if confirmation_timeframe == "M1"
            else volume_ratio >= min_volume or latest.body >= BROAD_MIN_BODY_ATR * atr5
        )
        quality_layers = [
            {"name": "mapped_context", "passed": bool(plan.get("regime") and plan.get("thesis")), "detail": str(plan.get("regime") or "UNKNOWN")},
            {"name": "mapped_location", "passed": touched, "detail": f"{confirmation_timeframe} trigger sequence touched {zone_low:.3f}-{zone_high:.3f}"},
            {"name": "closed_trigger", "passed": matched, "detail": ", ".join(trigger_labels)},
            {"name": "momentum_volume", "passed": momentum_pass, "detail": f"volume {volume_ratio:.2f}x"},
            {"name": "tp_space", "passed": rr_after_cost >= min_rr, "detail": f"post-cost RR {rr_after_cost:.2f}"},
        ]
        passed_layers = sum(1 for layer in quality_layers if layer["passed"])
        if rr_after_cost >= GRADE_A_RR:
            quality_grade = "A"
            required_layers = 3
        elif rr_after_cost >= GRADE_B_RR:
            quality_grade = "B"
            required_layers = GRADE_B_MIN_LAYERS
        else:
            quality_grade = "C"
            required_layers = GRADE_C_MIN_LAYERS

        rejection_reasons: list[str] = []
        if spread > max_spread:
            rejection_reasons.append(f"spread {spread:.3f}>{max_spread:.3f}")
        if confirmation_timeframe == "M5" and volume_ratio < min_volume and latest.body < BROAD_MIN_BODY_ATR * atr5:
            rejection_reasons.append(f"weak momentum/volume {volume_ratio:.2f}x")
        if risk <= 0 or reward <= 0:
            rejection_reasons.append("invalid structural SL/TP geometry")
        if rr_after_cost < min_rr:
            rejection_reasons.append(f"post-cost RR {rr_after_cost:.2f}<{min_rr:.2f}")
        if passed_layers < required_layers:
            rejection_reasons.append(f"quality layers {passed_layers}/5<{required_layers}/5 for grade {quality_grade}")
        if quality_grade in {"B", "C"} and not momentum_pass:
            rejection_reasons.append(f"grade {quality_grade} requires momentum/volume confirmation")
        if rejection_reasons:
            record.update({"status": "TRIGGER_REJECTED", "updatedAt": iso(current), f"rejectedClosed{confirmation_timeframe}": trigger_key})
            observations.append((priority, {
                "status": "NO_SIGNAL", "watchState": "TRIGGER_REJECTED",
                "reason": f"plan {plan_id} trigger rejected: " + "; ".join(rejection_reasons),
                "watchPlan": summary,
                "diagnostics": {f"latestClosed{confirmation_timeframe}": trigger_key, "volumeRatio": round(volume_ratio, 2), "rrAfterCost": round(rr_after_cost, 2), "qualityGrade": quality_grade, "layers": quality_layers},
            }))
            continue

        mode = normalized_trigger_mode(plan)
        signature = f"{plan_id}|{direction}|{mode}|{confirmation_timeframe}|{trigger_key}"
        record.update({"status": "TRIGGERED", "updatedAt": iso(current), "triggeredSignature": signature})
        candidates.append((priority, {
            "status": "CANDIDATE",
            "watchState": "TRIGGERED",
            "reason": f"watch plan {plan_id} confirmed by closed {confirmation_timeframe}: {', '.join(trigger_labels)}",
            "watchPlan": summary,
            "candidate": {
                "signature": signature,
                "planId": plan_id,
                "triggerCandle": {
                    "timeframe": confirmation_timeframe,
                    "openTime": trigger_key,
                    "closedAt": iso(trigger_candle.time.astimezone(VN) + timedelta(seconds=TIMEFRAME_SECONDS[confirmation_timeframe])),
                    "open": round(trigger_candle.open, 3),
                    "high": round(trigger_candle.high, 3),
                    "low": round(trigger_candle.low, 3),
                    "close": round(trigger_candle.close, 3),
                    "volume": round(trigger_candle.volume, 2),
                },
                "direction": direction,
                "orderTypeHint": order_type_hint,
                "limitExpiresAt": limit_expires_at,
                "entry": round(entry, 3),
                "stopLoss": round(stop_loss, 3),
                "initialRiskPrice": round(risk, 3),
                "swingInvalidation": round(invalidation, 3),
                "slBuffer": round(noise_buffer, 3),
                "firstOpposingBarrier": round(first_barrier, 3),
                "conservativeTakeProfit": round(take_profit, 3),
                "grossRr": round(reward / risk, 2),
                "rrAfterCost": round(rr_after_cost, 2),
                "qualityGrade": quality_grade,
                "signalTier": "EARLY" if confirmation_timeframe == "M1" else "CONFIRMED_M5",
                "qualityLayersPassed": passed_layers,
                "qualityLayers": quality_layers,
                "triggerMode": mode,
                "confirmationTimeframe": confirmation_timeframe,
                "triggerCandleOpenTime": trigger_key,
                "triggerLabels": trigger_labels,
                "preMortem": plan.get("preMortem") or "Codex must reject if the fresh snapshot no longer preserves the watch-plan thesis.",
            },
            "diagnostics": {
                "regime": plan.get("regime"),
                "latestClosedM5": latest_key,
                "bid": round(bid, 3), "ask": round(ask, 3), "spread": round(spread, 3),
                "atrM5": round(atr5, 3), "volumeRatio": round(volume_ratio, 2),
                "qualityGrade": quality_grade, "layers": quality_layers,
            },
        }))

    state["updatedAt"] = iso(current)
    if candidates:
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]
    if proximity_events:
        proximity_events.sort(key=lambda item: item[0], reverse=True)
        return proximity_events[0][1]
    if observations:
        observations.sort(key=lambda item: item[0], reverse=True)
        evaluation = observations[0][1]
        evaluation.setdefault("diagnostics", base_diagnostics)
        return evaluation
    return {
        "status": "NO_SIGNAL",
        "watchState": "NO_PLAN",
        "reason": "no active Codex watch plan",
        "diagnostics": base_diagnostics,
    }


def evaluate_candidate(snapshot: dict[str, Any], current: datetime) -> dict[str, Any]:
    m5 = closed_candles(snapshot, "M5", current)
    m15 = closed_candles(snapshot, "M15", current)
    h1 = closed_candles(snapshot, "H1", current)
    h4 = closed_candles(snapshot, "H4", current)
    if len(m5) < 80 or len(m15) < 55 or len(h1) < 55 or len(h4) < 20:
        return {"status": "NO_SIGNAL", "reason": "insufficient closed-candle history"}

    bid = float(snapshot.get("bid") or snapshot.get("price") or 0)
    ask = float(snapshot.get("ask") or 0)
    spread = float(snapshot.get("spread") or max(0.0, ask - bid))
    quote_at = parse_time(snapshot.get("time"))
    quote_age = (current.astimezone(timezone.utc) - quote_at.astimezone(timezone.utc)).total_seconds()
    atr5 = atr(m5)
    atr15 = atr(m15)
    median_spread = statistics.median([row.spread for row in m5[-30:] if row.spread > 0] or [spread])
    spread_limit = max(median_spread * 1.8, 0.08 * atr5)
    if bid <= 0 or ask <= bid or quote_age > 180:
        return {"status": "NO_SIGNAL", "reason": f"stale/invalid quote ({quote_age:.0f}s)"}
    if atr5 <= 0 or spread > spread_limit:
        return {"status": "NO_SIGNAL", "reason": f"spread abnormal ({spread:.3f} > {spread_limit:.3f})"}

    regime, structural_direction = classify_regime(m15, h1, atr15)
    if regime == "UNAVAILABLE":
        return {"status": "NO_SIGNAL", "reason": "regime unavailable"}

    latest, previous = m5[-1], m5[-2]
    trigger, trigger_labels = trigger_direction(latest, previous, atr5)
    close5 = [row.close for row in m5]
    ema20 = ema(close5, 20)[-1]
    ema50 = ema(close5, 50)[-1]
    vwap = session_vwap(m5, current)
    volume_average = statistics.fmean([row.volume for row in m5[-20:]])
    volume_ratio = latest.volume / max(volume_average, 1.0)
    support = min(row.low for row in m5[-24:-1])
    resistance = max(row.high for row in m5[-24:-1])

    direction: str | None = None
    location_reason = ""
    structure_reason = ""
    if regime == "TREND" and trigger == structural_direction:
        pullback_anchor = ema20 if structural_direction == "BUY" else ema20
        near_pullback = abs(latest.close - pullback_anchor) <= 0.65 * atr5 or abs(latest.close - vwap) <= 0.55 * atr5
        not_chasing = abs((ask if trigger == "BUY" else bid) - latest.close) <= 0.35 * atr5
        if near_pullback and not_chasing:
            direction = trigger
            structure_reason = f"M15/H1 aligned {trigger} trend"
            location_reason = "M5 pullback/retest near EMA20 or session VWAP"
    elif regime == "RANGE" and trigger:
        near_lower = latest.low <= support + 0.22 * atr5
        near_upper = latest.high >= resistance - 0.22 * atr5
        if trigger == "BUY" and near_lower:
            direction = "BUY"
            structure_reason = "range rejection"
            location_reason = "M5 lower range edge"
        elif trigger == "SELL" and near_upper:
            direction = "SELL"
            structure_reason = "range rejection"
            location_reason = "M5 upper range edge"
    elif regime == "TRANSITION" and trigger == structural_direction:
        boundary = resistance if trigger == "BUY" else support
        retest_held = latest.low <= boundary + 0.25 * atr5 and latest.close > boundary if trigger == "BUY" else latest.high >= boundary - 0.25 * atr5 and latest.close < boundary
        if retest_held:
            direction = trigger
            structure_reason = f"closed {trigger} breakout and retest"
            location_reason = "retest held at breakout boundary"

    diagnostics = {
        "regime": regime,
        "structuralDirection": structural_direction,
        "triggerDirection": trigger,
        "triggerLabels": trigger_labels,
        "latestClosedM5": iso(latest.time.astimezone(VN)),
        "bid": round(bid, 3),
        "ask": round(ask, 3),
        "spread": round(spread, 3),
        "quoteAgeSeconds": round(quote_age, 1),
        "atrM5": round(atr5, 3),
        "atrM15": round(atr15, 3),
        "ema20M5": round(ema20, 3),
        "ema50M5": round(ema50, 3),
        "sessionVwap": round(vwap, 3),
        "support": round(support, 3),
        "resistance": round(resistance, 3),
        "volumeRatio": round(volume_ratio, 2),
    }
    if not direction:
        return {
            "status": "NO_SIGNAL",
            "reason": "no regime/location/closed-M5 trigger alignment",
            "diagnostics": diagnostics,
        }

    entry = ask if direction == "BUY" else bid
    noise_buffer = max(1.5 * spread, 0.15 * atr5)
    recent = m5[-4:]
    if direction == "BUY":
        invalidation = min(row.low for row in recent)
        stop_loss = invalidation - noise_buffer
    else:
        invalidation = max(row.high for row in recent)
        stop_loss = invalidation + noise_buffer
    risk = entry - stop_loss if direction == "BUY" else stop_loss - entry
    barrier = nearest_barrier(direction, entry, m5, atr5)
    if barrier is None or risk <= 0:
        return {
            "status": "NO_SIGNAL",
            "reason": "no conservative first opposing barrier",
            "diagnostics": diagnostics,
        }
    target_buffer = max(spread * 1.5, atr5 * 0.10)
    take_profit = barrier - target_buffer if direction == "BUY" else barrier + target_buffer
    raw_reward = take_profit - entry if direction == "BUY" else entry - take_profit
    trading_cost = spread + 0.25 * spread
    rr_after_cost = (raw_reward - trading_cost) / (risk + trading_cost)

    momentum_ok = volume_ratio >= BROAD_MIN_VOLUME_RATIO or latest.body >= BROAD_MIN_BODY_ATR * atr5
    layers = [
        {"name": "structure", "passed": True, "detail": structure_reason},
        {"name": "location", "passed": True, "detail": location_reason},
        {"name": "closed_trigger", "passed": bool(trigger_labels), "detail": ", ".join(trigger_labels)},
        {"name": "momentum_volume", "passed": momentum_ok, "detail": f"volume {volume_ratio:.2f}x, body {latest.body / atr5:.2f} ATR"},
        {"name": "tp_space", "passed": rr_after_cost >= BROAD_MIN_RR, "detail": f"post-cost RR {rr_after_cost:.2f}"},
    ]
    passed_layers = sum(1 for item in layers if item["passed"])
    core_layers = sum(1 for item in layers[:3] if item["passed"])
    if core_layers < 3 or rr_after_cost < BROAD_MIN_RR or raw_reward <= BROAD_MIN_REWARD_ATR * atr5:
        return {
            "status": "NO_SIGNAL",
            "reason": "candidate failed core trigger or shortlist RR/space gate",
            "diagnostics": {**diagnostics, "layers": layers, "rrAfterCost": round(rr_after_cost, 2)},
        }

    score = min(99, 65 + passed_layers * 5 + (5 if volume_ratio >= 1.2 else 0))
    return {
        "status": "CANDIDATE",
        "reason": f"{direction} {regime}: {structure_reason}; {location_reason}; {', '.join(trigger_labels)}",
        "candidate": {
            "direction": direction,
            "orderTypeHint": "MARKET",
            "entry": round(entry, 3),
            "stopLoss": round(stop_loss, 3),
            "initialRiskPrice": round(risk, 3),
            "swingInvalidation": round(invalidation, 3),
            "slBuffer": round(noise_buffer, 3),
            "firstOpposingBarrier": round(barrier, 3),
            "conservativeTakeProfit": round(take_profit, 3),
            "grossRr": round(raw_reward / risk, 2),
            "rrAfterCost": round(rr_after_cost, 2),
            "score": score,
            "layers": layers,
            "preMortem": "Reject if the next 1-3 closed M5 candles reclaim the invalidation side or sweep both range edges.",
        },
        "diagnostics": diagnostics,
    }


def evaluate_fast_structural_candidate(snapshot: dict[str, Any], current: datetime) -> dict[str, Any]:
    """Use closed M1 only to time a rejection at structure already visible on closed M5."""
    m1 = closed_candles(snapshot, "M1", current)
    m5 = closed_candles(snapshot, "M5", current)
    m15 = closed_candles(snapshot, "M15", current)
    h1 = closed_candles(snapshot, "H1", current)
    if len(m1) < 30 or len(m5) < 80 or len(m15) < 55 or len(h1) < 55:
        return {"status": "NO_SIGNAL", "reason": "insufficient closed-candle history for broad M1 timing"}

    bid = float(snapshot.get("bid") or snapshot.get("price") or 0)
    ask = float(snapshot.get("ask") or 0)
    spread = float(snapshot.get("spread") or max(0.0, ask - bid))
    quote_at = parse_time(snapshot.get("time"))
    quote_age = (current.astimezone(timezone.utc) - quote_at.astimezone(timezone.utc)).total_seconds()
    atr1, atr5, atr15 = atr(m1), atr(m5), atr(m15)
    if bid <= 0 or ask <= bid or quote_age > 180 or min(atr1, atr5, atr15) <= 0:
        return {"status": "NO_SIGNAL", "reason": "stale/invalid data for broad M1 timing"}
    median_spread = statistics.median([row.spread for row in m5[-30:] if row.spread > 0] or [spread])
    spread_limit = max(median_spread * 1.8, 0.08 * atr5)
    if spread > spread_limit:
        return {"status": "NO_SIGNAL", "reason": f"spread abnormal ({spread:.3f} > {spread_limit:.3f})"}

    regime, structural_direction = classify_regime(m15, h1, atr15)
    if regime not in {"RANGE", "TREND"}:
        return {"status": "NO_SIGNAL", "reason": "broad M1 timing disabled outside range/trend structure"}

    latest_m1 = m1[-1]
    ema20_m5 = ema([row.close for row in m5], 20)[-1]
    session_anchor = session_vwap(m5, current)
    local = m5[-8:]
    major = m5[-24:]
    level_rows: list[tuple[str, str, float]] = []
    if regime == "RANGE":
        level_rows.extend([
            ("BUY", "major M5 range support", min(row.low for row in major)),
            ("BUY", "local M5 swing support", min(row.low for row in local)),
            ("SELL", "major M5 range resistance", max(row.high for row in major)),
            ("SELL", "local M5 swing resistance", max(row.high for row in local)),
        ])
    elif structural_direction:
        level_rows.append((structural_direction, "M5 EMA20 pullback", ema20_m5))
        if abs(session_anchor - ema20_m5) <= 1.5 * atr5:
            level_rows.append((structural_direction, "session VWAP pullback", session_anchor))

    candidates: list[tuple[float, dict[str, Any]]] = []
    seen: set[tuple[str, int]] = set()
    for direction, location_reason, level in level_rows:
        bucket = (direction, round(level / max(0.20 * atr5, 0.01)))
        if bucket in seen:
            continue
        seen.add(bucket)
        half_width = max(0.18 * atr5, 1.5 * spread)
        plan = {
            "direction": direction,
            "trigger": {"mode": "REJECTION"},
            "zone": {"low": level - half_width, "high": level + half_width},
        }
        matched, labels, volume_ratio = fast_m1_trigger_matches(plan, m1, atr1)
        if not matched:
            continue
        entry = ask if direction == "BUY" else bid
        if abs(entry - latest_m1.close) > 0.40 * atr5:
            continue

        noise_buffer = max(1.5 * spread, 0.15 * atr5)
        recent = m5[-8:]
        invalidation = min(row.low for row in recent) if direction == "BUY" else max(row.high for row in recent)
        stop_loss = invalidation - noise_buffer if direction == "BUY" else invalidation + noise_buffer
        risk = entry - stop_loss if direction == "BUY" else stop_loss - entry
        barrier = nearest_barrier(direction, entry, m5, atr5)
        if barrier is None or risk <= 0:
            continue
        target_buffer = max(1.5 * spread, 0.10 * atr5)
        take_profit = barrier - target_buffer if direction == "BUY" else barrier + target_buffer
        reward = take_profit - entry if direction == "BUY" else entry - take_profit
        trading_cost = 1.25 * spread
        rr_after_cost = (reward - trading_cost) / (risk + trading_cost)
        if reward <= BROAD_MIN_REWARD_ATR * atr5 or rr_after_cost < BROAD_MIN_RR:
            continue

        trigger_key = iso(latest_m1.time.astimezone(VN))
        signature = f"BROAD_M1|{direction}|{location_reason}|{trigger_key}"
        layers = [
            {"name": "structure", "passed": True, "detail": f"{regime} structure from closed M15/H1"},
            {"name": "location", "passed": True, "detail": location_reason},
            {"name": "closed_trigger", "passed": True, "detail": ", ".join(labels)},
            {"name": "momentum_volume", "passed": True, "detail": f"closed M1 volume {volume_ratio:.2f}x"},
            {"name": "tp_space", "passed": True, "detail": f"shortlist post-cost RR {rr_after_cost:.2f}"},
        ]
        candidates.append((rr_after_cost, {
            "status": "CANDIDATE",
            "watchState": "BROAD_DISCOVERY",
            "prefilterMode": "BROAD_M1_TIMING",
            "reason": f"{direction} {regime}: {location_reason}; {', '.join(labels)}",
            "candidate": {
                "signature": signature,
                "direction": direction,
                "orderTypeHint": "MARKET",
                "entry": round(entry, 3),
                "stopLoss": round(stop_loss, 3),
                "initialRiskPrice": round(risk, 3),
                "swingInvalidation": round(invalidation, 3),
                "slBuffer": round(noise_buffer, 3),
                "firstOpposingBarrier": round(barrier, 3),
                "conservativeTakeProfit": round(take_profit, 3),
                "grossRr": round(reward / risk, 2),
                "rrAfterCost": round(rr_after_cost, 2),
                "score": min(94, 72 + (5 if volume_ratio >= 1.2 else 0)),
                "layers": layers,
                "triggerCandle": {
                    "timeframe": "M1", "openTime": trigger_key,
                    "closedAt": iso(latest_m1.time.astimezone(VN) + timedelta(minutes=1)),
                    "open": round(latest_m1.open, 3), "high": round(latest_m1.high, 3),
                    "low": round(latest_m1.low, 3), "close": round(latest_m1.close, 3),
                    "volume": round(latest_m1.volume, 2),
                },
                "confirmationTimeframe": "M1",
                "triggerCandleOpenTime": trigger_key,
                "triggerLabels": labels,
                "preMortem": "Broad M1 is only a shortlist. Codex must reject if the mapped M5 level, M15/H1 thesis, or executable RR no longer holds.",
            },
            "diagnostics": {
                "regime": regime, "structuralDirection": structural_direction,
                "latestClosedM5": iso(m5[-1].time.astimezone(VN)), "latestClosedM1": trigger_key,
                "bid": round(bid, 3), "ask": round(ask, 3), "spread": round(spread, 3),
                "quoteAgeSeconds": round(quote_age, 1), "atrM5": round(atr5, 3),
                "volumeRatio": round(volume_ratio, 2), "structuralLevel": round(level, 3),
            },
        }))

    if not candidates:
        return {"status": "NO_SIGNAL", "reason": "no closed-M1 rejection at eligible M5 structure with shortlist RR"}
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def select_broad_evaluation(m5_evaluation: dict[str, Any], m1_evaluation: dict[str, Any]) -> dict[str, Any]:
    """Prefer the more stable closed-M5 shortlist, then allow fast closed-M1 timing."""
    if m5_evaluation.get("status") == "CANDIDATE":
        return m5_evaluation
    if m1_evaluation.get("status") == "CANDIDATE":
        m1_evaluation["broadM5Observation"] = {
            "status": m5_evaluation.get("status"), "reason": m5_evaluation.get("reason"),
        }
        return m1_evaluation
    m5_evaluation["fastM1Observation"] = {
        "status": m1_evaluation.get("status"), "reason": m1_evaluation.get("reason"),
    }
    return m5_evaluation


def select_entry_evaluation(
    watch_evaluation: dict[str, Any],
    broad_evaluation: dict[str, Any],
    has_active_watch_plans: bool,
) -> dict[str, Any]:
    """Prefer daily watch-plan events; broad discovery is disabled in signal-only mode."""
    if watch_evaluation.get("status") == "CANDIDATE":
        evaluation = watch_evaluation
        evaluation.setdefault("prefilterMode", "WATCH_PLAN")
        return evaluation
    if watch_evaluation.get("status") == "ZONE_APPROACH":
        evaluation = watch_evaluation
        evaluation.setdefault("prefilterMode", "WATCH_PLAN")
        return evaluation
    if broad_evaluation.get("status") == "CANDIDATE":
        evaluation = broad_evaluation
        evaluation.setdefault("watchState", "BROAD_DISCOVERY")
        evaluation.setdefault("prefilterMode", "BROAD_DISCOVERY")
        evaluation["watchPlanObservation"] = {
            "status": watch_evaluation.get("status"),
            "watchState": watch_evaluation.get("watchState"),
            "reason": watch_evaluation.get("reason"),
        }
        return evaluation
    if watch_evaluation.get("status") == "REMAP_REQUIRED":
        evaluation = watch_evaluation
        evaluation.setdefault("prefilterMode", "WATCH_PLAN")
        return evaluation
    if has_active_watch_plans:
        evaluation = watch_evaluation
        evaluation["broadDiscovery"] = {
            "status": broad_evaluation.get("status"),
            "reason": broad_evaluation.get("reason"),
            "diagnostics": broad_evaluation.get("diagnostics"),
        }
        return evaluation
    evaluation = broad_evaluation
    evaluation.setdefault("watchState", "BROAD_DISCOVERY")
    evaluation.setdefault("prefilterMode", "BROAD_DISCOVERY")
    return evaluation


def daily_pl(deals_payload: dict[str, Any], orders_payload: dict[str, Any], current: datetime) -> float:
    day = current.date()
    closed = 0.0
    for deal in deals_payload.get("deals") or []:
        try:
            if parse_time(deal.get("time")).astimezone(VN).date() == day:
                closed += float(deal.get("net_profit") or 0)
        except (TypeError, ValueError):
            continue
    floating = sum(
        float(order.get("profit") or 0)
        for order in orders_payload.get("orders") or []
        if order.get("state") == "FILLED"
    )
    return closed + floating


def find_watch_plan(document: dict[str, Any], plan_id: str) -> dict[str, Any] | None:
    for plan in document.get("plans") or []:
        if isinstance(plan, dict) and str(plan.get("planId") or "") == plan_id:
            return plan
    return None


def approved_execution(plan: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """Auto execution is permanently disabled in manual signal-only mode."""
    del plan
    return None, "auto execution disabled: manual signal-only mode"
    # Kept below only as historical validation logic for old state files.
    config = plan.get("execution")
    if not isinstance(config, dict) or config.get("autoExecute") is not True:
        return None, "watch plan has no explicit autoExecute grant"
    if str(config.get("orderType") or "").upper() != "MARKET":
        return None, "auto executor supports MARKET only"
    try:
        volume = float(config.get("volume"))
        max_drift_atr = float(config.get("maxEntryDriftAtr"))
        max_age_seconds = int(config.get("maxTriggerAgeSeconds"))
    except (TypeError, ValueError):
        return None, "execution grant is missing volume/drift/trigger-age"
    if not math.isclose(volume, AUTO_VOLUME, abs_tol=1e-9):
        return None, f"execution volume must equal {AUTO_VOLUME:.2f}"
    if not 0 < max_drift_atr <= 0.30:
        return None, "maxEntryDriftAtr must be in (0, 0.30]"
    if not 15 <= max_age_seconds <= 180:
        return None, "maxTriggerAgeSeconds must be between 15 and 180"
    return {
        "volume": volume,
        "maxEntryDriftAtr": max_drift_atr,
        "maxTriggerAgeSeconds": max_age_seconds,
        "deviation": min(50, max(1, int(config.get("deviation", 30)))),
    }, "approved"


def execution_gate(
    packet: dict[str, Any],
    plan: dict[str, Any],
    config: dict[str, Any],
    snapshot: dict[str, Any],
    current: datetime,
) -> tuple[dict[str, Any] | None, str]:
    """Reprice an approved candidate from a fresh snapshot immediately before POST."""
    candidate = packet.get("candidate") or {}
    direction = str(candidate.get("direction") or "").upper()
    if direction not in {"BUY", "SELL"} or direction != str(plan.get("direction") or "").upper():
        return None, "candidate direction does not match approved plan"
    if str(plan.get("status") or "").upper() != "ACTIVE":
        return None, "approved plan is not ACTIVE"
    try:
        if parse_time(plan.get("expiresAt")).astimezone(VN) <= current:
            return None, "approved plan expired"
        trigger = candidate.get("triggerCandle") or {}
        trigger_closed_at = parse_time(trigger.get("closedAt")).astimezone(VN)
        trigger_age = (current - trigger_closed_at).total_seconds()
        if trigger_age < -5 or trigger_age > config["maxTriggerAgeSeconds"]:
            return None, f"trigger age {trigger_age:.0f}s exceeds execution grant"
        quote_at = parse_time(snapshot.get("time")).astimezone(VN)
        quote_age = (current - quote_at).total_seconds()
        if quote_age < -5 or quote_age > 15:
            return None, f"fresh execution quote required ({quote_age:.0f}s old)"
        bid = float(snapshot.get("bid"))
        ask = float(snapshot.get("ask"))
        spread = float(snapshot.get("spread") or ask - bid)
        entry = ask if direction == "BUY" else bid
        planned_entry = float(candidate.get("entry"))
        stop_loss = float(candidate.get("stopLoss"))
        take_profit = float(candidate.get("conservativeTakeProfit"))
        m5 = closed_candles(snapshot, "M5", current)
        atr5 = atr(m5)
        max_spread = float(plan_value(plan, "risk", "maxSpread", "maxSpread"))
        min_rr = max(MIN_RR, float(plan_value(plan, "risk", "minRrAfterCost", "minRrAfterCost", MIN_RR)))
    except (KeyError, TypeError, ValueError):
        return None, "candidate/plan cannot be repriced safely"
    if bid <= 0 or ask <= bid or atr5 <= 0:
        return None, "invalid quote/ATR during execution recheck"
    if spread > max_spread:
        return None, f"spread {spread:.3f}>{max_spread:.3f}"
    drift = abs(entry - planned_entry)
    if drift > config["maxEntryDriftAtr"] * atr5:
        return None, f"entry drift {drift:.3f} exceeds {config['maxEntryDriftAtr']:.2f} ATR"
    risk = entry - stop_loss if direction == "BUY" else stop_loss - entry
    reward = take_profit - entry if direction == "BUY" else entry - take_profit
    cost = spread * 1.25
    rr_after_cost = (reward - cost) / (risk + cost) if risk > 0 else -1.0
    if risk <= 0 or reward <= 0:
        return None, "fresh entry has invalid SL/TP geometry"
    if rr_after_cost < min_rr:
        return None, f"fresh post-cost RR {rr_after_cost:.2f}<{min_rr:.2f}"
    return {
        "direction": direction,
        "entry": entry,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
        "risk": risk,
        "rrAfterCost": rr_after_cost,
        "spread": spread,
        "atrM5": atr5,
    }, "approved execution gates passed"


def execution_records() -> dict[str, Any]:
    if not EXECUTION_STATE_PATH.exists():
        return {"version": 1, "signatures": {}}
    value = read_json(EXECUTION_STATE_PATH)
    if not isinstance(value.get("signatures"), dict):
        value["signatures"] = {}
    return value


def save_execution_record(records: dict[str, Any], signature: str, value: dict[str, Any]) -> None:
    records.setdefault("signatures", {})[signature] = value
    records["updatedAt"] = value.get("updatedAt") or iso(now_vn())
    # Keep the file bounded without ever forgetting today's attempted signatures.
    rows = list(records["signatures"].items())
    if len(rows) > 200:
        records["signatures"] = dict(rows[-200:])
    atomic_json(EXECUTION_STATE_PATH, records)


def update_review_state_after_execution(
    current: datetime,
    plan: dict[str, Any],
    candidate: dict[str, Any],
    priced: dict[str, Any],
    ticket: int,
    verified_state: str,
) -> None:
    state = read_json(STATE_PATH)
    state.update({
        "sentAt": iso(current),
        "direction": priced["direction"],
        "orderType": f"MARKET_{priced['direction']}",
        "entry": round(priced["entry"], 3),
        "sl": round(priced["stopLoss"], 3),
        "initialSl": round(priced["stopLoss"], 3),
        "initialRiskPrice": round(priced["risk"], 3),
        "tp": round(priced["takeProfit"], 3),
        "rrAfterSpread": round(priced["rrAfterCost"], 2),
        "volume": AUTO_VOLUME,
        "ticket": ticket,
        "status": verified_state,
        "source": "CODEX_APPROVED_WATCH_PLAN_AUTO",
        "watchPlanId": plan.get("planId"),
        "prefilterSignature": candidate.get("signature"),
        "managementStage": "INITIAL",
        "maxFavorablePrice": round(priced["entry"], 3),
        "maxFavorableR": 0.0,
    })
    atomic_json(STATE_PATH, state)


def try_auto_execute_watch_candidate(
    packet: dict[str, Any],
    watch_document: dict[str, Any],
    current: datetime,
) -> dict[str, Any]:
    """Hard stop retained for compatibility with callers from older versions."""
    del watch_document, current
    packet["autoExecution"] = {
        "status": "DISABLED_SIGNAL_ONLY",
        "reason": "user places every order manually after Telegram review",
    }
    packet["writesToMt5"] = False
    return packet
    # Legacy implementation below is unreachable by design.
    if packet.get("status") != "CANDIDATE" or packet.get("prefilterMode") != "WATCH_PLAN":
        return packet
    candidate = packet.get("candidate") or {}
    signature = str(candidate.get("signature") or "")
    plan_id = str(candidate.get("planId") or "")
    plan = find_watch_plan(watch_document, plan_id)
    if not signature or plan is None:
        return packet
    config, approval_reason = approved_execution(plan)
    if config is None:
        packet["autoExecution"] = {"status": "NOT_AUTHORIZED", "reason": approval_reason}
        return packet

    records = execution_records()
    prior = records.get("signatures", {}).get(signature)
    if isinstance(prior, dict):
        packet["autoExecution"] = {"status": "DEDUPED", "reason": "signature already attempted"}
        return packet

    # Full fail-closed recheck immediately before the one allowed POST.
    news = read_json(NEWS_PATH)
    news_clear, news_reason = news_gate(current, news)
    if not news_clear:
        packet["autoExecution"] = {"status": "REJECTED", "reason": news_reason}
        return packet
    health = get_json("/health")
    orders = get_json("/orders?" + urllib.parse.urlencode({"symbol": SYMBOL}))
    deals = get_json("/deals?" + urllib.parse.urlencode({"symbol": SYMBOL, "hours": 48}))
    snapshot = get_json("/snapshot?" + urllib.parse.urlencode({"symbol": SYMBOL, "count": 400}))
    if not bool(health.get("trade_allowed")):
        packet["autoExecution"] = {"status": "REJECTED", "reason": "MT5 trade_allowed=false on final recheck"}
        return packet
    if orders.get("orders"):
        packet["autoExecution"] = {"status": "REJECTED", "reason": "XAUUSDm order already exists on final recheck"}
        return packet
    pl = daily_pl(deals, orders, current)
    if pl <= -40 or pl >= 200:
        packet["autoExecution"] = {"status": "REJECTED", "reason": f"daily P/L gate reached: {pl:.2f} USD"}
        return packet
    priced, gate_reason = execution_gate(packet, plan, config, snapshot, current)
    if priced is None:
        packet["autoExecution"] = {"status": "REJECTED", "reason": gate_reason}
        return packet

    attempted = {
        "status": "ATTEMPTED",
        "updatedAt": iso(current),
        "planId": plan_id,
        "direction": priced["direction"],
    }
    # Persist before POST: a timeout is ambiguous and must never cause a retry.
    save_execution_record(records, signature, attempted)
    payload = {
        "symbol": SYMBOL,
        "order_type": f"MARKET_{priced['direction']}",
        "volume": config["volume"],
        "stop_loss": round(priced["stopLoss"], 3),
        "take_profit": round(priced["takeProfit"], 3),
        "deviation": config["deviation"],
        "comment": AUTO_COMMENT,
    }
    try:
        result = post_json("/order", payload)
    except Exception as error:  # POST may have reached MT5; never retry this signature.
        attempted.update({"status": "UNCERTAIN", "updatedAt": iso(now_vn()), "reason": str(error)[:240]})
        save_execution_record(records, signature, attempted)
        packet["autoExecution"] = {"status": "UNCERTAIN", "reason": "order POST failed or timed out; signature will not retry"}
        return packet

    ticket = int(result.get("ticket") or 0)
    if not result.get("ok") or ticket <= 0:
        attempted.update({"status": "FAILED", "updatedAt": iso(now_vn()), "reason": "bridge returned no verified ticket"})
        save_execution_record(records, signature, attempted)
        packet["autoExecution"] = {"status": "FAILED", "reason": attempted["reason"]}
        return packet
    verification = get_json(f"/order/{ticket}?" + urllib.parse.urlencode({"symbol": SYMBOL}))
    verified_state = str(verification.get("state") or "").upper()
    if verified_state not in {"PENDING", "FILLED"}:
        attempted.update({"status": "UNCERTAIN", "updatedAt": iso(now_vn()), "ticket": ticket, "reason": f"ticket state {verified_state or 'UNKNOWN'}"})
        save_execution_record(records, signature, attempted)
        packet["autoExecution"] = {"status": "UNCERTAIN", "ticket": ticket, "reason": attempted["reason"]}
        return packet

    verified_orders = get_json("/orders?" + urllib.parse.urlencode({"symbol": SYMBOL})).get("orders") or []
    verified_order = next(
        (row for row in verified_orders if int(row.get("ticket") or 0) == ticket), None
    )
    if not isinstance(verified_order, dict):
        attempted.update({"status": "UNCERTAIN", "updatedAt": iso(now_vn()), "ticket": ticket, "reason": "ticket not present in verified active-order list"})
        save_execution_record(records, signature, attempted)
        packet["autoExecution"] = {"status": "UNCERTAIN", "ticket": ticket, "reason": attempted["reason"]}
        return packet
    actual_direction = order_side(verified_order, {})
    actual_volume = numeric_value(verified_order.get("volume"))
    actual_sl = numeric_value(verified_order.get("stop_loss"), verified_order.get("sl"))
    actual_tp = numeric_value(verified_order.get("take_profit"), verified_order.get("tp"))
    actual_entry = numeric_value(verified_order.get("price_open"), verified_order.get("entry"), result.get("price"))
    if (
        actual_direction != priced["direction"]
        or not math.isclose(actual_volume, AUTO_VOLUME, abs_tol=1e-9)
        or not math.isclose(actual_sl, priced["stopLoss"], abs_tol=0.011)
        or not math.isclose(actual_tp, priced["takeProfit"], abs_tol=0.011)
        or actual_entry <= 0
    ):
        attempted.update({"status": "UNCERTAIN", "updatedAt": iso(now_vn()), "ticket": ticket, "reason": "verified ticket fields do not match approved direction/volume/SL/TP"})
        save_execution_record(records, signature, attempted)
        packet["autoExecution"] = {"status": "UNCERTAIN", "ticket": ticket, "reason": attempted["reason"]}
        return packet
    priced["entry"] = actual_entry
    priced["risk"] = actual_entry - priced["stopLoss"] if priced["direction"] == "BUY" else priced["stopLoss"] - actual_entry
    actual_reward = priced["takeProfit"] - actual_entry if priced["direction"] == "BUY" else actual_entry - priced["takeProfit"]
    priced["rrAfterCost"] = (actual_reward - priced["spread"] * 1.25) / (priced["risk"] + priced["spread"] * 1.25)

    attempted.update({"status": "VERIFIED", "updatedAt": iso(now_vn()), "ticket": ticket, "ticketState": verified_state})
    save_execution_record(records, signature, attempted)
    update_review_state_after_execution(current, plan, candidate, priced, ticket, verified_state)
    telegram_sent = send_telegram(
        f"XAUUSDm AUTO {priced['direction']} verified\n"
        f"Ticket: {ticket} ({verified_state})\nEntry: {priced['entry']:.3f}\n"
        f"SL: {priced['stopLoss']:.3f} | TP: {priced['takeProfit']:.3f}\n"
        f"RR after cost: {priced['rrAfterCost']:.2f}\nPlan: {plan_id}"
    )
    result_packet = base_packet(current, "FOLLOW_REQUIRED", f"auto-executed approved watch plan {plan_id}; ticket {ticket} verified {verified_state}")
    result_packet.update({
        "dailyPlUsd": round(pl, 2),
        "activeOrders": [{"ticket": ticket, "state": verified_state}],
        "candidate": candidate,
        "autoExecution": {
            "status": "VERIFIED", "ticket": ticket, "ticketState": verified_state,
            "telegramSent": telegram_sent, "rrAfterCost": round(priced["rrAfterCost"], 2),
        },
        "writesToMt5": True,
    })
    return result_packet


def base_packet(current: datetime, status: str, reason: str) -> dict[str, Any]:
    return {
        "version": 2,
        "generatedAt": iso(current),
        "expiresAt": iso(current + timedelta(minutes=DEFAULT_PACKET_TTL_MINUTES)),
        "symbol": SYMBOL,
        "status": status,
        "reason": reason,
        "source": "local-watch-prefilter-v2",
        "codexReviewRequired": status in {"FOLLOW_REQUIRED", "REMAP_REQUIRED", "MAP_REVIEW_REQUIRED"},
        "writesToMt5": False,
    }


def closed_m5_expiry(open_time: object) -> str:
    return closed_trigger_expiry(open_time, "M5")


def closed_trigger_expiry(open_time: object, timeframe: str) -> str:
    normalized = str(timeframe or "M5").upper()
    duration = TIMEFRAME_SECONDS.get(normalized, TIMEFRAME_SECONDS["M5"])
    candle_open = parse_time(open_time).astimezone(VN)
    candle_close = candle_open + timedelta(seconds=duration)
    if normalized == "M1":
        return iso(candle_close + timedelta(seconds=FAST_CANDIDATE_TTL_SECONDS_AFTER_CLOSE))
    return iso(candle_close + timedelta(minutes=CANDIDATE_TTL_MINUTES_AFTER_CLOSE))


def order_ticket(order: dict[str, Any]) -> str:
    return str(order.get("ticket") or order.get("position_ticket") or order.get("order") or "unknown")


def order_state(order: dict[str, Any]) -> str:
    return str(order.get("state") or order.get("status") or "UNKNOWN").upper()


def order_side(order: dict[str, Any], state: dict[str, Any]) -> str:
    raw = str(
        order.get("direction") or order.get("side") or order.get("type")
        or order.get("order_type") or state.get("direction") or ""
    ).upper()
    if "BUY" in raw:
        return "BUY"
    if "SELL" in raw:
        return "SELL"
    return "UNKNOWN"


def numeric_value(*values: object) -> float:
    for value in values:
        try:
            parsed = float(value)
            if math.isfinite(parsed):
                return parsed
        except (TypeError, ValueError):
            continue
    return 0.0


def build_follow_packet(
    current: datetime,
    active_orders: list[dict[str, Any]],
    state: dict[str, Any],
    common: dict[str, Any],
) -> dict[str, Any]:
    order = active_orders[0]
    ticket = order_ticket(order)
    mt5_state = order_state(order)
    follow: dict[str, Any] = {
        "ticket": ticket,
        "orderState": mt5_state,
        "kind": "ORDER_STATE",
        "signature": f"{ticket}|{mt5_state}",
    }
    reason = f"MT5 has an active XAUUSDm {mt5_state} order/position"
    packet = base_packet(current, "FOLLOW_REQUIRED", reason)
    packet.update(common)

    if mt5_state == "FILLED":
        snapshot = get_json("/snapshot?" + urllib.parse.urlencode({"symbol": SYMBOL, "count": 400}))
        atomic_json(SNAPSHOT_PATH, snapshot)
        m5 = closed_candles(snapshot, "M5", current)
        latest_closed_m5 = iso(m5[-1].time.astimezone(VN)) if m5 else "unknown"
        bid = numeric_value(snapshot.get("bid"), snapshot.get("price"))
        ask = numeric_value(snapshot.get("ask"))
        spread = numeric_value(snapshot.get("spread"), ask - bid if ask and bid else 0)
        entry = numeric_value(order.get("entry"), order.get("price_open"), order.get("price"), state.get("entry"))
        initial_sl = numeric_value(state.get("initialSl"), state.get("sl"), order.get("stop_loss"), order.get("sl"))
        current_sl = numeric_value(order.get("stop_loss"), order.get("sl"))
        side = order_side(order, state)
        risk = abs(entry - initial_sl) if entry and initial_sl else 0.0
        close_price = bid if side == "BUY" else ask
        current_r = ((close_price - entry) / risk if side == "BUY" else (entry - close_price) / risk) if risk > 0 and close_price else None
        target_sl = (entry + 0.8 * risk if side == "BUY" else entry - 0.8 * risk) if risk > 0 else 0.0
        protected = bool(
            current_sl and target_sl and (
                current_sl >= target_sl - 0.001 if side == "BUY" else current_sl <= target_sl + 0.001
            )
        )
        if current_r is not None and current_r >= 0.8 and not protected:
            follow.update({
                "kind": "PROTECT_0_8R",
                "signature": f"{ticket}|PROTECT_0_8R",
                "currentR": round(current_r, 3),
                "targetStopLoss": round(target_sl, 3),
                "protected": False,
            })
            reason = f"FILLED ticket {ticket} reached {current_r:.2f}R and requires +0.8R protection review"
        else:
            follow.update({
                "kind": "FILLED_M5_REVIEW",
                "signature": f"{ticket}|FILLED_M5_REVIEW|{latest_closed_m5}",
                "currentR": round(current_r, 3) if current_r is not None else None,
                "targetStopLoss": round(target_sl, 3) if target_sl else None,
                "protected": protected,
            })
            reason = f"FILLED ticket {ticket} requires review for closed M5 {latest_closed_m5}"
        packet["diagnostics"] = {
            "latestClosedM5": latest_closed_m5,
            "bid": round(bid, 3),
            "ask": round(ask, 3),
            "spread": round(spread, 3),
        }

    packet["reason"] = reason
    packet["follow"] = follow
    packet["expiresAt"] = iso(current + timedelta(minutes=3))
    return packet


def candidate_signature(candidate: dict[str, Any], regime: str) -> str:
    entry = float(candidate.get("entry") or 0)
    bucket = round(entry / 2.0) * 2.0
    return f"{candidate.get('direction')}|{regime}|{bucket:.1f}"


def keep_unreviewed_candidate(
    incoming: dict[str, Any],
    current: datetime,
    state: dict[str, Any],
) -> dict[str, Any]:
    """Latch short-lived wake packets so dispatch failures can retry before expiry."""
    if incoming.get("status") not in {"NO_SIGNAL", "ERROR"} or not PACKET_PATH.exists():
        return incoming
    try:
        existing = read_json(PACKET_PATH)
        existing_status = str(existing.get("status") or "").upper()
        if existing_status not in {"ZONE_APPROACH", "MAP_REVIEW_REQUIRED", "REMAP_REQUIRED"}:
            return incoming
        if existing_status == "MAP_REVIEW_REQUIRED":
            signature = str((existing.get("mapReview") or {}).get("signature") or "")
            reviewed_signatures = {
                str(state.get("lastPrefilterReviewedSignature") or ""),
                str(state.get("lastMapReviewSignature") or ""),
            }
            # Once Codex has reviewed this H1 close, release the latched map
            # packet immediately. Keeping it alive until its rolling expiry
            # suppresses later ZONE_APPROACH wakes from the active plan.
            if signature and signature in reviewed_signatures:
                return incoming
        if existing_status in {"ZONE_APPROACH", "REMAP_REQUIRED"}:
            event_plan_id = str(
                (existing.get("candidate") or {}).get("planId")
                or (existing.get("proximity") or {}).get("planId")
                or (existing.get("remap") or {}).get("planId")
                or ""
            )
            if event_plan_id and WATCH_PLAN_PATH.exists():
                current_plan_ids = {
                    str(plan.get("planId") or "")
                    for plan in watch_plans(read_json(WATCH_PLAN_PATH))
                }
                if event_plan_id not in current_plan_ids:
                    return incoming
        if parse_time(existing.get("expiresAt")).astimezone(VN) <= current:
            return incoming
        existing["lastPrefilterScanAt"] = iso(current)
        existing["latestScanStatus"] = incoming.get("status")
        existing["latestScanReason"] = incoming.get("reason")
        return existing
    except (OSError, TypeError, ValueError):
        return incoming


def is_map_review_slot(current: datetime) -> bool:
    """Allow the hourly H1 review to recover if a higher-priority event owns :01."""
    local = current.astimezone(VN)
    return (
        8 <= local.hour < 23
        and 1 <= local.minute <= MAP_REVIEW_GRACE_MINUTES
    )


def map_review_packet(current: datetime, common: dict[str, Any], packet: dict[str, Any]) -> dict[str, Any]:
    local = current.astimezone(VN)
    closed_at = local.replace(minute=0, second=0, microsecond=0)
    result = base_packet(
        current,
        "MAP_REVIEW_REQUIRED",
        f"scheduled hourly map review for H1 candle closed at {iso(closed_at)}",
    )
    result.update(common)
    result["expiresAt"] = iso(current + timedelta(minutes=MAP_REVIEW_TTL_MINUTES))
    result["mapReview"] = {
        "kind": "HOURLY_MAP_REVIEW",
        "closedH1At": iso(closed_at),
        "signature": f"HOURLY_MAP_REVIEW|{iso(closed_at)}",
        "previousPrefilterStatus": packet.get("status"),
        "previousPrefilterReason": packet.get("reason"),
    }
    return result


def news_refresh_packet(current: datetime, reason: str) -> dict[str, Any]:
    """Wake Codex to refresh a missing daily news cache before any MT5 read.

    A stale cache is not a real blackout. Treating it as NEWS_BLACKOUT forever
    left the watcher alive but unable to create the first plan of a new day.
    Codex must refresh the calendar first and may only continue to MT5/map when
    the refreshed cache confirms that the current time is outside blackout.
    """
    result = base_packet(
        current,
        "MAP_REVIEW_REQUIRED",
        f"{reason}; Codex must refresh today's USD calendar before map review",
    )
    result["newsGate"] = reason
    result["expiresAt"] = iso(current + timedelta(minutes=MAP_REVIEW_TTL_MINUTES))
    result["mapReview"] = {
        "kind": "NEWS_REFRESH_AND_MAP_REVIEW",
        "closedH1At": iso(current.astimezone(VN).replace(minute=0, second=0, microsecond=0)),
        "signature": f"NEWS_REFRESH|{current.astimezone(VN).date().isoformat()}",
        "requiresNewsRefresh": True,
    }
    return result


def map_review_signature(current: datetime) -> str:
    local = current.astimezone(VN)
    closed_at = local.replace(minute=0, second=0, microsecond=0)
    return f"HOURLY_MAP_REVIEW|{iso(closed_at)}"


def should_emit_map_review(map_review_due: bool, packet_status: str) -> bool:
    """Never hide a time-sensitive entry/remap event behind the hourly map."""
    return map_review_due and str(packet_status or "").upper() not in {
        "ZONE_APPROACH", "CANDIDATE", "REMAP_REQUIRED",
    }


def run_once(current: datetime | None = None) -> dict[str, Any]:
    current = current or now_vn()
    if not in_active_window(current):
        packet = base_packet(current, "OUTSIDE_HOURS", "outside 08:00-23:00 VN")
        atomic_json(PACKET_PATH, packet)
        return packet

    # State is intentionally read before news/MT5 to mirror the Codex workflow.
    state = read_json(STATE_PATH)
    recorded_status = str(state.get("status") or "UNKNOWN").upper()
    unresolved = recorded_status in {"PENDING", "FILLED", "UNKNOWN", ""}

    if not unresolved:
        news = read_json(NEWS_PATH)
        news_clear, news_reason = news_gate(current, news)
        if not news_clear:
            if news_reason == "news cache missing or stale":
                packet = news_refresh_packet(current, news_reason)
            else:
                packet = base_packet(current, "NEWS_BLACKOUT", news_reason)
            atomic_json(PACKET_PATH, packet)
            return packet
    else:
        news_reason = "skipped because recorded order needs follow-up"

    health = get_json("/health")
    orders = get_json("/orders?" + urllib.parse.urlencode({"symbol": SYMBOL}))
    deals = get_json("/deals?" + urllib.parse.urlencode({"symbol": SYMBOL, "hours": 48}))
    active_orders = orders.get("orders") or []
    pl = daily_pl(deals, orders, current)
    common = {
        "newsGate": news_reason,
        "health": {"ok": health.get("ok"), "tradeAllowed": health.get("trade_allowed")},
        "dailyPlUsd": round(pl, 2),
        "activeOrders": active_orders,
    }

    if active_orders:
        packet = build_follow_packet(current, active_orders, state, common)
        atomic_json(PACKET_PATH, packet)
        return packet
    if not bool(health.get("trade_allowed")):
        packet = base_packet(current, "BLOCKED", "MT5 trade_allowed=false")
        packet.update(common)
        atomic_json(PACKET_PATH, packet)
        return packet
    if pl <= -40 or pl >= 200:
        packet = base_packet(current, "BLOCKED", f"daily P/L gate reached: {pl:.2f} USD")
        packet.update(common)
        atomic_json(PACKET_PATH, packet)
        return packet

    snapshot = get_json("/snapshot?" + urllib.parse.urlencode({"symbol": SYMBOL, "count": 400}))
    atomic_json(SNAPSHOT_PATH, snapshot)
    watch_document = read_json(WATCH_PLAN_PATH) if WATCH_PLAN_PATH.exists() else {"plans": []}
    watch_state = read_json(WATCH_STATE_PATH) if WATCH_STATE_PATH.exists() else {"version": 1, "plans": {}}
    active_watch_plans = watch_plans(watch_document)
    watch_evaluation = evaluate_watch_plans(snapshot, current, watch_document, watch_state)
    atomic_json(WATCH_STATE_PATH, watch_state)
    broad_evaluation = {
        "status": "NO_SIGNAL",
        "reason": "broad discovery disabled; signal-only mode follows Codex daily watch plans",
    }
    evaluation = select_entry_evaluation(
        watch_evaluation, broad_evaluation, bool(active_watch_plans)
    )
    packet = base_packet(current, evaluation["status"], evaluation["reason"])
    packet.update(common)
    packet.update({key: value for key, value in evaluation.items() if key not in {"status", "reason"}})
    if packet.get("status") == "REMAP_REQUIRED":
        closed_m5 = (packet.get("remap") or {}).get("invalidatedByClosedM5")
        if closed_m5:
            packet["expiresAt"] = closed_m5_expiry(closed_m5)
    if packet.get("status") == "CANDIDATE":
        candidate = packet.get("candidate") or {}
        regime = str((packet.get("diagnostics") or {}).get("regime") or "UNKNOWN")
        signature = str(candidate.get("signature") or candidate_signature(candidate, regime))
        candidate["signature"] = signature
        packet["candidate"] = candidate
        trigger_open = (candidate.get("triggerCandle") or {}).get("openTime")
        if trigger_open:
            trigger_timeframe = (candidate.get("triggerCandle") or {}).get("timeframe") or candidate.get("confirmationTimeframe") or "M5"
            packet["expiresAt"] = closed_trigger_expiry(trigger_open, str(trigger_timeframe))
    # Signal-only invariant: the watcher never calls /order. A locally valid
    # candidate is sent directly to Telegram without waiting for Codex.
    packet["writesToMt5"] = False
    # Approach alerts are intentionally sent before packet latching. Only the
    # newly evaluated approach/touch event reaches this call; the Telegram
    # helper consumes its signature before network I/O to prevent duplicates.
    packet = send_zone_telegram(packet, current)
    packet = send_candidate_telegram(packet, current)
    # A latched ZONE_APPROACH used to suppress the :01 hourly review entirely.
    # Give CANDIDATE/REMAP priority, but use the short grace window above so the
    # hourly review is emitted as soon as that time-sensitive event clears.
    reviewed_map_signatures = {
        str(state.get("lastPrefilterReviewedSignature") or ""),
        str(state.get("lastMapReviewSignature") or ""),
    }
    map_review_due = (
        is_map_review_slot(current)
        and map_review_signature(current) not in reviewed_map_signatures
    )
    if should_emit_map_review(map_review_due, str(packet.get("status") or "")):
        packet = map_review_packet(current, common, packet)
    else:
        packet = keep_unreviewed_candidate(packet, current, state)
    atomic_json(PACKET_PATH, packet)
    return packet


def error_packet(error: Exception, current: datetime | None = None) -> dict[str, Any]:
    current = current or now_vn()
    packet = base_packet(current, "ERROR", str(error).replace("\n", " ")[:500])
    try:
        state = read_json(STATE_PATH)
        packet = keep_unreviewed_candidate(packet, current, state)
    except (OSError, ValueError):
        pass
    atomic_json(PACKET_PATH, packet)
    return packet


def seconds_until_slot(current: datetime, interval_seconds: int = SCAN_SECONDS) -> float:
    elapsed = current.minute * 60 + current.second + current.microsecond / 1_000_000
    # Normal scans run at :01/:04/... so M15 map reviews land at :01/:16/:31/:46.
    phase_seconds = 60 if interval_seconds == SCAN_SECONDS else 0
    remainder = (elapsed - phase_seconds) % interval_seconds
    return max(1.0, interval_seconds - remainder + 3.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local XAUUSDm Codex prefilter")
    parser.add_argument("--once", action="store_true", help="Run one scan and exit")
    args = parser.parse_args()
    lock = acquire_lock()
    if lock is None:
        log("another prefilter process is already running")
        return 1

    while True:
        try:
            packet = run_once()
            record = append_audit(packet)
            log(f"status={packet['status']} decision={record['decision']} reason={packet['reason']}")
        except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError) as error:
            packet = error_packet(error)
            record = append_audit(packet)
            log(f"status=ERROR decision={record['decision']} reason={packet['reason']}")
        except Exception as error:  # noqa: BLE001
            packet = error_packet(error)
            record = append_audit(packet)
            log(f"status=ERROR decision={record['decision']} unexpected={packet['reason']}")
        if args.once:
            return 0 if packet["status"] != "ERROR" else 2
        interval = FOLLOW_SCAN_SECONDS if packet.get("status") == "FOLLOW_REQUIRED" else SCAN_SECONDS
        time.sleep(seconds_until_slot(now_vn(), interval))


if __name__ == "__main__":
    raise SystemExit(main())
