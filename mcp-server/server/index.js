#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { watch } from "node:fs";
import {
  getPendingStatus,
  getPendingSummaries,
  getEvent,
  getPending,
  markDone,
  summarizeEvent,
  dataFilePath,
} from "./event-store.js";

const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

const capabilities = {
  tools: {},
};
if (CHANNEL_ENABLED) {
  capabilities.experimental = { "claude/channel": {} };
}

const server = new Server(
  { name: "github-webhook-mcp", version: "0.4.1" },
  {
    capabilities,
    instructions: CHANNEL_ENABLED
      ? "GitHub webhook events arrive as <channel source=\"github-webhook-mcp\" ...>. They are one-way: read them and act, no reply expected."
      : undefined,
  },
);

// ── Tools ───────────────────────────────────────────────────────────────────

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
          description: "Maximum number of pending events to return (1-100, default 20)",
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
    description: "Mark a webhook event as processed so it won't appear again.",
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

  switch (name) {
    case "get_pending_status": {
      const status = getPendingStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }
    case "list_pending_events": {
      const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
      const summaries = getPendingSummaries(limit);
      return {
        content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }],
      };
    }
    case "get_event": {
      const event = getEvent(args.event_id);
      if (event === null) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "not_found", event_id: args.event_id }),
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
      };
    }
    case "get_webhook_events": {
      const events = getPending();
      return {
        content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
      };
    }
    case "mark_processed": {
      const result = markDone(args.event_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: result.success,
              event_id: args.event_id,
              purged: result.purged,
            }),
          },
        ],
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// ── File watcher (after connect) ─────────────────────────────────────────────

if (CHANNEL_ENABLED) {
  const seenIds = new Set(getPending().map((e) => e.id));
  let debounce = null;

  function onFileChange() {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      try {
        const pending = getPending();
        for (const event of pending) {
          if (seenIds.has(event.id)) continue;
          seenIds.add(event.id);
          const summary = summarizeEvent(event);
          const lines = [
            `[${summary.type}] ${summary.repo ?? ""}`,
            summary.action ? `action: ${summary.action}` : null,
            summary.title ? `#${summary.number ?? ""} ${summary.title}` : null,
            summary.sender ? `by ${summary.sender}` : null,
            summary.url ?? null,
          ].filter(Boolean);
          server.notification({
            method: "notifications/claude/channel",
            params: {
              content: lines.join("\n"),
              meta: {
                chat_id: "github",
                message_id: event.id,
                user: summary.sender ?? "github",
                ts: summary.received_at,
              },
            },
          });
        }
      } catch {
        // file may be mid-write; ignore and retry on next change
      }
    }, 500);
  }

  try {
    watch(dataFilePath(), onFileChange);
  } catch {
    // events.json may not exist yet; start polling fallback
    const poll = setInterval(() => {
      try {
        watch(dataFilePath(), onFileChange);
        clearInterval(poll);
      } catch {
        // keep waiting
      }
    }, 5000);
  }
}
