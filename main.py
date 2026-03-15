#!/usr/bin/env python3
"""
github-webhook-mcp — GitHub webhook receiver + MCP server

Usage:
  python main.py webhook [--port 8080] [--secret $WEBHOOK_SECRET] [--event-profile all|notifications]
  python main.py mcp
"""
import argparse
import asyncio
import hashlib
import hmac
import json
import os
import shlex
import sys
import uuid
from collections import Counter
from contextlib import asynccontextmanager

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv() -> bool:
        return False
load_dotenv()
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

DATA_FILE = Path(__file__).parent / "events.json"
TRIGGER_EVENTS_DIR = Path(__file__).parent / "trigger-events"
PRIMARY_ENCODING = "utf-8"
LEGACY_ENCODINGS = ("utf-8-sig", "cp932", "shift_jis")
NOTIFY_ONLY_EXIT_CODE = 86
NOTIFICATION_EVENT_ACTIONS = {
    "issues": {"assigned", "closed", "opened", "reopened", "unassigned"},
    "issue_comment": {"created"},
    "pull_request": {
        "assigned",
        "closed",
        "converted_to_draft",
        "opened",
        "ready_for_review",
        "reopened",
        "review_requested",
        "review_request_removed",
        "synchronize",
        "unassigned",
    },
    "pull_request_review": {"dismissed", "submitted"},
    "pull_request_review_comment": {"created"},
    "check_run": {"completed"},
    "workflow_run": {"completed"},
    "discussion": {"answered", "closed", "created", "reopened"},
    "discussion_comment": {"created"},
}


# ── Event Store ───────────────────────────────────────────────────────────────

def _load() -> list[dict]:
    if DATA_FILE.exists():
        raw = DATA_FILE.read_bytes()
        for encoding in (PRIMARY_ENCODING, *LEGACY_ENCODINGS):
            try:
                text = raw.decode(encoding)
                events = json.loads(text)
                if encoding != PRIMARY_ENCODING:
                    _save(events)
                return events
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        raise ValueError(f"Unable to decode event store: {DATA_FILE}")
    return []

def _save(events: list[dict]) -> None:
    DATA_FILE.write_text(
        json.dumps(events, ensure_ascii=False, indent=2),
        encoding=PRIMARY_ENCODING,
    )

def add_event(event_type: str, payload: dict) -> dict:
    events = _load()
    event = {
        "id": str(uuid.uuid4()),
        "type": event_type,
        "payload": payload,
        "received_at": datetime.now(timezone.utc).isoformat(),
        "processed": False,
    }
    events.append(event)
    _save(events)
    return event

def get_pending() -> list[dict]:
    return [e for e in _load() if not e["processed"]]

def update_event(event_id: str, **updates: Any) -> bool:
    events = _load()
    for event in events:
        if event["id"] == event_id:
            event.update(updates)
            _save(events)
            return True
    return False

def _normalize_event_profile(profile: str) -> str:
    normalized = (profile or "all").strip().lower()
    if normalized not in {"all", "notifications"}:
        raise ValueError(f"Unknown event profile: {profile}")
    return normalized

def should_store_event(event_type: str, payload: dict, profile: str) -> bool:
    normalized = _normalize_event_profile(profile)
    if normalized == "all":
        return True
    allowed_actions = NOTIFICATION_EVENT_ACTIONS.get(event_type)
    if not allowed_actions:
        return False
    action = payload.get("action")
    return action in allowed_actions

def _event_number(payload: dict) -> int | str | None:
    return (
        payload.get("number")
        or (payload.get("issue") or {}).get("number")
        or (payload.get("pull_request") or {}).get("number")
    )

def _event_title(payload: dict) -> str | None:
    return (
        (payload.get("issue") or {}).get("title")
        or (payload.get("pull_request") or {}).get("title")
        or (payload.get("discussion") or {}).get("title")
        or (payload.get("check_run") or {}).get("name")
        or (payload.get("workflow_run") or {}).get("name")
        or (payload.get("workflow_job") or {}).get("name")
    )

def _event_url(payload: dict) -> str | None:
    return (
        (payload.get("issue") or {}).get("html_url")
        or (payload.get("pull_request") or {}).get("html_url")
        or (payload.get("discussion") or {}).get("html_url")
        or (payload.get("check_run") or {}).get("html_url")
        or (payload.get("workflow_run") or {}).get("html_url")
    )

