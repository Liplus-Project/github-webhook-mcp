#!/usr/bin/env node
/**
 * Local stdio MCP bridge for github-webhook-mcp
 *
 * - Connects to Cloudflare Worker's /events SSE endpoint
 * - Forwards new events as Claude Code channel notifications
 * - Queries webhook data via WebhookStore DO REST endpoints
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
    let url: string;
    let options: RequestInit = {};

    switch (name) {
      case "get_pending_status":
        url = `${WORKER_URL}/webhooks/github`;
        // Use a direct REST query to the store via Worker proxy
        // For now, use the MCP endpoint with proper session handling
        // Simplified: query the store endpoints directly
        url = `${WORKER_URL}/events`; // placeholder
        break;
      default:
        break;
    }

    // Direct proxy to Worker's webhook store endpoints
    // The Worker routes these to WebhookStore DO internally
    let response: Response;

    switch (name) {
      case "get_pending_status": {
        // Initialize MCP session and call tool
        const initRes = await fetch(`${WORKER_URL}/mcp`, {
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
        const sessionId = initRes.headers.get("mcp-session-id") || "";

        response = await fetch(`${WORKER_URL}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name, arguments: args || {} },
            id: crypto.randomUUID(),
          }),
        });
        break;
      }
      default: {
        // Same pattern for all tools
        const initRes = await fetch(`${WORKER_URL}/mcp`, {
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
        const sessionId = initRes.headers.get("mcp-session-id") || "";

        response = await fetch(`${WORKER_URL}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name, arguments: args || {} },
            id: crypto.randomUUID(),
          }),
        });
      }
    }

    // Parse SSE response (Streamable HTTP returns SSE format)
    const text = await response!.text();
    const dataLine = text.split("\n").find(l => l.startsWith("data: "));
    if (!dataLine) {
      return { content: [{ type: "text", text: text }], isError: true };
    }
    const result = JSON.parse(dataLine.slice(6));
    if (result.error) {
      return { content: [{ type: "text", text: JSON.stringify(result.error) }], isError: true };
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
  const es = new EventSource(`${WORKER_URL}/events`);

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Skip heartbeats and status messages
      if ("heartbeat" in data || "status" in data) return;
      if (!data.summary) return;

      const summary = data.summary;

      // Push channel notification to Claude Code
      if (CHANNEL_ENABLED) {
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
