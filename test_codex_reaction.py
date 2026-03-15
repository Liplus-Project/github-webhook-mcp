import json
import tempfile
import unittest
from pathlib import Path

import codex_reaction


class CodexReactionTests(unittest.TestCase):
    def test_load_event_reads_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            event_path = Path(temp_dir) / "event.json"
            event_path.write_text(json.dumps({"id": "evt-1", "payload": {}}), encoding="utf-8")

            event = codex_reaction.load_event(event_path=str(event_path))

        self.assertEqual(event["id"], "evt-1")

    def test_build_prompt_includes_summary_and_path(self) -> None:
        event = {
            "id": "evt-2",
            "type": "pull_request",
            "payload": {
                "action": "opened",
                "repository": {"full_name": "owner/repo"},
                "sender": {"login": "smile"},
                "pull_request": {
                    "number": 42,
                    "title": "Add direct trigger",
                    "html_url": "https://example.invalid/pull/42",
                },
            },
        }

        prompt = codex_reaction.build_prompt(
            event,
            workspace="/workspace",
            event_path="/tmp/event.json",
            extra_instructions="Reply in Japanese.",
        )

        self.assertIn("Workspace: /workspace", prompt)
        self.assertIn("Event JSON path: /tmp/event.json", prompt)
        self.assertIn("- type: pull_request", prompt)
        self.assertIn("- number: 42", prompt)
        self.assertIn("Reply in Japanese.", prompt)

    def test_build_codex_command_orders_root_flags_before_exec(self) -> None:
        cmd = codex_reaction.build_codex_command(
            codex_bin="codex",
            workspace="/workspace",
            prompt="Handle the event.",
            output_file=Path("/tmp/output.md"),
            sandbox="workspace-write",
            approval="never",
            skip_git_repo_check=True,
        )

        self.assertEqual(
            cmd,
            [
                "codex",
                "-a",
                "never",
                "-s",
                "workspace-write",
                "exec",
                "-C",
                "/workspace",
                "--skip-git-repo-check",
                "-o",
                "/tmp/output.md",
                "Handle the event.",
            ],
        )

    def test_build_codex_command_uses_supplied_binary(self) -> None:
        cmd = codex_reaction.build_codex_command(
            codex_bin="C:/tools/codex.exe",
            workspace="/workspace",
            prompt="Handle the event.",
            output_file=None,
            sandbox="workspace-write",
            approval="never",
            skip_git_repo_check=False,
        )

        self.assertEqual(cmd[0], "C:/tools/codex.exe")

    def test_build_codex_resume_command_targets_session(self) -> None:
        cmd = codex_reaction.build_codex_resume_command(
            codex_bin="codex",
            session_id="019cef1e-fb9d-7ae0-998c-2d66971f55c0",
            prompt="Handle the event in-app.",
            output_file=Path("/tmp/output.md"),
            skip_git_repo_check=True,
        )

        self.assertEqual(
            cmd,
            [
                "codex",
                "exec",
                "resume",
                "019cef1e-fb9d-7ae0-998c-2d66971f55c0",
                "--skip-git-repo-check",
                "-o",
                "/tmp/output.md",
                "Handle the event in-app.",
            ],
        )

    def test_notify_only_enabled_checks_workspace_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertFalse(codex_reaction.notify_only_enabled(str(workspace)))

            (workspace / codex_reaction.NOTIFY_ONLY_MARKER).write_text("", encoding="utf-8")

            self.assertTrue(codex_reaction.notify_only_enabled(str(workspace)))


if __name__ == "__main__":
    unittest.main()
