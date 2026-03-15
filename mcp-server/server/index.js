#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getPendingStatus,
  getPendingSummaries,
  getEvent,
  getPending,
  markDone,
} from "./event-store.js";

const server = new McpServer({
  name: "github-webhook-mcp",
  version: "0.2.0",
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
    const success = markDone(event_id);
    return {
      content: [
        { type: "text", text: JSON.stringify({ success, event_id }) },
      ],
    };
  }
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
