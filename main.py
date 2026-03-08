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
import uuid
from collections import Counter

from dotenv import load_dotenv
load_dotenv()
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_FILE = Path(__file__).parent / "events.json"
PRIMARY_ENCODING = "utf-8"
LEGACY_ENCODINGS = ("utf-8-sig", "cp932", "shift_jis")
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
    events = _load()
    for e in events:
        if e["id"] == event_id:
            e["processed"] = True
            _save(events)
            return True
    return False


# ── Webhook Server (FastAPI) ──────────────────────────────────────────────────

def run_webhook(port: int, secret: str, event_profile: str) -> None:
    from fastapi import FastAPI, Header, HTTPException, Request
    import uvicorn

    app = FastAPI(title="github-webhook-mcp")
    normalized_profile = _normalize_event_profile(event_profile)

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

    sub.add_parser("mcp", help="Start MCP server (stdio transport)")

    args = parser.parse_args()

    if args.mode == "webhook":
        run_webhook(port=args.port, secret=args.secret, event_profile=args.event_profile)
    elif args.mode == "mcp":
        asyncio.run(run_mcp())
