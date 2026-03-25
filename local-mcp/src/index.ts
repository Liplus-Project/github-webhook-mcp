#!/usr/bin/env bun
/**
 * Local stdio MCP bridge for github-webhook-mcp
 *
 * - Connects to Cloudflare Worker's /events SSE endpoint
 * - Forwards new events as Claude Code channel notifications
 * - Proxies MCP tool calls to the Worker's /mcp endpoint
 *
 * Discord MCP pattern: data lives in the cloud, local MCP is a thin bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SSEEvent } from "../../shared/src/types.js";

const WORKER_URL = process.env.WEBHOOK_WORKER_URL || "https://github-webhook-mcp.workers.dev";

// ── MCP Server Setup ─────────────────────────────────────────────────────────

const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

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

// ── Tool Definitions (proxied to Worker) ─────────────────────────────────────

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

  // Proxy tool call to Worker's MCP endpoint
  // For now, use a simple REST-style proxy until full MCP client is set up
  try {
    const response = await fetch(`${WORKER_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: args },
        id: crypto.randomUUID(),
      }),
    });

    const result = await response.json() as Record<string, unknown>;
    if (result.error) {
      return {
        content: [{ type: "text", text: JSON.stringify(result.error) }],
        isError: true,
      };
    }
    return result.result as { content: Array<{ type: string; text: string }> };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to reach worker: ${err}` }],
      isError: true,
    };
  }
});

// ── SSE Listener → Channel Notifications ─────────────────────────────────────

function connectSSE() {
  const EventSource = globalThis.EventSource ?? (await import("eventsource")).default;
  const es = new EventSource(`${WORKER_URL}/events`);

  es.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as SSEEvent | { heartbeat?: number; status?: string };

      // Skip heartbeats and status messages
      if ("heartbeat" in data || "status" in data) return;

      const sseEvent = data as SSEEvent;
      if (!sseEvent.summary) return;

      // Push channel notification to Claude Code
      if (CHANNEL_ENABLED) {
        const summary = sseEvent.summary;
        const parts = [summary.type];
        if (summary.action) parts.push(summary.action);
        if (summary.repo) parts.push(`in ${summary.repo}`);
        if (summary.title) parts.push(`"${summary.title}"`);
        if (summary.sender) parts.push(`by ${summary.sender}`);

        void mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: parts.join(" "),
            meta: {
              event_id: summary.id,
              type: summary.type,
              ...(summary.repo ? { repo: summary.repo } : {}),
              ...(summary.action ? { action: summary.action } : {}),
            },
          },
        });
      }
    } catch {
      // Ignore parse errors
    }
  };

  es.onerror = () => {
    // EventSource auto-reconnects by default
  };

  return es;
}

// ── Main ─────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());

if (CHANNEL_ENABLED) {
  connectSSE();
}
