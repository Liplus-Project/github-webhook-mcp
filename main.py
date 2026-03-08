#!/usr/bin/env python3
"""
github-webhook-mcp — GitHub webhook receiver + MCP server

Usage:
  python main.py webhook [--port 8080] [--secret $WEBHOOK_SECRET]
  python main.py mcp
"""
import argparse
import asyncio
import hashlib
import hmac
import json
import os
import uuid

from dotenv import load_dotenv
load_dotenv()
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_FILE = Path(__file__).parent / "events.json"


# ── Event Store ───────────────────────────────────────────────────────────────

def _load() -> list[dict]:
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text())
    return []

def _save(events: list[dict]) -> None:
    DATA_FILE.write_text(json.dumps(events, ensure_ascii=False, indent=2))

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

def mark_done(event_id: str) -> bool:
    events = _load()
    for e in events:
        if e["id"] == event_id:
            e["processed"] = True
            _save(events)
            return True
    return False


# ── Webhook Server (FastAPI) ──────────────────────────────────────────────────

def run_webhook(port: int, secret: str) -> None:
    from fastapi import FastAPI, Header, HTTPException, Request
    import uvicorn

    app = FastAPI(title="github-webhook-mcp")

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
                name="get_webhook_events",
                description=(
                    "Get pending (unprocessed) GitHub webhook events. "
                    "Returns list of events with id, type, payload, received_at."
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

    sub.add_parser("mcp", help="Start MCP server (stdio transport)")

    args = parser.parse_args()

    if args.mode == "webhook":
        run_webhook(port=args.port, secret=args.secret)
    elif args.mode == "mcp":
        asyncio.run(run_mcp())
