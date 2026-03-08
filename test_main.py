import json
import tempfile
import unittest
from pathlib import Path

import main


class EventStoreEncodingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_data_file = main.DATA_FILE
        main.DATA_FILE = Path(self.temp_dir.name) / "events.json"

    def tearDown(self) -> None:
        main.DATA_FILE = self.original_data_file
        self.temp_dir.cleanup()

    def test_save_uses_utf8(self) -> None:
        event = {"id": "1", "type": "issue_comment", "payload": {"body": "日本語"}, "processed": False}

        main._save([event])

        raw = main.DATA_FILE.read_bytes()
        self.assertIn("日本語".encode("utf-8"), raw)
        self.assertEqual(json.loads(raw.decode("utf-8")), [event])

    def test_load_reads_legacy_cp932_and_rewrites_utf8(self) -> None:
        event = {"id": "1", "type": "issue_comment", "payload": {"body": "日本語"}, "processed": False}
        legacy_text = json.dumps([event], ensure_ascii=False, indent=2)
        main.DATA_FILE.write_bytes(legacy_text.encode("cp932"))

        loaded = main._load()

        self.assertEqual(loaded, [event])
        self.assertEqual(json.loads(main.DATA_FILE.read_text(encoding="utf-8")), [event])


class EventSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_data_file = main.DATA_FILE
        main.DATA_FILE = Path(self.temp_dir.name) / "events.json"

    def tearDown(self) -> None:
        main.DATA_FILE = self.original_data_file
        self.temp_dir.cleanup()

    def test_pending_status_and_summaries_are_lightweight(self) -> None:
        main.add_event(
            "issues",
            {
                "action": "opened",
                "repository": {"full_name": "Liplus-Project/liplus-language"},
                "sender": {"login": "smileygames"},
                "issue": {
                    "number": 624,
                    "title": "test",
                    "html_url": "https://github.com/Liplus-Project/liplus-language/issues/624",
                },
            },
        )
        main.add_event(
            "workflow_run",
            {
                "action": "completed",
                "repository": {"full_name": "Liplus-Project/liplus-language"},
                "sender": {"login": "github-actions"},
                "workflow_run": {"name": "Governance CI", "html_url": "https://example.invalid/run"},
            },
        )

        status = main.get_pending_status()
        summaries = main.get_pending_summaries(limit=10)

        self.assertEqual(status["pending_count"], 2)
        self.assertEqual(status["types"], {"issues": 1, "workflow_run": 1})
        self.assertEqual(len(summaries), 2)
        self.assertEqual(summaries[0]["number"], 624)
        self.assertEqual(summaries[0]["title"], "test")
        self.assertEqual(summaries[1]["title"], "Governance CI")
        self.assertNotIn("payload", summaries[0])

    def test_get_event_returns_full_payload(self) -> None:
        event = main.add_event(
            "issues",
            {
                "action": "opened",
                "repository": {"full_name": "Liplus-Project/liplus-language"},
                "issue": {"number": 624, "title": "test"},
            },
        )

        stored = main.get_event(event["id"])

        self.assertIsNotNone(stored)
        self.assertEqual(stored["payload"]["issue"]["number"], 624)


class EventProfileTests(unittest.TestCase):
    def test_notifications_profile_keeps_issue_and_ci_events(self) -> None:
        self.assertTrue(
            main.should_store_event(
                "issues",
                {"action": "opened"},
                "notifications",
            )
        )
        self.assertTrue(
            main.should_store_event(
                "workflow_run",
                {"action": "completed"},
                "notifications",
            )
        )

    def test_notifications_profile_drops_non_notification_events(self) -> None:
        self.assertFalse(
            main.should_store_event(
                "workflow_job",
                {"action": "completed"},
                "notifications",
            )
        )
        self.assertFalse(
            main.should_store_event(
                "issue_comment",
                {"action": "edited"},
                "notifications",
            )
        )

    def test_all_profile_keeps_everything(self) -> None:
        self.assertTrue(
            main.should_store_event(
                "workflow_job",
                {"action": "completed"},
                "all",
            )
        )


if __name__ == "__main__":
    unittest.main()