def summarize_event(event: dict) -> dict:
    payload = event.get("payload", {})
    return {
        "id": event["id"],
        "type": event["type"],
        "received_at": event["received_at"],
        "processed": event["processed"],
        "trigger_status": event.get("trigger_status"),
        "last_triggered_at": event.get("last_triggered_at"),
        "action": payload.get("action"),
        "repo": (payload.get("repository") or {}).get("full_name"),
        "sender": (payload.get("sender") or {}).get("login"),
        "number": _event_number(payload),
        "title": _event_title(payload),
        "url": _event_url(payload),
    }

def get_pending_status() -> dict:
    pending = get_pending()
    return {
        "pending_count": len(pending),
        "latest_received_at": pending[-1]["received_at"] if pending else None,
        "types": dict(Counter(event["type"] for event in pending)),
    }

def get_pending_summaries(limit: int = 20) -> list[dict]:
    pending = get_pending()
    if limit > 0:
        pending = pending[-limit:]
    return [summarize_event(event) for event in pending]

def get_event(event_id: str) -> dict | None:
    for event in _load():
        if event["id"] == event_id:
            return event
    return None

def mark_done(event_id: str) -> bool:
    return update_event(event_id, processed=True)


# ── Direct Trigger Execution ───────────────────────────────────────────────────

def parse_trigger_command(command: str) -> list[str]:
    raw = (command or "").strip()
    if not raw:
        return []
    windows_style = os.name == "nt" or ":\\" in raw or raw.startswith("\\\\")
    return shlex.split(raw, posix=not windows_style)

def resolve_trigger_command(
    env_command: str,
    cli_tokens: list[str] | None,
) -> list[str]:
    if not cli_tokens:
        return parse_trigger_command(env_command)
    if len(cli_tokens) == 1:
        return parse_trigger_command(cli_tokens[0])
    return cli_tokens

def persist_trigger_event(event: dict) -> Path:
    TRIGGER_EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    event_path = TRIGGER_EVENTS_DIR / f"{event['id']}.json"
    event_path.write_text(
        json.dumps(event, ensure_ascii=False, indent=2),
        encoding=PRIMARY_ENCODING,
    )
    return event_path

def _stringify_env(value: Any) -> str:
    if value is None:
        return ""
    return str(value)

def build_trigger_env(event: dict, event_path: Path) -> dict[str, str]:
    payload = event.get("payload", {})
    env = os.environ.copy()
    env.update(
        {
            "GITHUB_WEBHOOK_EVENT_ID": event["id"],
            "GITHUB_WEBHOOK_EVENT_TYPE": event["type"],
            "GITHUB_WEBHOOK_EVENT_ACTION": _stringify_env(payload.get("action")),
            "GITHUB_WEBHOOK_EVENT_REPO": _stringify_env(
                (payload.get("repository") or {}).get("full_name")
            ),
            "GITHUB_WEBHOOK_EVENT_SENDER": _stringify_env(
                (payload.get("sender") or {}).get("login")
            ),
            "GITHUB_WEBHOOK_EVENT_NUMBER": _stringify_env(_event_number(payload)),
            "GITHUB_WEBHOOK_EVENT_TITLE": _stringify_env(_event_title(payload)),
            "GITHUB_WEBHOOK_EVENT_URL": _stringify_env(_event_url(payload)),
            "GITHUB_WEBHOOK_EVENT_PATH": str(event_path),
            "GITHUB_WEBHOOK_RECEIVED_AT": event["received_at"],
        }
    )
    return env

def _summarize_process_output(stdout: bytes, stderr: bytes) -> str:
    parts: list[str] = []
    if stdout:
        parts.append(f"stdout={stdout.decode(PRIMARY_ENCODING, errors='replace').strip()[:400]}")
    if stderr:
        parts.append(f"stderr={stderr.decode(PRIMARY_ENCODING, errors='replace').strip()[:400]}")
    return " ".join(part for part in parts if part).strip()

