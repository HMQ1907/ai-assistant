from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "codex-xau-prefilter.py"
SPEC = importlib.util.spec_from_file_location("codex_xau_prefilter", SCRIPT)
assert SPEC and SPEC.loader
prefilter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = prefilter
SPEC.loader.exec_module(prefilter)


def candle(at: datetime, open_: float, high: float, low: float, close: float, volume: float = 1000):
    return prefilter.Candle(at, open_, high, low, close, volume, 0.25)


def watch_snapshot(current: datetime, triggering: bool = False):
    start = current - timedelta(minutes=5 * 30 + 1)
    rows = []
    for index in range(29):
        at = start + timedelta(minutes=5 * index)
        value = 106.0 + (index % 3) * 0.1
        rows.append({
            "time": prefilter.iso(at), "open": value, "high": value + 0.8,
            "low": value - 0.8, "close": value + 0.1, "volume": 1000, "spread": 0.25,
        })
    latest_at = current - timedelta(minutes=6)
    if triggering:
        rows.append({
            "time": prefilter.iso(latest_at), "open": 109.8, "high": 110.8,
            "low": 108.5, "close": 109.2, "volume": 1300, "spread": 0.25,
        })
    else:
        rows.append({
            "time": prefilter.iso(latest_at), "open": 109.5, "high": 110.0,
            "low": 109.0, "close": 109.6, "volume": 900, "spread": 0.25,
        })
    m1_rows = []
    m1_start = current - timedelta(minutes=31)
    for index in range(29):
        at = m1_start + timedelta(minutes=index)
        value = 109.4 + (index % 2) * 0.05
        m1_rows.append({
            "time": prefilter.iso(at), "open": value, "high": value + 0.25,
            "low": value - 0.25, "close": value + 0.02, "volume": 1000, "spread": 0.25,
        })
    latest_m1_at = current - timedelta(minutes=2)
    if triggering:
        m1_rows.append({
            "time": prefilter.iso(latest_m1_at), "open": 109.8, "high": 110.8,
            "low": 108.5, "close": 109.15, "volume": 1300, "spread": 0.25,
        })
    else:
        m1_rows.append({
            "time": prefilter.iso(latest_m1_at), "open": 109.45, "high": 109.7,
            "low": 109.2, "close": 109.5, "volume": 900, "spread": 0.25,
        })
    return {
        "time": prefilter.iso(current - timedelta(seconds=2)),
        "bid": 109.2, "ask": 109.45, "spread": 0.25,
        "candles": {"M1": m1_rows, "M5": rows},
    }


def with_closed_m15(snapshot: dict, current: datetime, close: float) -> dict:
    snapshot["candles"]["M15"] = [
        {
            "time": prefilter.iso(current - timedelta(minutes=31)),
            "open": close - 0.5, "high": close + 0.5,
            "low": close - 1.0, "close": close - 0.2,
            "volume": 1000, "spread": 0.25,
        },
        {
            "time": prefilter.iso(current - timedelta(minutes=16)),
            "open": close - 0.8, "high": close + 0.4,
            "low": close - 1.0, "close": close,
            "volume": 1200, "spread": 0.25,
        },
    ]
    return snapshot


def sell_watch_plan(current: datetime):
    return {
        "version": 1,
        "plans": [{
            "planId": "sell-upper-edge", "symbol": "XAUUSDm", "status": "ACTIVE",
            "priority": 100, "generatedAt": prefilter.iso(current - timedelta(minutes=15)),
            "expiresAt": prefilter.iso(current + timedelta(minutes=45)),
            "regime": "RANGE", "direction": "SELL", "thesis": "upper-edge rejection",
            "zone": {"low": 109.0, "high": 111.0, "proximityAtr": 0.35},
            "trigger": {"mode": "REJECTION", "timeframe": "M5", "requireClosed": True, "minVolumeRatio": 0.8},
            "risk": {
                "invalidationPrice": 111.0, "firstBarrier": 100.0,
                "conservativeTakeProfit": 100.5, "maxSpread": 0.4, "minRrAfterCost": 1.6,
            },
        }],
    }


def broad_fast_m1_snapshot(current: datetime):
    def rows(timeframe_minutes: int, count: int, base: float = 100.0):
        start = current - timedelta(minutes=timeframe_minutes * count)
        output = []
        for index in range(count):
            at = start + timedelta(minutes=timeframe_minutes * index)
            value = base + (index % 4 - 1.5) * 0.08
            output.append({
                "time": prefilter.iso(at), "open": value, "high": value + 0.8,
                "low": value - 0.8, "close": value + 0.04, "volume": 1000, "spread": 0.25,
            })
        return output

    m5 = rows(5, 90)
    # Stable M5 resistance and a lower pivot leave enough conservative SELL space.
    m5[-12].update({"open": 98.2, "high": 99.0, "low": 97.0, "close": 98.4})
    m5[-8].update({"open": 101.2, "high": 102.0, "low": 100.5, "close": 101.4})
    m5[-1].update({"open": 101.0, "high": 101.8, "low": 100.4, "close": 101.3})
    m1 = rows(1, 40, 101.4)
    m1[-2].update({"open": 101.5, "high": 101.85, "low": 101.25, "close": 101.7, "volume": 1000})
    m1[-1].update({"open": 101.8, "high": 102.2, "low": 101.0, "close": 101.15, "volume": 1400})
    h1 = rows(60, 60)
    for index, row in enumerate(h1):
        value = 101.5 - index * 0.04
        row.update({"open": value + 0.05, "high": value + 0.8, "low": value - 0.8, "close": value})
    return {
        "time": prefilter.iso(current - timedelta(seconds=2)),
        "bid": 101.65, "ask": 101.90, "spread": 0.25,
        "candles": {"M1": m1, "M5": m5, "M15": rows(15, 60), "H1": h1, "H4": rows(240, 24)},
    }


