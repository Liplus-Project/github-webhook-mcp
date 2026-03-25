/**
 * McpAgent Durable Object — stores webhook events in SQLite,
 * exposes MCP tools for querying them.
 */
import { McpAgent } from "@cloudflare/agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebhookEvent, EventSummary, PendingStatus } from "../../shared/src/types.js";
import { summarizeEvent } from "../../shared/src/summarize.js";

interface Env {
  WEBHOOK_DO: DurableObjectNamespace;
  GITHUB_WEBHOOK_SECRET?: string;
}

export class WebhookMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "github-webhook-mcp",
    version: "1.0.0",
  });

  async init() {
    // Ensure SQLite table exists
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        trigger_status TEXT,
        last_triggered_at TEXT,
        payload TEXT NOT NULL
      )
    `);

    // ── MCP Tools ──────────────────────────────────────────

    this.server.tool(
      "get_pending_status",
      "Get a lightweight snapshot of pending GitHub webhook events",
      {},
      async () => {
        const rows = this.ctx.storage.sql.exec(
          `SELECT type, COUNT(*) as cnt FROM events WHERE processed = 0 GROUP BY type`,
        ).toArray();

        const latestRow = this.ctx.storage.sql.exec(
          `SELECT received_at FROM events WHERE processed = 0 ORDER BY received_at DESC LIMIT 1`,
        ).toArray();

        const types: Record<string, number> = {};
        let total = 0;
        for (const row of rows) {
          types[row.type as string] = row.cnt as number;
          total += row.cnt as number;
        }

        const status: PendingStatus = {
          pending_count: total,
          latest_received_at: latestRow.length > 0 ? latestRow[0].received_at as string : null,
          types,
        };

        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      },
    );

    this.server.tool(
      "list_pending_events",
      "List lightweight summaries for pending GitHub webhook events",
      { limit: z.number().min(1).max(100).default(20) },
      async ({ limit }) => {
        const rows = this.ctx.storage.sql.exec(
          `SELECT * FROM events WHERE processed = 0 ORDER BY received_at DESC LIMIT ?`,
          limit,
        ).toArray();

        const summaries: EventSummary[] = rows.map((row) => {
          const event: WebhookEvent = {
            id: row.id as string,
            type: row.type as string,
            received_at: row.received_at as string,
            processed: (row.processed as number) === 1,
            trigger_status: row.trigger_status as string | null,
            last_triggered_at: row.last_triggered_at as string | null,
            payload: JSON.parse(row.payload as string),
          };
          return summarizeEvent(event);
        });

        return { content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }] };
      },
    );

    this.server.tool(
      "get_event",
      "Get the full payload for a single webhook event by ID",
      { event_id: z.string() },
      async ({ event_id }) => {
        const rows = this.ctx.storage.sql.exec(
          `SELECT * FROM events WHERE id = ?`,
          event_id,
        ).toArray();

        if (rows.length === 0) {
          return { content: [{ type: "text", text: `Event ${event_id} not found` }], isError: true };
        }

        const row = rows[0];
        const event: WebhookEvent = {
          id: row.id as string,
          type: row.type as string,
          received_at: row.received_at as string,
          processed: (row.processed as number) === 1,
          trigger_status: row.trigger_status as string | null,
          last_triggered_at: row.last_triggered_at as string | null,
          payload: JSON.parse(row.payload as string),
        };

        return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
      },
    );

    this.server.tool(
      "mark_processed",
      "Mark a webhook event as processed",
      { event_id: z.string() },
      async ({ event_id }) => {
        const result = this.ctx.storage.sql.exec(
          `UPDATE events SET processed = 1 WHERE id = ?`,
          event_id,
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, event_id }),
          }],
        };
      },
    );
  }

  /** Called by Worker when a webhook is received */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ingest" && request.method === "POST") {
      const event = await request.json() as WebhookEvent;

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO events (id, type, received_at, processed, trigger_status, last_triggered_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.type,
        event.received_at,
        event.processed ? 1 : 0,
        event.trigger_status ?? null,
        event.last_triggered_at ?? null,
        JSON.stringify(event.payload),
      );

      return new Response(JSON.stringify({ stored: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