async def run_trigger_command(
    command: list[str],
    event: dict,
    cwd: Path | None = None,
) -> None:
    if not command:
        return
    event_path = persist_trigger_event(event)
    proc = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd) if cwd else None,
        env=build_trigger_env(event, event_path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    payload_bytes = json.dumps(event, ensure_ascii=False, indent=2).encode(PRIMARY_ENCODING)
    stdout, stderr = await proc.communicate(payload_bytes)
    if proc.returncode != 0:
        if proc.returncode == NOTIFY_ONLY_EXIT_CODE:
            raise TriggerSkipped("trigger command requested notify-only fallback")
        details = _summarize_process_output(stdout, stderr)
        raise RuntimeError(
            f"trigger command failed with exit code {proc.returncode}"
            + (f" ({details})" if details else "")
        )


TriggerRunner = Callable[[list[str], dict, Path | None], Awaitable[None]]


class TriggerSkipped(Exception):
    """A trigger command chose not to handle the event directly."""


class TriggerDispatcher:
    def __init__(
        self,
        command: list[str],
        *,
        cwd: Path | None = None,
        mark_processed_on_success: bool = True,
        runner: TriggerRunner = run_trigger_command,
    ) -> None:
        self.command = command
        self.cwd = cwd
        self.mark_processed_on_success = mark_processed_on_success
        self.runner = runner
        self._queue: asyncio.Queue[dict | None] = asyncio.Queue()
        self._worker_task: asyncio.Task[None] | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.command)

    async def start(self) -> None:
        if self.enabled and self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker())

    async def stop(self) -> None:
        if self._worker_task is None:
            return
        await self._queue.put(None)
        await self._worker_task
        self._worker_task = None

    async def enqueue(self, event: dict) -> None:
        if not self.enabled:
            return
        await self._queue.put(event)

    async def _worker(self) -> None:
        while True:
            event = await self._queue.get()
            if event is None:
                self._queue.task_done()
                return
            try:
                await self.runner(self.command, event, self.cwd)
            except TriggerSkipped as exc:
                update_event(
                    event["id"],
                    trigger_status="skipped",
                    trigger_error=str(exc),
                    last_triggered_at=datetime.now(timezone.utc).isoformat(),
                )
            except Exception as exc:
                update_event(
                    event["id"],
                    trigger_status="failed",
                    trigger_error=str(exc),
                    last_triggered_at=datetime.now(timezone.utc).isoformat(),
                )
                print(
                    f"[github-webhook-mcp] trigger failed for {event['id']}: {exc}",
                    file=sys.stderr,
                )
            else:
                updates: dict[str, Any] = {
                    "trigger_status": "succeeded",
                    "trigger_error": "",
                    "last_triggered_at": datetime.now(timezone.utc).isoformat(),
                }
                if self.mark_processed_on_success:
                    updates["processed"] = True
                update_event(event["id"], **updates)
            finally:
                self._queue.task_done()


# ── Webhook Server (FastAPI) ──────────────────────────────────────────────────

def run_webhook(
    port: int,
    secret: str,
    event_profile: str,
    *,
    trigger_command: list[str] | None = None,
    trigger_cwd: Path | None = None,
    mark_processed_on_trigger_success: bool = True,
) -> None:
    from fastapi import FastAPI, Header, HTTPException, Request
    import uvicorn

    normalized_profile = _normalize_event_profile(event_profile)
    dispatcher = TriggerDispatcher(
        trigger_command or [],
        cwd=trigger_cwd,
        mark_processed_on_success=mark_processed_on_trigger_success,
    )

    @asynccontextmanager
    async def lifespan(_: Any):
        await dispatcher.start()
        try:
            yield
        finally:
            await dispatcher.stop()

    app = FastAPI(title="github-webhook-mcp", lifespan=lifespan)

    def _verify(body: bytes, sig: str) -> bool:
        if not secret:
            return True
        if not sig.startswith("sha256="):
            return False
        expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(f"sha256={expected}", sig)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/webhook")
    async def webhook(
        request: Request,
        x_github_event: str = Header(default=""),
        x_hub_signature_256: str = Header(default=""),
    ):
        body = await request.body()
        if not _verify(body, x_hub_signature_256):
            raise HTTPException(status_code=401, detail="Invalid signature")
        payload = json.loads(body)
        if not should_store_event(x_github_event, payload, normalized_profile):
            return {"ignored": True, "type": x_github_event, "profile": normalized_profile}
        event = add_event(x_github_event, payload)
        await dispatcher.enqueue(event)
        return {"id": event["id"], "type": x_github_event}

    uvicorn.run(app, host="0.0.0.0", port=port)


# ── MCP Server (stdio) ────────────────────────────────────────────────────────

