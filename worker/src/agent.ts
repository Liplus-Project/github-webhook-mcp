/**
 * McpAgent Durable Object — exposes MCP tools that read from WebhookStore DO.
 * This DO handles MCP protocol; data lives in the separate WebhookStore DO.
 *
 * Per-tenant: each tenant gets its own McpAgent instance via
 * getAgentByName("tenant-{accountId}"). The agent routes getStore()
 * to a tenant-specific WebhookStore DO using idFromName("store-{accountId}").
 *
 * Multi-account: when accessible_account_ids is set (user + orgs), tools
 * aggregate results from all accessible stores to surface org events.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PendingStatus, EventSummary, WebhookEvent } from "../../shared/src/types.js";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  WEBHOOK_STORE: DurableObjectNamespace;
  TENANT_REGISTRY: DurableObjectNamespace;
}

/** Tenant context passed via props when creating per-tenant instances */
export interface TenantProps {
  account_id?: number;
  account_login?: string;
  account_type?: string;
  /** All account IDs (user + orgs) whose stores this session can read */
  accessible_account_ids?: number[];
}

export class WebhookMcpAgent extends McpAgent<Env, unknown, TenantProps> {
  server = new McpServer({
    name: "github-webhook-mcp",
    version: "1.0.0",
  });

  /**
   * Returns all store names this session can access.
   * Falls back to a single store derived from account_id or "singleton".
   */
  private getStoreNames(): string[] {
    const ids = this.props?.accessible_account_ids;
    if (ids && ids.length > 0) {
      return ids.map((id) => `store-${id}`);
    }
    const accountId = this.props?.account_id;
    if (accountId !== undefined) {
      return [`store-${accountId}`];
    }
    return ["singleton"];
  }

  private getStores(): DurableObjectStub[] {
    return this.getStoreNames().map((name) => {
      const id = this.env.WEBHOOK_STORE.idFromName(name);
      return this.env.WEBHOOK_STORE.get(id);
    });
  }

  async init() {
    this.server.tool(
      "get_pending_status",
      "Get a lightweight snapshot of pending GitHub webhook events",
      {},
      async () => {
        const stores = this.getStores();
        const results = await Promise.all(
          stores.map((s) =>
            s.fetch(new Request("https://store/pending-status")).then((r) => r.json() as Promise<PendingStatus>),
          ),
        );

        const merged: PendingStatus = {
          pending_count: 0,
          latest_received_at: null,
          types: {},
        };
        for (const data of results) {
          merged.pending_count += data.pending_count;
          if (data.latest_received_at) {
            if (!merged.latest_received_at || data.latest_received_at > merged.latest_received_at) {
              merged.latest_received_at = data.latest_received_at;
            }
          }
          for (const [type, count] of Object.entries(data.types || {})) {
            merged.types[type] = (merged.types[type] || 0) + count;
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(merged, null, 2) }] };
      },
    );

    this.server.tool(
      "list_pending_events",
      "List lightweight summaries for pending GitHub webhook events",
      { limit: z.number().min(1).max(100).default(20) },
      async ({ limit }) => {
        const stores = this.getStores();
        const results = await Promise.all(
          stores.map((s) =>
            s.fetch(new Request(`https://store/pending-events?limit=${limit}`)).then((r) => r.json() as Promise<EventSummary[]>),
          ),
        );

        const all = results.flat();
        all.sort((a, b) => b.received_at.localeCompare(a.received_at));
        const data = all.slice(0, limit);

        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    );

    this.server.tool(
      "get_event",
      "Get the full payload for a single webhook event by ID",
      { event_id: z.string() },
      async ({ event_id }) => {
        for (const store of this.getStores()) {
          const res = await store.fetch(
            new Request(`https://store/event?id=${encodeURIComponent(event_id)}`),
          );
          if (res.ok) {
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
          }
        }
        return { content: [{ type: "text", text: `Event ${event_id} not found` }], isError: true };
      },
    );

    this.server.tool(
      "get_webhook_events",
      "Get pending (unprocessed) GitHub webhook events with full payloads",
      { limit: z.number().min(1).max(100).default(20).optional() },
      async ({ limit }) => {
        const l = limit ?? 20;
        const stores = this.getStores();
        const results = await Promise.all(
          stores.map((s) =>
            s.fetch(new Request(`https://store/webhook-events?limit=${l}`)).then((r) => r.json() as Promise<WebhookEvent[]>),
          ),
        );

        const all = results.flat();
        all.sort((a, b) => b.received_at.localeCompare(a.received_at));
        const data = all.slice(0, l);

        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    );

    this.server.tool(
      "mark_processed",
      "Mark a webhook event as processed",
      { event_id: z.string() },
      async ({ event_id }) => {
        // Try all stores — the event lives in exactly one, others are no-ops
        const stores = this.getStores();
        const results = await Promise.all(
          stores.map((s) =>
            s.fetch(
              new Request("https://store/mark-processed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_id }),
              }),
            ).then((r) => r.json()),
          ),
        );
        // Return the first successful result
        return { content: [{ type: "text", text: JSON.stringify(results[0]) }] };
      },
    );
  }
}
