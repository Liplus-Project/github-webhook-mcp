#!/usr/bin/env node
/**
 * Local stdio MCP bridge for github-webhook-mcp
 *
 * - Connects to Cloudflare Worker's /events SSE endpoint
 * - Forwards new events as Claude Code channel notifications
 * - Proxies MCP tool calls to the remote Worker (reuses a single session)
 *
 * Discord MCP pattern: data lives in the cloud, local MCP is a thin bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import EventSource from "eventsource";

const WORKER_URL = process.env.WEBHOOK_WORKER_URL || "https://github-webhook-mcp.smileygames2021.workers.dev";
const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

// ── Remote MCP Session (lazy, reused) ────────────────────────────────────────

let _sessionId: string | null = null;

async function getSessionId(): Promise<string> {
  if (_sessionId) return _sessionId;

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
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

async function callRemoteTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const sessionId = await getSessionId();

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
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
  const dataLine = text.split("\n").find(l => l.startsWith("data: "));
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

const capabilities: Record<string, unknown> = { tools: {} };
if (CHANNEL_ENABLED) {
  capabilities.experimental = { "claude/channel": {} };
}

const mcp = new Server(
  { name: "github-webhook-mcp", version: "1.0.0" },
  {
    capabilities,
    instructions: CHANNEL_ENABLED
      ? "GitHub webhook events arrive as <channel source=\"github-webhook-mcp\" ...>. They are one-way: read them and act, no reply expected."
      : undefined,
  },
);

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_pending_status",
    description: "Get a lightweight snapshot of pending GitHub webhook events",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_pending_events",
    description: "List lightweight summaries for pending GitHub webhook events",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max events to return (1-100, default 20)" },
      },
    },
  },
  {
    name: "get_event",
    description: "Get the full payload for a single webhook event by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: { type: "string", description: "The event ID to retrieve" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "mark_processed",
    description: "Mark a webhook event as processed",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: { type: "string", description: "The event ID to mark" },
      },
      required: ["event_id"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await callRemoteTool(name, args ?? {});
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to reach worker: ${err}` }],
      isError: true,
    };
  }
});

// ── SSE Listener → Channel Notifications ─────────────────────────────────────

function connectSSE() {
  const es = new EventSource(`${WORKER_URL}/events`);

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if ("heartbeat" in data || "status" in data) return;
      if (!data.summary) return;

      const s = data.summary;
      const parts = [s.type];
      if (s.action) parts.push(s.action);
      if (s.repo) parts.push(`in ${s.repo}`);
      if (s.title) parts.push(`"${s.title}"`);
      if (s.sender) parts.push(`by ${s.sender}`);

      void mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: parts.join(" "),
          meta: {
            event_id: s.id,
            type: s.type,
            ...(s.repo ? { repo: s.repo } : {}),
            ...(s.action ? { action: s.action } : {}),
          },
        },
      });
    } catch {
      // Ignore parse errors
    }
  };

  es.onerror = () => {
    // EventSource auto-reconnects
  };

  return es;
}

// ── Main ─────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());

if (CHANNEL_ENABLED) {
  connectSSE();
}
