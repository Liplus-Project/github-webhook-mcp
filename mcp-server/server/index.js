#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

const server = new McpServer({
  name: "github-webhook-mcp",
  version: "0.3.0",
});

// ── Tools ───────────────────────────────────────────────────────────────────

server.tool(
  "get_pending_status",
  "Get a lightweight snapshot of pending GitHub webhook events. Use this for periodic polling before requesting details.",
  {},
  async () => {
    const status = getPendingStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  }
);

server.tool(
  "list_pending_events",
  "List lightweight summaries for pending GitHub webhook events. Returns metadata only, without full payloads.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Maximum number of pending events to return"),
  },
  async ({ limit }) => {
    const summaries = getPendingSummaries(limit);
    return {
      content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }],
    };
  }
);

server.tool(
  "get_event",
  "Get the full payload for a single webhook event by ID.",
  {
    event_id: z.string().describe("The event ID to retrieve"),
  },
  async ({ event_id }) => {
    const event = getEvent(event_id);
    if (event === null) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "not_found", event_id }),
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
    };
  }
);

server.tool(
  "get_webhook_events",
  "Get pending (unprocessed) GitHub webhook events with full payloads. Prefer get_pending_status or list_pending_events for polling.",
  {},
  async () => {
    const events = getPending();
    return {
      content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
    };
  }
);

server.tool(
  "mark_processed",
  "Mark a webhook event as processed so it won't appear again.",
  {
    event_id: z.string().describe("The event ID to mark as processed"),
  },
  async ({ event_id }) => {
    const result = markDone(event_id);
    return {
      content: [
        { type: "text", text: JSON.stringify({ success: result.success, event_id, purged: result.purged }) },
      ],
    };
  }
);

// ── Channel notifications ────────────────────────────────────────────────────

const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

if (CHANNEL_ENABLED) {
  server.server.registerCapabilities({
    experimental: { "claude/channel": {} },
  });
}

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
          server.server.notification({
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