async def run_mcp() -> None:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    import mcp.types as types

    server = Server("github-webhook-mcp")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [
            types.Tool(
                name="get_pending_status",
                description=(
                    "Get a lightweight snapshot of pending GitHub webhook events. "
                    "Use this for periodic polling before requesting details."
                ),
                inputSchema={"type": "object", "properties": {}, "required": []},
            ),
            types.Tool(
                name="list_pending_events",
                description=(
                    "List lightweight summaries for pending GitHub webhook events. "
                    "Returns metadata only, without full payloads."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of pending events to return",
                            "minimum": 1,
                            "maximum": 100,
                            "default": 20,
                        }
                    },
                    "required": [],
                },
            ),
            types.Tool(
                name="get_event",
                description="Get the full payload for a single webhook event by ID.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "event_id": {
                            "type": "string",
                            "description": "The event ID to retrieve",
                        }
                    },
                    "required": ["event_id"],
                },
            ),
            types.Tool(
                name="get_webhook_events",
                description=(
                    "Get pending (unprocessed) GitHub webhook events with full payloads. "
                    "Prefer get_pending_status or list_pending_events for polling."
                ),
                inputSchema={"type": "object", "properties": {}, "required": []},
            ),
            types.Tool(
                name="mark_processed",
                description="Mark a webhook event as processed so it won't appear again.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "event_id": {
                            "type": "string",
                            "description": "The event ID to mark as processed",
                        }
                    },
                    "required": ["event_id"],
                },
            ),
        ]

    @server.call_tool()
    async def call_tool(
        name: str, arguments: dict[str, Any]
    ) -> list[types.TextContent]:
        if name == "get_pending_status":
            status = get_pending_status()
            return [
                types.TextContent(
                    type="text",
                    text=json.dumps(status, ensure_ascii=False, indent=2),
                )
            ]
        if name == "list_pending_events":
            limit = arguments.get("limit", 20)
            if not isinstance(limit, int):
                raise ValueError("limit must be an integer")
            summaries = get_pending_summaries(limit=limit)
            return [
                types.TextContent(
                    type="text",
                    text=json.dumps(summaries, ensure_ascii=False, indent=2),
                )
            ]
        if name == "get_event":
            event_id = arguments.get("event_id", "")
            event = get_event(event_id)
            if event is None:
                return [
                    types.TextContent(
                        type="text",
                        text=json.dumps({"error": "not_found", "event_id": event_id}),
                    )
                ]
            return [
                types.TextContent(
                    type="text",
                    text=json.dumps(event, ensure_ascii=False, indent=2),
                )
            ]
        if name == "get_webhook_events":
            events = get_pending()
            return [
                types.TextContent(
                    type="text",
                    text=json.dumps(events, ensure_ascii=False, indent=2),
                )
            ]
        if name == "mark_processed":
            event_id = arguments.get("event_id", "")
            ok = mark_done(event_id)
            return [
                types.TextContent(
                    type="text",
                    text=json.dumps({"success": ok, "event_id": event_id}),
                )
            ]
        raise ValueError(f"Unknown tool: {name}")

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="github-webhook-mcp")
    sub = parser.add_subparsers(dest="mode", required=True)

    wp = sub.add_parser("webhook", help="Start webhook receiver (HTTP server)")
    wp.add_argument("--port", type=int, default=8080)
    wp.add_argument("--secret", default=os.environ.get("WEBHOOK_SECRET", ""))
    wp.add_argument(
        "--event-profile",
        default=os.environ.get("WEBHOOK_EVENT_PROFILE", "all"),
        choices=["all", "notifications"],
    )
    wp.add_argument(
        "--trigger-command",
        nargs=argparse.REMAINDER,
        help=(
            "Optional command to run for each stored event. "
            "When provided on the CLI, put it last and pass the command tokens "
            "after --trigger-command. "
            "The event JSON is sent to stdin and metadata is provided via "
            "GITHUB_WEBHOOK_* environment variables."
        ),
    )
    wp.add_argument(
        "--trigger-cwd",
        default=os.environ.get("WEBHOOK_TRIGGER_CWD", ""),
        help="Optional working directory for the trigger command.",
    )
    wp.add_argument(
        "--keep-pending-on-trigger-success",
        action="store_true",
        help="Leave events pending even when the trigger command exits successfully.",
    )

    sub.add_parser("mcp", help="Start MCP server (stdio transport)")

    args = parser.parse_args()

    if args.mode == "webhook":
        run_webhook(
            port=args.port,
            secret=args.secret,
            event_profile=args.event_profile,
            trigger_command=resolve_trigger_command(
                os.environ.get("WEBHOOK_TRIGGER_COMMAND", ""),
                args.trigger_command,
            ),
            trigger_cwd=Path(args.trigger_cwd).expanduser() if args.trigger_cwd else None,
            mark_processed_on_trigger_success=not args.keep_pending_on_trigger_success,
        )
    elif args.mode == "mcp":
        asyncio.run(run_mcp())
