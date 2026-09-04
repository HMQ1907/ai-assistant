import importlib.util
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "codex-thread-wake-server.py"
SPEC = importlib.util.spec_from_file_location("codex_thread_wake_server", SCRIPT)
wake = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = wake
SPEC.loader.exec_module(wake)


def packet(status="CANDIDATE", signature="SELL|RANGE|4336.0"):
    current = datetime.now(wake.VN)
    return {
        "generatedAt": wake.iso(current),
        "expiresAt": wake.iso(current + timedelta(minutes=20)),
        "status": status,
        "symbol": "XAUUSDm",
        "candidate": {"signature": signature, "direction": "SELL"},
    }


class WakeServerTests(unittest.TestCase):
    def test_subprocess_does_not_share_desktop_thread_database(self):
        old = os.environ.get("CODEX_SQLITE_HOME")
        os.environ["CODEX_SQLITE_HOME"] = "should-be-removed"
        try:
            environment = wake.codex_subprocess_env()
            self.assertNotIn("CODEX_SQLITE_HOME", environment)
        finally:
            if old is None:
                os.environ.pop("CODEX_SQLITE_HOME", None)
            else:
                os.environ["CODEX_SQLITE_HOME"] = old

    def test_candidate_identity_is_stable(self):
        key, ttl = wake.event_identity(packet())
        self.assertEqual(key, "candidate:SELL|RANGE|4336.0")
        self.assertEqual(ttl, 45 * 60)

    def test_zone_approach_identity_is_stable(self):
        value = packet("ZONE_APPROACH")
        value["proximity"] = {"signature": "plan-a|2026-08-18|4400-4402|APPROACH"}
        key, ttl = wake.event_identity(value)
        self.assertEqual(key, "zone:plan-a|2026-08-18|4400-4402|APPROACH")
        self.assertEqual(ttl, 4 * 60 * 60)

    def test_follow_identity_contains_ticket(self):
        value = packet("FOLLOW_REQUIRED")
        value["activeOrders"] = [{"ticket": 12345}]
        value["follow"] = {"kind": "ORDER_STATE", "signature": "12345|PENDING"}
        key, ttl = wake.event_identity(value)
        self.assertEqual(key, "follow:12345|PENDING")
        self.assertEqual(ttl, 45 * 60)

    def test_follow_closed_m5_uses_signature_and_protect_retries_fast(self):
        value = packet("FOLLOW_REQUIRED")
        value["follow"] = {
            "kind": "FILLED_M5_REVIEW",
            "signature": "12345|FILLED_M5_REVIEW|2026-08-18T09:00:00+07:00",
        }
        key, ttl = wake.event_identity(value)
        self.assertIn("FILLED_M5_REVIEW", key)
        self.assertEqual(ttl, 45 * 60)
        value["follow"] = {"kind": "PROTECT_0_8R", "signature": "12345|PROTECT_0_8R"}
        key, ttl = wake.event_identity(value)
        self.assertEqual(key, "follow:12345|PROTECT_0_8R")
        self.assertEqual(ttl, 3 * 60)

    def test_remap_identity_is_stable(self):
        value = packet("REMAP_REQUIRED")
        value["remap"] = {"signature": "plan-a|INVALIDATED|2026-08-18T09:00:00+07:00"}
        key, ttl = wake.event_identity(value)
        self.assertEqual(key, "remap:plan-a|INVALIDATED|2026-08-18T09:00:00+07:00")
        self.assertEqual(ttl, 60 * 60)

    def test_map_review_identity_is_unique_per_m15_close(self):
        first = packet("MAP_REVIEW_REQUIRED")
        first["mapReview"] = {"signature": "M15_MAP_REVIEW|2026-08-18T16:15:00+07:00"}
        second = packet("MAP_REVIEW_REQUIRED")
        second["mapReview"] = {"signature": "M15_MAP_REVIEW|2026-08-18T16:30:00+07:00"}
        self.assertNotEqual(wake.event_identity(first)[0], wake.event_identity(second)[0])
        self.assertIn("MAP_REVIEW_REQUIRED", wake.build_prompt(first))

    def test_stale_packet_is_rejected(self):
        value = packet()
        value["expiresAt"] = wake.iso(datetime.now(wake.VN) - timedelta(seconds=1))
        self.assertFalse(wake.packet_is_fresh(value))

    def test_prompt_marks_prefilter_review(self):
        prompt = wake.build_prompt(packet())
        self.assertIn("lastPrefilterReviewedSignature", prompt)
        self.assertIn("SIGNAL-ONLY", prompt)
        self.assertIn("send-codex-xau-signal.py", prompt)
        self.assertIn("codex-xau-watch-plan.json", prompt)
        self.assertIn("local watcher đã gửi", prompt)
        self.assertIn("Grade B", prompt)
        self.assertIn("testOnly", prompt)
        self.assertIn("DUY NHẤT 1 plan ACTIVE", prompt)
        self.assertIn("GIỮ NGUYÊN PLAN CŨ", prompt)
        self.assertIn("Không tạo vùng dự phòng thứ hai", prompt)
        self.assertIn("ENTRY_WINDOW_OPEN phải được xử lý như một quyết định giao dịch ngay", prompt)
        self.assertIn("TÍN HIỆU SỚM", prompt)
        self.assertIn("RR sau chi phí >=1.00", prompt)
        self.assertIn("risk.minRrAfterCost=1.00", prompt)
        self.assertIn("Grade C", prompt)
        self.assertIn("không ép mọi plan thành 1.60", prompt)
        self.assertIn("trigger.mode phải là CHÍNH XÁC", prompt)
        self.assertIn("trigger.entryPolicy", prompt)
        self.assertIn("EARLY/HIGHER RISK", prompt)
        self.assertIn("mapReview.requiresNewsRefresh=true", prompt)
        self.assertIn("packet.mapReview.signature", prompt)

    def test_active_writer_conflict_detection(self):
        self.assertTrue(wake.is_active_writer_conflict("thread already has an active writer"))
        self.assertTrue(wake.is_active_writer_conflict("THREAD-STORE CONFLICT"))
        self.assertFalse(wake.is_active_writer_conflict("network timeout"))

    def test_watch_plan_signature_dedupes_only_same_closed_m5(self):
        first = packet(signature="plan-a|BUY|RETEST_HOLD|2026-08-18T09:00:00+07:00")
        second = packet(signature="plan-a|BUY|RETEST_HOLD|2026-08-18T09:05:00+07:00")
        self.assertNotEqual(wake.event_identity(first)[0], wake.event_identity(second)[0])

    def test_coordinator_ignores_direct_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            old_state, old_events, old_log = wake.STATE_PATH, wake.EVENTS_PATH, wake.LOG_PATH
            try:
                wake.STATE_PATH = Path(temp) / "state.json"
                wake.EVENTS_PATH = Path(temp) / "events.jsonl"
                wake.LOG_PATH = Path(temp) / "wake.log"
                coordinator = wake.WakeCoordinator(dry_run=True)
                first = coordinator.submit(packet(), "test")
                second = coordinator.submit(packet(), "test")
                self.assertFalse(first[0])
                self.assertFalse(second[0])
                self.assertEqual(first[1], "ignored_status")
                self.assertEqual(second[1], "ignored_status")
            finally:
                wake.STATE_PATH, wake.EVENTS_PATH, wake.LOG_PATH = old_state, old_events, old_log


if __name__ == "__main__":
    unittest.main()
