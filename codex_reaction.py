#!/usr/bin/env python3
"""
codex_reaction.py - run Codex immediately for a GitHub webhook event

The webhook server passes the full event JSON on stdin and also exposes
GITHUB_WEBHOOK_* environment variables, including GITHUB_WEBHOOK_EVENT_PATH.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv() -> bool:
        return False

load_dotenv()

NOTIFY_ONLY_MARKER = ".codex-webhook-notify-only"
NOTIFY_ONLY_EXIT_CODE = 86


def load_event(raw_text: str | None = None, event_path: str | None = None) -> dict[str, Any]:
    source_text = raw_text
    if source_text is None:
        path = event_path or os.environ.get("GITHUB_WEBHOOK_EVENT_PATH", "")
        if path:
            source_text = Path(path).read_text(encoding="utf-8")
        else:
            source_text = sys.stdin.read()
    if not source_text.strip():
        raise ValueError("No webhook event payload was provided")
    return json.loads(source_text)


def build_prompt(
    event: dict[str, Any],
    *,
    workspace: str,
    event_path: str | None,
    extra_instructions: str = "",
) -> str:
    payload = event.get("payload", {})
    repo = (payload.get("repository") or {}).get("full_name", "")
    sender = (payload.get("sender") or {}).get("login", "")
    issue = payload.get("issue") or {}
    pull_request = payload.get("pull_request") or {}
    discussion = payload.get("discussion") or {}
    number = payload.get("number") or issue.get("number") or pull_request.get("number")
    title = (
        issue.get("title")
        or pull_request.get("title")
        or discussion.get("title")
        or (payload.get("check_run") or {}).get("name")
        or (payload.get("workflow_run") or {}).get("name")
        or ""
    )
    url = (
        issue.get("html_url")
        or pull_request.get("html_url")
        or discussion.get("html_url")
        or (payload.get("check_run") or {}).get("html_url")
        or (payload.get("workflow_run") or {}).get("html_url")
        or ""
    )
    lines = [
        "A GitHub webhook event has just arrived.",
        "",
        f"Workspace: {workspace}",
        f"Event JSON path: {event_path or '(stdin only)'}",
        "Summary:",
        f"- id: {event.get('id', '')}",
        f"- type: {event.get('type', '')}",
        f"- action: {payload.get('action', '')}",
        f"- repo: {repo}",
        f"- sender: {sender}",
        f"- number: {number or ''}",
        f"- title: {title}",
        f"- url: {url}",
        "",
        "Instructions:",
        "- Read AGENTS.md in the workspace and follow it.",
        "- Read the webhook event JSON file for full context before acting.",
        "- React directly to this event in the workspace.",
        "- If no action is needed, explain briefly why and stop.",
        "- Do not wait for another poll cycle.",
    ]
    if extra_instructions.strip():
        lines.extend(["", "Additional instructions:", extra_instructions.strip()])
    return "\n".join(lines)


def build_codex_command(
    *,
    codex_bin: str,
    workspace: str,
    prompt: str,
    output_file: Path | None,
    sandbox: str,
    approval: str,
    skip_git_repo_check: bool,
) -> list[str]:
    cmd = [codex_bin, "-a", approval, "-s", sandbox, "exec", "-C", workspace]
    if skip_git_repo_check:
        cmd.append("--skip-git-repo-check")
    if output_file is not None:
        cmd.extend(["-o", str(output_file)])
    cmd.append(prompt)
    return cmd


def build_codex_resume_command(
    *,
    codex_bin: str,
    session_id: str,
    prompt: str,
    output_file: Path | None,
    skip_git_repo_check: bool,
) -> list[str]:
    cmd = [codex_bin, "exec", "resume", session_id]
    if skip_git_repo_check:
        cmd.append("--skip-git-repo-check")
    if output_file is not None:
        cmd.extend(["-o", str(output_file)])
    cmd.append(prompt)
    return cmd


def notify_only_enabled(workspace: str) -> bool:
    return (Path(workspace) / NOTIFY_ONLY_MARKER).exists()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Codex for a webhook event")
    parser.add_argument("--workspace", required=True, help="Workspace passed to codex exec -C")
    parser.add_argument("--codex-bin", default=os.environ.get("CODEX_BIN", "codex"))
    parser.add_argument(
        "--codex-home",
        default=os.environ.get("CODEX_HOME", ""),
        help="Optional CODEX_HOME passed to codex exec.",
    )
    parser.add_argument(
        "--resume-session",
        default=os.environ.get("CODEX_REACTION_RESUME_SESSION", ""),
        help="Optional Codex thread/session id to target with `codex exec resume`.",
    )
    parser.add_argument("--sandbox", default=os.environ.get("CODEX_SANDBOX", "workspace-write"))
    parser.add_argument("--approval", default=os.environ.get("CODEX_APPROVAL", "never"))
    parser.add_argument(
        "--output-dir",
        default=os.environ.get("CODEX_REACTION_OUTPUT_DIR", ""),
        help="Optional directory for codex exec output files.",
    )
    parser.add_argument(
        "--extra-instructions",
        default=os.environ.get("CODEX_REACTION_EXTRA_INSTRUCTIONS", ""),
        help="Extra instructions appended to the generated Codex prompt.",
    )
    parser.add_argument(
        "--skip-git-repo-check",
        action="store_true",
        help="Forward --skip-git-repo-check to codex exec.",
    )
    args = parser.parse_args()

    event_path = os.environ.get("GITHUB_WEBHOOK_EVENT_PATH", "")
    event = load_event(event_path=event_path)

    if notify_only_enabled(args.workspace):
        print(
            f"notify-only mode active via {Path(args.workspace) / NOTIFY_ONLY_MARKER}; "
            "leaving webhook event pending",
            file=sys.stderr,
        )
        return NOTIFY_ONLY_EXIT_CODE

    output_file: Path | None = None
    if args.output_dir:
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        output_file = output_dir / f"{event.get('id', 'webhook-event')}.md"

    prompt = build_prompt(
        event,
        workspace=args.workspace,
        event_path=event_path or None,
        extra_instructions=args.extra_instructions,
    )
    env = os.environ.copy()
    if args.codex_home:
        env["CODEX_HOME"] = args.codex_home
    if args.resume_session:
        cmd = build_codex_resume_command(
            codex_bin=args.codex_bin,
            session_id=args.resume_session,
            prompt=prompt,
            output_file=output_file,
            skip_git_repo_check=args.skip_git_repo_check,
        )
    else:
        cmd = build_codex_command(
            codex_bin=args.codex_bin,
            workspace=args.workspace,
            prompt=prompt,
            output_file=output_file,
            sandbox=args.sandbox,
            approval=args.approval,
            skip_git_repo_check=args.skip_git_repo_check,
        )
    completed = subprocess.run(cmd, check=False, env=env)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
