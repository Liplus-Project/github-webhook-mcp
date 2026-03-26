#!/usr/bin/env node
/**
 * GitHub Webhook MCP — Cloudflare Worker bridge
 *
 * Thin stdio MCP server that proxies tool calls to a remote
 * Cloudflare Worker + Durable Object backend via Streamable HTTP.
 * Listens to WebSocket for real-time channel notifications.
 *
 * Discord MCP pattern: data lives in the cloud, local MCP is a thin bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

const WORKER_URL =
  process.env.WEBHOOK_WORKER_URL ||
  "https://github-webhook-mcp.liplus.workers.dev";
const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

// ── Remote MCP Session (lazy, reused) ────────────────────────────────────────

let _sessionId = null;

async function getSessionId() {
  if (_sessionId) return _sessionId;

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "local-bridge", version: "1.0.0" },
      },
      id: "init",
    }),
  });

  _sessionId = res.headers.get("mcp-session-id") || "";
  return _sessionId;
}

async function callRemoteTool(name, args) {
  const sessionId = await getSessionId();

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: crypto.randomUUID(),
    }),
  });

  const text = await res.text();

  // Streamable HTTP may return SSE format
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

  if (json.error) {
    // Session expired — retry once with a fresh session
    if (json.error.code === -32600 || json.error.code === -32001) {
      _sessionId = null;
      return callRemoteTool(name, args);
    }
    return { content: [{ type: "text", text: JSON.stringify(json.error) }] };
  }

  return json.result;
}

// ── MCP Server Setup ─────────────────────────────────────────────────────────

const capabilities = { tools: {} };
if (CHANNEL_ENABLED) {
  capabilities.experimental = { "claude/channel": {} };
}

const server = new Server(
  { name: "github-webhook-mcp", version: "1.0.0" },
  {
    capabilities,
    instructions: CHANNEL_ENABLED
      ? 'GitHub webhook events arrive as <channel source="github-webhook-mcp" ...>. They are one-way: read them and act, no reply expected.'
      : undefined,
  },
);

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_pending_status",
    title: "Get Pending Status",
    description:
      "Get a lightweight snapshot of pending GitHub webhook events. Use this for periodic polling before requesting details.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "Get Pending Status",
      readOnlyHint: true,
    },
  },
  {
    name: "list_pending_events",
    title: "List Pending Events",
    description:
      "List lightweight summaries for pending GitHub webhook events. Returns metadata only, without full payloads.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description:
            "Maximum number of pending events to return (1-100, default 20)",
        },
      },
    },
    annotations: {
      title: "List Pending Events",
      readOnlyHint: true,
    },
  },
  {
    name: "get_event",
    title: "Get Event Payload",
    description: "Get the full payload for a single webhook event by ID.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The event ID to retrieve" },
      },
      required: ["event_id"],
    },
    annotations: {
      title: "Get Event Payload",
      readOnlyHint: true,
    },
  },
  {
    name: "get_webhook_events",
    title: "Get Webhook Events",
    description:
      "Get pending (unprocessed) GitHub webhook events with full payloads. Prefer get_pending_status or list_pending_events for polling.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "Get Webhook Events",
      readOnlyHint: true,
    },
  },
  {
    name: "mark_processed",
    title: "Mark Event Processed",
    description:
      "Mark a webhook event as processed so it won't appear again.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "The event ID to mark as processed",
        },
      },
      required: ["event_id"],
    },
    annotations: {
      title: "Mark Event Processed",
      destructiveHint: true,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await callRemoteTool(name, args ?? {});
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to reach worker: ${err}` }],
      isError: true,
    };
  }
});

// ── WebSocket Listener → Channel Notifications ──────────────────────────────

function connectWebSocket() {
  const wsUrl = WORKER_URL.replace(/^http/, "ws") + "/events";
  let ws;
  let pingTimer = null;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      // Send periodic pings to keep connection alive
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, 25000);
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Skip status, pong, heartbeat messages
        if ("status" in data || "pong" in data || "heartbeat" in data) return;
        if (!data.summary) return;

        const s = data.summary;
        const lines = [
          `[${s.type}] ${s.repo ?? ""}`,
          s.action ? `action: ${s.action}` : null,
          s.title ? `#${s.number ?? ""} ${s.title}` : null,
          s.sender ? `by ${s.sender}` : null,
          s.url ?? null,
        ].filter(Boolean);

        server.notification({
          method: "notifications/claude/channel",
          params: {
            content: lines.join("\n"),
            meta: {
              chat_id: "github",
              message_id: s.id,
              user: s.sender ?? "github",
              ts: s.received_at,
            },
          },
        });
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("close", () => {
      if (pingTimer) clearInterval(pingTimer);
      // Reconnect after 5 seconds
      setTimeout(connect, 5000);
    });

    ws.on("error", () => {
      // Will trigger close event, which handles reconnect
    });
  }

  connect();
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

if (CHANNEL_ENABLED) {
  connectWebSocket();
}
