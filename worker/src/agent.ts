/**
 * McpAgent Durable Object — exposes MCP tools that read from WebhookStore DO.
 * This DO handles MCP protocol; data lives in the separate WebhookStore DO.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  WEBHOOK_STORE: DurableObjectNamespace;
}

export class WebhookMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "github-webhook-mcp",
    version: "1.0.0",
  });

  private getStore() {
    const id = this.env.WEBHOOK_STORE.idFromName("singleton");
    return this.env.WEBHOOK_STORE.get(id);
  }

  async init() {
    this.server.tool(
      "get_pending_status",
      "Get a lightweight snapshot of pending GitHub webhook events",
      {},
      async () => {
        const res = await this.getStore().fetch(new Request("https://store/pending-status"));
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    );

    this.server.tool(
      "list_pending_events",
      "List lightweight summaries for pending GitHub webhook events",
      { limit: z.number().min(1).max(100).default(20) },
      async ({ limit }) => {
        const res = await this.getStore().fetch(
          new Request(`https://store/pending-events?limit=${limit}`),
        );
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    );

    this.server.tool(
      "get_event",
      "Get the full payload for a single webhook event by ID",
      { event_id: z.string() },
      async ({ event_id }) => {
        const res = await this.getStore().fetch(
          new Request(`https://store/event?id=${encodeURIComponent(event_id)}`),
        );
        if (!res.ok) {
          return { content: [{ type: "text", text: `Event ${event_id} not found` }], isError: true };
        }
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    );

    this.server.tool(
      "get_webhook_events",
      "Get pending (unprocessed) GitHub webhook events with full payloads",
      { limit: z.number().min(1).max(100).default(20).optional() },
      async ({ limit }) => {
        const l = limit ?? 20;
        const res = await this.getStore().fetch(
          new Request(`https://store/webhook-events?limit=${l}`),
        );
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    );

    this.server.tool(
      "mark_processed",
      "Mark a webhook event as processed",
      { event_id: z.string() },
      async ({ event_id }) => {
        const res = await this.getStore().fetch(
          new Request("https://store/mark-processed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event_id }),
          }),
        );
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  }
}
