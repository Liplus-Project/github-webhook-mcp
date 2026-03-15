import asyncio
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


class TriggerCommandParsingTests(unittest.TestCase):
    def test_resolve_trigger_command_reads_env_string(self) -> None:
        command = main.resolve_trigger_command(
            'python codex_reaction.py --workspace C:\\Users\\smile\\Codex',
            None,
        )

        self.assertEqual(
            command,
            ["python", "codex_reaction.py", "--workspace", "C:\\Users\\smile\\Codex"],
        )

    def test_resolve_trigger_command_accepts_cli_remainder_tokens(self) -> None:
        command = main.resolve_trigger_command(
            "",
            [
                "C:\\Python312\\python.exe",
                "C:\\Users\\smile\\github-webhook-mcp\\codex_reaction.py",
                "--workspace",
                "C:\\Users\\smile\\Codex",
            ],
        )

        self.assertEqual(
            command,
            [
                "C:\\Python312\\python.exe",
                "C:\\Users\\smile\\github-webhook-mcp\\codex_reaction.py",
                "--workspace",
                "C:\\Users\\smile\\Codex",
            ],
        )


class TriggerExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_data_file = main.DATA_FILE
        self.original_trigger_dir = main.TRIGGER_EVENTS_DIR
        main.DATA_FILE = Path(self.temp_dir.name) / "events.json"
        main.TRIGGER_EVENTS_DIR = Path(self.temp_dir.name) / "trigger-events"

    async def asyncTearDown(self) -> None:
        main.DATA_FILE = self.original_data_file
        main.TRIGGER_EVENTS_DIR = self.original_trigger_dir
        self.temp_dir.cleanup()

    async def test_dispatcher_marks_successful_events_processed(self) -> None:
        calls: list[str] = []

        async def runner(command: list[str], event: dict, cwd: Path | None) -> None:
            self.assertEqual(command, ["codex", "exec"])
            self.assertIsNone(cwd)
            calls.append(event["id"])

        event_a = main.add_event("issues", {"action": "opened"})
        event_b = main.add_event("issues", {"action": "reopened"})
        dispatcher = main.TriggerDispatcher(["codex", "exec"], runner=runner)

        await dispatcher.start()
        await dispatcher.enqueue(event_a)
        await dispatcher.enqueue(event_b)
        await dispatcher.stop()

        self.assertEqual(calls, [event_a["id"], event_b["id"]])
        stored_a = main.get_event(event_a["id"])
        stored_b = main.get_event(event_b["id"])
        self.assertTrue(stored_a["processed"])
        self.assertTrue(stored_b["processed"])
        self.assertEqual(stored_a["trigger_status"], "succeeded")
        self.assertEqual(stored_b["trigger_status"], "succeeded")

    async def test_dispatcher_keeps_failed_events_pending(self) -> None:
        async def runner(command: list[str], event: dict, cwd: Path | None) -> None:
            raise RuntimeError("boom")

        event = main.add_event("issues", {"action": "opened"})
        dispatcher = main.TriggerDispatcher(["codex", "exec"], runner=runner)

        await dispatcher.start()
        await dispatcher.enqueue(event)
        await dispatcher.stop()

        stored = main.get_event(event["id"])
        self.assertFalse(stored["processed"])
        self.assertEqual(stored["trigger_status"], "failed")
        self.assertEqual(stored["trigger_error"], "boom")

    async def test_dispatcher_records_notify_only_fallback_as_skipped(self) -> None:
        async def runner(command: list[str], event: dict, cwd: Path | None) -> None:
            raise main.TriggerSkipped("notify-only fallback")

        event = main.add_event("issues", {"action": "opened"})
        dispatcher = main.TriggerDispatcher(["codex", "exec"], runner=runner)

        await dispatcher.start()
        await dispatcher.enqueue(event)
        await dispatcher.stop()

        stored = main.get_event(event["id"])
        self.assertFalse(stored["processed"])
        self.assertEqual(stored["trigger_status"], "skipped")
        self.assertEqual(stored["trigger_error"], "notify-only fallback")

    async def test_run_trigger_command_writes_event_file(self) -> None:
        captured: dict[str, str] = {}

        async def fake_create_subprocess_exec(*cmd, **kwargs):
            class FakeProcess:
                returncode = 0

                async def communicate(self, payload_bytes: bytes):
                    captured["stdin"] = payload_bytes.decode("utf-8")
                    captured["event_path"] = kwargs["env"]["GITHUB_WEBHOOK_EVENT_PATH"]
                    captured["event_type"] = kwargs["env"]["GITHUB_WEBHOOK_EVENT_TYPE"]
                    return b"", b""

            captured["command"] = " ".join(cmd)
            return FakeProcess()

        event = main.add_event("issues", {"action": "opened"})
        original = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_create_subprocess_exec
        try:
            await main.run_trigger_command(["codex", "exec"], event)
        finally:
            asyncio.create_subprocess_exec = original

        self.assertEqual(captured["command"], "codex exec")
        self.assertEqual(captured["event_type"], "issues")
        self.assertIn(event["id"], captured["stdin"])
        event_path = Path(captured["event_path"])
        self.assertTrue(event_path.exists())
        self.assertEqual(json.loads(event_path.read_text(encoding="utf-8"))["id"], event["id"])


if __name__ == "__main__":
    unittest.main()