class PrefilterTests(unittest.TestCase):
    def test_only_highest_priority_active_watch_plan_is_followed(self):
        document = {
            "plans": [
                {"planId": "backup", "status": "ACTIVE", "priority": 2},
                {"planId": "primary", "status": "ACTIVE", "priority": 1},
                {"planId": "inactive", "status": "DISABLED", "priority": 0},
            ]
        }
        self.assertEqual([row["planId"] for row in prefilter.watch_plans(document)], ["primary"])

    def test_news_gate_rejects_stale_cache_and_blackout(self):
        current = datetime(2026, 8, 18, 19, 20, tzinfo=prefilter.VN)
        self.assertFalse(prefilter.news_gate(current, {"date_vn": "2026-08-17", "events": []})[0])
        clear, reason = prefilter.news_gate(
            current,
            {"date_vn": "2026-08-18", "events": [{"time_vn": "19:30", "impact": "HIGH"}]},
        )
        self.assertFalse(clear)
        self.assertIn("blackout", reason)

    def test_closed_candles_excludes_forming_bar(self):
        current = datetime(2026, 8, 18, 9, 13, tzinfo=prefilter.VN)
        snapshot = {
            "candles": {
                "M5": [
                    {"time": "2026-08-18T09:05:00+07:00", "open": 1, "high": 2, "low": 0, "close": 1, "volume": 1, "spread": 0.1},
                    {"time": "2026-08-18T09:10:00+07:00", "open": 1, "high": 2, "low": 0, "close": 1, "volume": 1, "spread": 0.1},
                ]
            }
        }
        rows = prefilter.closed_candles(snapshot, "M5", current)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].time.astimezone(prefilter.VN).minute, 5)

    def test_trigger_detects_closed_bullish_rejection(self):
        at = datetime(2026, 8, 18, tzinfo=timezone.utc)
        previous = candle(at, 100, 101, 99, 100)
        latest = candle(at + timedelta(minutes=5), 100, 101.2, 97.5, 100.9)
        direction, labels = prefilter.trigger_direction(latest, previous, 2.0)
        self.assertEqual(direction, "BUY")
        self.assertIn("bullish rejection", labels)

    def test_regime_requires_m15_and_h1_alignment(self):
        start = datetime(2026, 8, 1, tzinfo=timezone.utc)
        m15 = []
        h1 = []
        for index in range(70):
            value = 4300 + index * 0.8
            m15.append(candle(start + timedelta(minutes=15 * index), value - 0.2, value + 0.5, value - 0.5, value))
            h1.append(candle(start + timedelta(hours=index), value - 0.2, value + 0.5, value - 0.5, value))
        regime, direction = prefilter.classify_regime(m15, h1, 2.0)
        self.assertEqual((regime, direction), ("TREND", "BUY"))

    def test_daily_pl_uses_vn_day_and_open_profit(self):
        current = datetime(2026, 8, 18, 9, 0, tzinfo=prefilter.VN)
        deals = {
            "deals": [
                {"time": "2026-08-18T01:00:00Z", "net_profit": 12.5},
                {"time": "2026-08-17T01:00:00Z", "net_profit": 99},
            ]
        }
        orders = {"orders": [{"state": "FILLED", "profit": -2.0}, {"state": "PENDING", "profit": 20}]}
        self.assertAlmostEqual(prefilter.daily_pl(deals, orders, current), 10.5)

    def test_direct_candidate_is_not_latched_for_codex_review(self):
        current = datetime(2026, 8, 18, 9, 15, tzinfo=prefilter.VN)
        existing = prefilter.base_packet(current - timedelta(minutes=4), "CANDIDATE", "test")
        existing["candidate"] = {"signature": "BUY|TREND|4400.0"}
        with tempfile.TemporaryDirectory() as temp:
            old_path = prefilter.PACKET_PATH
            try:
                prefilter.PACKET_PATH = Path(temp) / "packet.json"
                prefilter.atomic_json(prefilter.PACKET_PATH, existing)
                incoming = prefilter.base_packet(current, "NO_SIGNAL", "temporary no trigger")
                kept = prefilter.keep_unreviewed_candidate(incoming, current, {})
                self.assertEqual(kept["status"], "NO_SIGNAL")
                self.assertEqual(kept["reason"], "temporary no trigger")
            finally:
                prefilter.PACKET_PATH = old_path

    def test_map_review_is_latched_for_dispatch_retry(self):
        current = datetime(2026, 8, 18, 16, 34, 3, tzinfo=prefilter.VN)
        with tempfile.TemporaryDirectory() as temp:
            old_path = prefilter.PACKET_PATH
            try:
                prefilter.PACKET_PATH = Path(temp) / "packet.json"
                existing = prefilter.map_review_packet(
                    current - timedelta(minutes=3), {}, {"status": "NO_SIGNAL", "reason": "waiting"}
                )
                prefilter.atomic_json(prefilter.PACKET_PATH, existing)
                incoming = prefilter.base_packet(current, "NO_SIGNAL", "next scan")
                kept = prefilter.keep_unreviewed_candidate(incoming, current, {})
                self.assertEqual(kept["status"], "MAP_REVIEW_REQUIRED")
            finally:
                prefilter.PACKET_PATH = old_path

    def test_reviewed_map_packet_releases_next_zone_event(self):
        current = datetime(2026, 8, 18, 16, 4, 3, tzinfo=prefilter.VN)
        signature = prefilter.map_review_signature(current)
        with tempfile.TemporaryDirectory() as temp:
            old_path = prefilter.PACKET_PATH
            try:
                prefilter.PACKET_PATH = Path(temp) / "packet.json"
                existing = prefilter.map_review_packet(
                    current - timedelta(minutes=2), {}, {"status": "NO_SIGNAL", "reason": "waiting"}
                )
                prefilter.atomic_json(prefilter.PACKET_PATH, existing)
                incoming = prefilter.base_packet(current, "ZONE_APPROACH", "price reached zone")
                kept = prefilter.keep_unreviewed_candidate(
                    incoming,
                    current,
                    {"lastPrefilterReviewedSignature": signature},
                )
                self.assertEqual(kept["status"], "ZONE_APPROACH")
                self.assertEqual(kept["reason"], "price reached zone")
            finally:
                prefilter.PACKET_PATH = old_path

    def test_stale_remap_packet_is_dropped_after_plan_id_changes(self):
        current = datetime(2026, 8, 18, 9, 31, tzinfo=prefilter.VN)
        with tempfile.TemporaryDirectory() as temp:
            old_packet = prefilter.PACKET_PATH
            old_watch = prefilter.WATCH_PLAN_PATH
            try:
                prefilter.PACKET_PATH = Path(temp) / "packet.json"
                prefilter.WATCH_PLAN_PATH = Path(temp) / "watch.json"
                prefilter.atomic_json(prefilter.PACKET_PATH, {
                    "status": "REMAP_REQUIRED",
                    "generatedAt": prefilter.iso(current),
                    "expiresAt": prefilter.iso(current + timedelta(minutes=7)),
                    "remap": {
                        "planId": "old-plan",
                        "signature": "old-plan|FAVORABLE_DISPLACEMENT|m15",
                    },
                })
                prefilter.atomic_json(prefilter.WATCH_PLAN_PATH, {
                    "plans": [{"planId": "new-plan", "status": "ACTIVE", "priority": 1}],
                })
                incoming = prefilter.base_packet(current, "NO_SIGNAL", "new plan is watching")

                kept = prefilter.keep_unreviewed_candidate(incoming, current, {})

                self.assertEqual(kept["status"], "NO_SIGNAL")
                self.assertEqual(kept["reason"], "new plan is watching")
            finally:
                prefilter.PACKET_PATH = old_packet
                prefilter.WATCH_PLAN_PATH = old_watch

    def test_audit_record_is_codex_like_but_uses_no_quota(self):
        current = datetime(2026, 8, 18, 11, 48, tzinfo=prefilter.VN)
        value = prefilter.base_packet(current, "NO_SIGNAL", "no closed trigger")
        value.update({
            "dailyPlUsd": 0.0,
            "diagnostics": {
                "regime": "RANGE",
                "latestClosedM5": "2026-08-18T11:40:00+07:00",
                "bid": 4393.4,
                "ask": 4393.7,
                "spread": 0.3,
                "triggerDirection": "BUY",
                "triggerLabels": ["bullish displacement"],
                "volumeRatio": 0.78,
            },
        })
        record = prefilter.audit_record(value)
        self.assertEqual(record["decision"], "NO_TRADE")
        self.assertEqual(record["regime"], "RANGE")
        self.assertFalse(record["llmCalled"])
        self.assertFalse(record["quotaUsed"])
        self.assertIn("NO_TRADE", record["conclusion"])

    def test_watch_plan_wakes_once_when_price_approaches_zone(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        state = {"version": 1, "plans": {}}
        result = prefilter.evaluate_watch_plans(watch_snapshot(current), current, sell_watch_plan(current), state)
        self.assertEqual(result["status"], "ZONE_APPROACH")
        self.assertEqual(result["watchState"], "ARMED")
        self.assertEqual(result["proximity"]["kind"], "ENTRY_WINDOW_OPEN")
        self.assertEqual(state["plans"]["sell-upper-edge"]["status"], "ARMED")

    def test_watch_plan_emits_approach_then_touch_once_each(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        state = {"version": 1, "plans": {}}
        near = watch_snapshot(current)
        near.update({"bid": 111.35, "ask": 111.60})
        first = prefilter.evaluate_watch_plans(near, current, sell_watch_plan(current), state)
        self.assertEqual(first["status"], "ZONE_APPROACH")
        self.assertEqual(first["proximity"]["kind"], "SETUP_ARMED")
        self.assertTrue(first["proximity"]["signature"].endswith("|APPROACH"))

        inside = watch_snapshot(current)
        second = prefilter.evaluate_watch_plans(inside, current, sell_watch_plan(current), state)
        third = prefilter.evaluate_watch_plans(inside, current, sell_watch_plan(current), state)
        self.assertEqual(second["status"], "ZONE_APPROACH")
        self.assertEqual(second["proximity"]["kind"], "ENTRY_WINDOW_OPEN")
        self.assertTrue(second["proximity"]["signature"].endswith("|TOUCH"))
        self.assertEqual(third["status"], "NO_SIGNAL")

    def test_zone_telegram_uses_helper_and_clear_multiline_warning(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        packet = prefilter.evaluate_watch_plans(
            watch_snapshot(current), current, sell_watch_plan(current),
            {"version": 1, "plans": {}},
        )
        completed = mock.Mock(returncode=0, stdout='{"ok":true,"messageId":123}', stderr="")
        with mock.patch.object(prefilter.subprocess, "run", return_value=completed) as runner:
            result = prefilter.send_zone_telegram(packet, current)
        command = runner.call_args.args[0]
        message = command[command.index("--message") + 1]
        self.assertEqual(result["zoneTelegram"]["status"], "VERIFIED")
        self.assertTrue(message.startswith("WATCH PLAN XAUUSDm\n\nLOẠI: ENTRY WINDOW OPEN"))
        self.assertIn("CHƯA PHẢI LỆNH SELL MARKET", message)
        self.assertIn("Mức vô hiệu: 111.000", message)
        self.assertIn("SL cấu trúc dự kiến: 111.000", message)
        self.assertIn("ZONE|", command[command.index("--signature") + 1])

    def test_candidate_is_sent_directly_with_full_manual_signal(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        packet = prefilter.base_packet(current, "CANDIDATE", "closed M5 trigger")
        packet["candidate"] = {
            "signature": "plan-a|SELL|RETEST_HOLD|M5|09:00",
            "planId": "plan-a", "direction": "SELL", "orderTypeHint": "LIMIT",
            "entry": 110.0, "stopLoss": 112.0, "conservativeTakeProfit": 107.5,
            "rrAfterCost": 1.15, "qualityGrade": "C", "qualityLayersPassed": 5,
            "qualityLayers": [{"name": "x", "passed": True}],
            "signalTier": "CONFIRMED_M5", "limitExpiresAt": prefilter.iso(current + timedelta(minutes=15)),
            "triggerCandle": {"timeframe": "M5"}, "triggerLabels": ["bearish directional close"],
        }
        completed = mock.Mock(returncode=0, stdout='{"ok":true,"messageId":321}', stderr="")

        with mock.patch.object(prefilter.subprocess, "run", return_value=completed) as runner:
            result = prefilter.send_candidate_telegram(packet, current)

        command = runner.call_args.args[0]
        message = command[command.index("--message") + 1]
        self.assertEqual(result["directSignal"]["status"], "VERIFIED")
        self.assertFalse(result["codexReviewRequired"])
        self.assertTrue(message.startswith("TÍN HIỆU XAUUSDm - CONFIRMED"))
        self.assertIn("Lệnh: SELL LIMIT", message)
        self.assertIn("SL CHÍNH THỨC: 112.000", message)
        self.assertIn("Bạn tự đặt lệnh", message)
        self.assertTrue(command[command.index("--signature") + 1].startswith("SIGNAL|"))

    def test_candidate_and_zone_do_not_request_codex_review(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        self.assertFalse(prefilter.base_packet(current, "CANDIDATE", "x")["codexReviewRequired"])
        self.assertFalse(prefilter.base_packet(current, "ZONE_APPROACH", "x")["codexReviewRequired"])
        self.assertTrue(prefilter.base_packet(current, "MAP_REVIEW_REQUIRED", "x")["codexReviewRequired"])

    def test_watch_plan_closed_m5_trigger_creates_unique_candidate(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        state = {"version": 1, "plans": {}}
        result = prefilter.evaluate_watch_plans(watch_snapshot(current, triggering=True), current, sell_watch_plan(current), state)
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["watchState"], "TRIGGERED")
        self.assertIn("sell-upper-edge|SELL|REJECTION|M5|", result["candidate"]["signature"])
        self.assertEqual(result["candidate"]["triggerCandle"]["timeframe"], "M5")
        self.assertGreaterEqual(result["candidate"]["rrAfterCost"], 1.6)

    def test_mapped_trigger_accepts_clear_directional_close_without_textbook_pattern(self):
        at = datetime(2026, 8, 18, 9, 0, tzinfo=prefilter.VN)
        previous = candle(at - timedelta(minutes=5), 100.0, 101.0, 99.0, 100.4)
        latest = candle(at, 100.6, 101.15, 100.15, 101.05)

        direction, labels = prefilter.trigger_direction(latest, previous, atr_m5=2.0)

        self.assertEqual(direction, "BUY")
        self.assertIn("bullish directional close", labels)

    def test_mapped_trigger_accepts_touch_then_next_m5_continuation(self):
        current = datetime(2026, 8, 18, 9, 5, tzinfo=prefilter.VN)
        plan = sell_watch_plan(current)["plans"][0]
        rows = [
            candle(current - timedelta(minutes=10), 107.0, 108.0, 106.5, 107.4),
            candle(current - timedelta(minutes=5), 109.5, 110.2, 108.8, 109.4),
            candle(current, 108.8, 108.9, 107.4, 107.7),
        ]

        matched, labels = prefilter.watch_trigger_matches(plan, rows, atr_m5=2.0)

        self.assertTrue(matched)
        self.assertTrue(labels)

    def test_transition_retest_may_enable_early_m1_timing(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        plan = sell_watch_plan(current)["plans"][0]
        plan["regime"] = "TRANSITION_BEARISH_PULLBACK"
        plan["trigger"].update({"mode": "RETEST_HOLD", "entryPolicy": "EARLY_ALLOWED"})

        self.assertEqual(prefilter.normalized_entry_policy(plan), "EARLY_ALLOWED")

    def test_directional_trend_defaults_to_direct_m1_timing(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        document["plans"][0]["regime"] = "TREND_BEARISH_PULLBACK"
        snapshot = watch_snapshot(current)
        snapshot["candles"]["M1"] = watch_snapshot(current, triggering=True)["candles"]["M1"]
        result = prefilter.evaluate_watch_plans(snapshot, current, document, {"version": 1, "plans": {}})
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["candidate"]["triggerCandle"]["timeframe"], "M1")

    def test_explicit_m5_policy_overrides_fast_default(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        plan = sell_watch_plan(current)["plans"][0]
        plan["regime"] = "TREND_BEARISH_PULLBACK"
        plan["trigger"]["entryPolicy"] = "M5_REQUIRED"
        self.assertEqual(prefilter.normalized_entry_policy(plan), "M5_REQUIRED")

    def test_two_candle_retest_counts_location_in_candidate_quality(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        snapshot = watch_snapshot(current, triggering=True)
        snapshot["candles"]["M5"][-2].update({"open": 109.5, "high": 110.2, "low": 108.8, "close": 109.4})
        snapshot["candles"]["M5"][-1].update({"open": 108.8, "high": 108.9, "low": 107.4, "close": 107.7})
        result = prefilter.evaluate_watch_plans(snapshot, current, document, {"version": 1, "plans": {}})
        self.assertEqual(result["status"], "CANDIDATE")
        location = next(item for item in result["candidate"]["qualityLayers"] if item["name"] == "mapped_location")
        self.assertTrue(location["passed"])

    def test_breakout_retest_m1_timing_only_works_after_closed_m5_breakout(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        plan = sell_watch_plan(current)["plans"][0]
        plan["regime"] = "TRANSITION_BEARISH_CORRECTION"
        plan["trigger"].update({"mode": "BREAKOUT_RETEST", "entryPolicy": "EARLY_ALLOWED"})
        snapshot = watch_snapshot(current, triggering=True)
        snapshot["candles"]["M1"][-1].update({"close": 108.7, "volume": 1400})
        rows = [prefilter.candle_from(row) for row in snapshot["candles"]["M1"]]
        atr1 = prefilter.atr(rows)
        latest_at = rows[-1].time

        before_breakout_close = prefilter.fast_m1_trigger_matches(
            plan, rows, atr1, breakout_after=latest_at + timedelta(minutes=1),
        )
        after_breakout_close = prefilter.fast_m1_trigger_matches(
            plan, rows, atr1, breakout_after=latest_at - timedelta(minutes=1),
        )

        self.assertFalse(before_breakout_close[0])
        self.assertTrue(after_breakout_close[0])
        self.assertEqual(prefilter.normalized_entry_policy(plan), "EARLY_ALLOWED")

    def test_breakout_retest_latch_survives_more_than_three_m5_candles(self):
        current = datetime(2026, 8, 18, 9, 30, tzinfo=prefilter.VN)
        plan = sell_watch_plan(current)["plans"][0]
        plan["trigger"]["mode"] = "BREAKOUT_RETEST"
        rows = [
            candle(current - timedelta(minutes=20), 107.0, 107.5, 106.0, 106.5),
            candle(current - timedelta(minutes=15), 106.5, 107.0, 105.5, 106.0),
            candle(current - timedelta(minutes=10), 106.0, 107.2, 105.8, 106.8),
            candle(current - timedelta(minutes=5), 106.8, 110.2, 106.5, 108.0),
            candle(current, 109.8, 110.4, 107.8, 108.2),
        ]

        matched, labels = prefilter.watch_trigger_matches(
            plan, rows, atr_m5=2.0, breakout_seen=True,
        )

        self.assertTrue(matched)
        self.assertTrue(labels)

    def test_grade_b_candidate_allows_rr_above_1_2_with_quality_layers(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        document["plans"][0]["risk"].update({
            "minRrAfterCost": 1.2,
            "conservativeTakeProfit": 105.5,
        })
        result = prefilter.evaluate_watch_plans(
            watch_snapshot(current, triggering=True), current, document,
            {"version": 1, "plans": {}},
        )
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["candidate"]["qualityGrade"], "B")
        self.assertGreaterEqual(result["candidate"]["rrAfterCost"], 1.2)
        self.assertGreaterEqual(result["candidate"]["qualityLayersPassed"], 4)
        momentum = next(
            layer for layer in result["candidate"]["qualityLayers"]
            if layer["name"] == "momentum_volume"
        )
        self.assertTrue(momentum["passed"])

    def test_grade_c_candidate_allows_rr_near_one_with_all_quality_layers(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        document["plans"][0]["risk"].update({
            "minRrAfterCost": 1.0,
            "conservativeTakeProfit": 106.0,
        })
        result = prefilter.evaluate_watch_plans(
            watch_snapshot(current, triggering=True), current, document,
            {"version": 1, "plans": {}},
        )
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["candidate"]["qualityGrade"], "C")
        self.assertGreaterEqual(result["candidate"]["rrAfterCost"], 1.0)
        self.assertLess(result["candidate"]["rrAfterCost"], 1.2)
        self.assertEqual(result["candidate"]["qualityLayersPassed"], 5)

    def test_closed_trigger_can_become_short_lived_confirmed_limit_when_market_rr_is_late(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        document["plans"][0]["risk"]["minRrAfterCost"] = 1.0
        snapshot = watch_snapshot(current, triggering=True)
        snapshot.update({"bid": 105.0, "ask": 105.25, "spread": 0.25})

        result = prefilter.evaluate_watch_plans(
            snapshot, current, document, {"version": 1, "plans": {}},
        )

        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["candidate"]["orderTypeHint"], "LIMIT")
        self.assertEqual(result["candidate"]["entry"], 110.0)
        self.assertIsNotNone(result["candidate"]["limitExpiresAt"])
        self.assertGreaterEqual(result["candidate"]["rrAfterCost"], 1.0)

    def test_watch_plan_does_not_retrigger_same_closed_m5(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        state = {"version": 1, "plans": {}}
        first = prefilter.evaluate_watch_plans(watch_snapshot(current, triggering=True), current, sell_watch_plan(current), state)
        second = prefilter.evaluate_watch_plans(watch_snapshot(current, triggering=True), current, sell_watch_plan(current), state)
        self.assertEqual(first["status"], "CANDIDATE")
        self.assertEqual(second["status"], "NO_SIGNAL")
        self.assertIn("already evaluated", second["reason"])

    def test_invalidated_plan_requests_one_remap_wake(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        snapshot = watch_snapshot(current)
        snapshot["candles"]["M5"][-1].update({
            "open": 110.2, "high": 112.4, "low": 109.8, "close": 111.5,
        })
        state = {"version": 1, "plans": {}}
        first = prefilter.evaluate_watch_plans(snapshot, current, document, state)
        second = prefilter.evaluate_watch_plans(snapshot, current, document, state)
        self.assertEqual(first["status"], "REMAP_REQUIRED")
        self.assertEqual(first["watchState"], "INVALIDATED")
        self.assertIn("sell-upper-edge|INVALIDATED|", first["remap"]["signature"])
        self.assertEqual(second["status"], "NO_SIGNAL")
        self.assertIn("already emitted", second["reason"])

    def test_invalidated_plan_cannot_reactivate_on_later_close(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        state = {
            "version": 1,
            "plans": {
                "sell-upper-edge": {
                    "status": "INVALIDATED",
                    "invalidatedByClosedM5": "2026-08-18T08:50:00+07:00",
                    "remapWakeClosedM5": "2026-08-18T08:50:00+07:00",
                }
            },
        }
        result = prefilter.evaluate_watch_plans(
            watch_snapshot(current, triggering=True), current, document, state,
        )
        self.assertEqual(result["status"], "NO_SIGNAL")
        self.assertEqual(result["watchState"], "INVALIDATED")
        self.assertIn("remains invalidated", result["reason"])

    def test_closed_m15_favorable_displacement_requests_one_remap(self):
        current = datetime(2026, 8, 18, 9, 31, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        plan = document["plans"][0]
        plan.update({"direction": "BUY", "thesis": "bullish pullback"})
        plan["generatedAt"] = prefilter.iso(current - timedelta(minutes=20))
        plan["zone"] = {"low": 100.0, "high": 101.0, "proximityAtr": 0.35}
        plan["risk"].update({
            "invalidationPrice": 99.0,
            "firstBarrier": 105.0,
            "conservativeTakeProfit": 104.5,
        })
        snapshot = with_closed_m15(watch_snapshot(current), current, close=109.0)
        state = {"version": 1, "plans": {}}

        first = prefilter.evaluate_watch_plans(snapshot, current, document, state)
        second = prefilter.evaluate_watch_plans(snapshot, current, document, state)

        self.assertEqual(first["status"], "REMAP_REQUIRED")
        self.assertEqual(first["watchState"], "FAVORABLE_DISPLACEMENT")
        self.assertEqual(first["remap"]["kind"], "FAVORABLE_DISPLACEMENT")
        self.assertTrue(first["remap"]["firstBarrierBroken"])
        self.assertIn("|FAVORABLE_DISPLACEMENT|", first["remap"]["signature"])
        self.assertEqual(second["status"], "NO_SIGNAL")

    def test_favorable_displacement_latch_resets_after_m15_returns(self):
        current = datetime(2026, 8, 18, 9, 31, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        plan = document["plans"][0]
        plan.update({"direction": "BUY", "thesis": "bullish pullback"})
        plan["generatedAt"] = prefilter.iso(current - timedelta(minutes=20))
        plan["zone"] = {"low": 100.0, "high": 101.0, "proximityAtr": 0.35}
        plan["risk"].update({
            "invalidationPrice": 99.0,
            "firstBarrier": 105.0,
            "conservativeTakeProfit": 104.5,
        })
        state = {"version": 1, "plans": {}}
        far = with_closed_m15(watch_snapshot(current), current, close=109.0)
        prefilter.evaluate_watch_plans(far, current, document, state)

        returned_at = current + timedelta(minutes=15)
        returned = with_closed_m15(watch_snapshot(returned_at), returned_at, close=101.2)
        prefilter.evaluate_watch_plans(returned, returned_at, document, state)
        record = state["plans"]["sell-upper-edge"]

        self.assertNotIn("favorableDisplacementWakeClosedM15", record)

    def test_m15_already_forming_when_plan_created_cannot_wake_displacement(self):
        current = datetime(2026, 8, 18, 9, 31, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        plan = document["plans"][0]
        plan.update({"direction": "BUY", "thesis": "bullish pullback"})
        plan["generatedAt"] = prefilter.iso(current - timedelta(minutes=10))
        plan["zone"] = {"low": 100.0, "high": 101.0, "proximityAtr": 0.35}
        plan["risk"].update({
            "invalidationPrice": 99.0,
            "firstBarrier": 105.0,
            "conservativeTakeProfit": 104.5,
        })
        snapshot = with_closed_m15(watch_snapshot(current), current, close=109.0)

        result = prefilter.evaluate_watch_plans(
            snapshot, current, document, {"version": 1, "plans": {}},
        )

        self.assertEqual(result["status"], "NO_SIGNAL")
        self.assertNotEqual(result["watchState"], "FAVORABLE_DISPLACEMENT")

    def test_breakout_retest_waits_without_invalidating_before_breakout(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        plan = document["plans"][0]
        plan["direction"] = "BUY"
        plan["trigger"]["mode"] = "BREAKOUT_RETEST"
        plan["risk"]["invalidationPrice"] = 108.8
        snapshot = watch_snapshot(current)
        state = {"version": 1, "plans": {}}
        result = prefilter.evaluate_watch_plans(snapshot, current, document, state)
        self.assertEqual(result["status"], "ZONE_APPROACH")
        self.assertNotEqual(result["watchState"], "INVALIDATED")
        self.assertFalse(state["plans"]["sell-upper-edge"].get("breakoutSeen", False))

    def test_candidate_expires_seven_minutes_after_trigger_close(self):
        opening = datetime(2026, 8, 18, 9, 0, tzinfo=prefilter.VN)
        expires = prefilter.parse_time(prefilter.closed_m5_expiry(prefilter.iso(opening)))
        self.assertEqual(expires, opening + timedelta(minutes=12))

    def test_fast_candidate_expires_ninety_seconds_after_m1_close(self):
        opening = datetime(2026, 8, 18, 9, 0, tzinfo=prefilter.VN)
        expires = prefilter.parse_time(prefilter.closed_trigger_expiry(prefilter.iso(opening), "M1"))
        self.assertEqual(expires, opening + timedelta(minutes=2, seconds=30))

    def test_trend_pullback_can_create_early_m1_candidate(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        plan = document["plans"][0]
        plan["regime"] = "TREND_BEARISH_PULLBACK"
        plan["trigger"]["entryPolicy"] = "EARLY_ALLOWED"
        snapshot = watch_snapshot(current)
        snapshot["candles"]["M1"] = watch_snapshot(current, triggering=True)["candles"]["M1"]
        result = prefilter.evaluate_watch_plans(snapshot, current, document, {"version": 1, "plans": {}})
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["candidate"]["triggerCandle"]["timeframe"], "M1")
        self.assertEqual(result["candidate"]["signalTier"], "EARLY")

    def test_range_plan_cannot_enable_early_m1_candidate(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        document["plans"][0]["trigger"]["entryPolicy"] = "EARLY_ALLOWED"
        snapshot = watch_snapshot(current)
        snapshot["candles"]["M1"] = watch_snapshot(current, triggering=True)["candles"]["M1"]
        result = prefilter.evaluate_watch_plans(snapshot, current, document, {"version": 1, "plans": {}})
        self.assertNotEqual(result.get("candidate", {}).get("triggerCandle", {}).get("timeframe"), "M1")
        self.assertEqual(prefilter.normalized_entry_policy(document["plans"][0]), "M5_REQUIRED")

    def test_close_through_stays_on_closed_m5(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        plan = document["plans"][0]
        plan["trigger"]["mode"] = "CLOSE_THROUGH"
        plan["zone"] = {"low": 109.3, "high": 109.4, "proximityAtr": 0.35}
        snapshot = watch_snapshot(current, triggering=True)
        result = prefilter.evaluate_watch_plans(snapshot, current, document, {"version": 1, "plans": {}})
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["candidate"]["triggerCandle"]["timeframe"], "M5")

    def test_follow_scan_uses_one_minute_slot(self):
        current = datetime(2026, 8, 18, 9, 0, 3, tzinfo=prefilter.VN)
        self.assertAlmostEqual(prefilter.seconds_until_slot(current, prefilter.FOLLOW_SCAN_SECONDS), 60.0)

    def test_flat_scan_also_runs_every_minute(self):
        self.assertEqual(prefilter.SCAN_SECONDS, 60)
        current = datetime(2026, 8, 18, 9, 0, 3, tzinfo=prefilter.VN)
        self.assertAlmostEqual(prefilter.seconds_until_slot(current), 60.0)

    def test_broad_candidate_is_not_blinded_by_non_triggering_watch_plan(self):
        watch = {"status": "NO_SIGNAL", "watchState": "WATCHING", "reason": "waiting for zone"}
        broad = {"status": "CANDIDATE", "reason": "range rejection", "candidate": {"direction": "BUY"}}
        result = prefilter.select_entry_evaluation(watch, broad, True)
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["prefilterMode"], "BROAD_DISCOVERY")
        self.assertEqual(result["watchPlanObservation"]["watchState"], "WATCHING")

    def test_watch_candidate_keeps_priority_over_broad_candidate(self):
        watch = {"status": "CANDIDATE", "reason": "planned retest", "candidate": {"direction": "SELL"}}
        broad = {"status": "CANDIDATE", "reason": "broad rejection", "candidate": {"direction": "BUY"}}
        result = prefilter.select_entry_evaluation(watch, broad, True)
        self.assertEqual(result["candidate"]["direction"], "SELL")
        self.assertEqual(result["prefilterMode"], "WATCH_PLAN")

    def test_broad_fast_m1_rejection_at_closed_m5_structure_creates_candidate(self):
        current = datetime(2026, 8, 18, 10, 0, tzinfo=prefilter.VN)
        result = prefilter.evaluate_fast_structural_candidate(broad_fast_m1_snapshot(current), current)
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["candidate"]["direction"], "SELL")
        self.assertEqual(result["candidate"]["triggerCandle"]["timeframe"], "M1")
        self.assertGreaterEqual(result["candidate"]["rrAfterCost"], prefilter.BROAD_MIN_RR)

    def test_closed_m5_broad_candidate_keeps_priority_over_fast_m1(self):
        m5 = {"status": "CANDIDATE", "reason": "closed M5", "candidate": {"direction": "BUY"}}
        m1 = {"status": "CANDIDATE", "reason": "fast M1", "candidate": {"direction": "SELL"}}
        result = prefilter.select_broad_evaluation(m5, m1)
        self.assertEqual(result["candidate"]["direction"], "BUY")

    def test_fast_m1_broad_candidate_is_used_when_closed_m5_has_no_signal(self):
        m5 = {"status": "NO_SIGNAL", "reason": "no M5 alignment"}
        m1 = {"status": "CANDIDATE", "reason": "fast M1", "candidate": {"direction": "SELL"}}
        result = prefilter.select_broad_evaluation(m5, m1)
        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["broadM5Observation"]["reason"], "no M5 alignment")

    def test_daily_map_review_runs_after_every_closed_h1(self):
        current = datetime(2026, 8, 18, 16, 0, 3, tzinfo=prefilter.VN)
        self.assertAlmostEqual(prefilter.seconds_until_slot(current), 60.0)
        self.assertTrue(prefilter.is_map_review_slot(datetime(2026, 8, 18, 8, 1, 3, tzinfo=prefilter.VN)))
        self.assertTrue(prefilter.is_map_review_slot(datetime(2026, 8, 18, 14, 1, 3, tzinfo=prefilter.VN)))
        self.assertTrue(prefilter.is_map_review_slot(datetime(2026, 8, 18, 19, 1, 3, tzinfo=prefilter.VN)))
        self.assertTrue(prefilter.is_map_review_slot(datetime(2026, 8, 18, 16, 1, 3, tzinfo=prefilter.VN)))
        self.assertTrue(prefilter.is_map_review_slot(datetime(2026, 8, 18, 22, 1, 3, tzinfo=prefilter.VN)))
        self.assertTrue(prefilter.is_map_review_slot(datetime(2026, 8, 18, 16, 10, 3, tzinfo=prefilter.VN)))
        self.assertFalse(prefilter.is_map_review_slot(datetime(2026, 8, 18, 16, 11, 3, tzinfo=prefilter.VN)))
        self.assertFalse(prefilter.is_map_review_slot(datetime(2026, 8, 18, 23, 1, 3, tzinfo=prefilter.VN)))

    def test_map_review_packet_is_short_lived_and_unique_per_h1_close(self):
        current = datetime(2026, 8, 18, 16, 16, 3, tzinfo=prefilter.VN)
        packet = prefilter.map_review_packet(current, {"dailyPlUsd": 0.0}, {"status": "NO_SIGNAL", "reason": "waiting"})
        self.assertEqual(packet["status"], "MAP_REVIEW_REQUIRED")
        self.assertEqual(packet["mapReview"]["closedH1At"], "2026-08-18T16:00:00+07:00")
        self.assertEqual(packet["mapReview"]["signature"], "HOURLY_MAP_REVIEW|2026-08-18T16:00:00+07:00")
        self.assertEqual(prefilter.parse_time(packet["expiresAt"]), current + timedelta(minutes=7))

    def test_stale_news_cache_wakes_codex_instead_of_silent_blackout(self):
        current = datetime(2026, 8, 25, 9, 26, 3, tzinfo=prefilter.VN)
        packet = prefilter.news_refresh_packet(current, "news cache missing or stale")
        self.assertEqual(packet["status"], "MAP_REVIEW_REQUIRED")
        self.assertEqual(packet["mapReview"]["kind"], "NEWS_REFRESH_AND_MAP_REVIEW")
        self.assertEqual(packet["mapReview"]["signature"], "NEWS_REFRESH|2026-08-25")
        self.assertTrue(packet["mapReview"]["requiresNewsRefresh"])

    def test_zone_approach_is_not_overwritten_by_hourly_map_review(self):
        self.assertFalse(prefilter.should_emit_map_review(True, "ZONE_APPROACH"))
        self.assertFalse(prefilter.should_emit_map_review(True, "CANDIDATE"))
        self.assertFalse(prefilter.should_emit_map_review(True, "REMAP_REQUIRED"))
        self.assertTrue(prefilter.should_emit_map_review(True, "NO_SIGNAL"))

    def test_expired_watch_plan_fails_closed(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        document["plans"][0]["expiresAt"] = prefilter.iso(current - timedelta(seconds=1))
        result = prefilter.evaluate_watch_plans(watch_snapshot(current, triggering=True), current, document, {"plans": {}})
        self.assertEqual(result["status"], "NO_SIGNAL")
        self.assertEqual(result["watchState"], "EXPIRED")

    def test_descriptive_rejection_alias_is_monitorable(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        document = sell_watch_plan(current)
        document["plans"][0]["trigger"]["mode"] = "BEARISH_REJECTION_RETEST"
        self.assertEqual(prefilter.normalized_trigger_mode(document["plans"][0]), "REJECTION")
        self.assertNotIn("unsupported trigger mode", prefilter.validate_watch_plan(document["plans"][0], current))

    def test_auto_execution_is_always_disabled(self):
        current = datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN)
        plan = sell_watch_plan(current)["plans"][0]
        config, reason = prefilter.approved_execution(plan)
        self.assertIsNone(config)
        self.assertIn("disabled", reason)
        plan["execution"] = {
            "autoExecute": True, "orderType": "MARKET", "volume": 0.04,
            "maxEntryDriftAtr": 0.2, "maxTriggerAgeSeconds": 90,
        }
        config, reason = prefilter.approved_execution(plan)
        self.assertIsNone(config)
        self.assertIn("signal-only", reason)

    def test_bridge_posts_are_blocked_in_signal_only_mode(self):
        with self.assertRaises(RuntimeError):
            prefilter.post_json("/order", {"symbol": "XAUUSDm"})

    def test_broad_candidate_cannot_enter_auto_executor(self):
        packet = {
            "status": "CANDIDATE", "prefilterMode": "BROAD_M1_TIMING",
            "candidate": {"signature": "broad", "planId": "none"},
        }
        result = prefilter.try_auto_execute_watch_candidate(packet, {"plans": []}, datetime(2026, 8, 18, 9, 1, tzinfo=prefilter.VN))
        self.assertEqual(result["autoExecution"]["status"], "DISABLED_SIGNAL_ONLY")
        self.assertFalse(result["writesToMt5"])


if __name__ == "__main__":
    unittest.main()
