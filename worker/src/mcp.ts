/**
 * MCP server factory exposing the webhook-inbox tools.
 *
 * Tools:
 *   get_pending_status   — lightweight pending snapshot
 *   list_pending_events  — pending summaries, no payloads
 *   get_event            — one event's full payload by id
 *   get_webhook_events   — pending events with full payloads
 *   mark_processed       — clear one event or a batch
 *
 * Protocol revision 2026-07-28 (stateless core, issue #249). The server is
 * built fresh per HTTP request by `createMcpHandler` in `index.ts` — there is
 * no session, no `initialize`, and no Durable Object in the serving path. What
 * `McpAgent` used to provide in two roles is now split: instance resolution
 * from a session ID is gone outright, and tenant identity comes from the OAuth
 * props of the request being served, read through `getMcpAuthContext()`.
 *
 * Multi-tenancy is unchanged in meaning. Each request still resolves to the
 * caller's own WebhookStore DOs via `store-{accountId}`, and a caller whose
 * grant lists several accessible accounts still reads every one of them. What
 * changed is where the account set comes from: an instance field on a
 * per-tenant agent DO before, the request's own props now.
 *
 * The Durable Objects that hold real data (`WebhookStore` / `TenantRegistry`)
 * are untouched; only the MCP-serving DO left the path. Its retired class stub
 * lives in `retired-do.ts` so this module imports nothing from
 * `cloudflare:workers` and stays loadable outside workerd — which is what lets
 * the serving contract be tested in plain node
 * (`test/mcp-stateless-contract.test.ts`).
 */
import { getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PendingStatus, EventSummary, WebhookEvent } from "../../shared/src/types.js";
import { mergeMarkResults, type StoreBatchResponse } from "./mark-results.js";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  WEBHOOK_STORE: DurableObjectNamespace;
  TENANT_REGISTRY: DurableObjectNamespace;
}

/**
 * Upper bound on ids per batched mark_processed call. Matches the 100 ceiling
 * the listing tools use for `limit`, so a batch can always clear one full page
 * of pending events.
 */
const MARK_BATCH_MAX = 100;

/** Tenant context carried on the request's OAuth props. */
export type TenantProps = {
  account_id?: number;
  account_login?: string;
  /** All account IDs (user + orgs) whose stores this request can read */
  accessible_account_ids?: number[];
};

/**
 * The tenant props for the request being served.
 *
 * `index.ts` writes them onto `ctx` before handing the request to the MCP
 * handler; the handler republishes them per request through an
 * AsyncLocalStorage store, which is what `getMcpAuthContext()` reads. There is
 * no instance field to hold them any more — the server object itself lives
 * only for the duration of one request.
 */
function getTenantProps(): TenantProps | undefined {
  return getMcpAuthContext()?.props as TenantProps | undefined;
}

/**
 * Every store name this request may read.
 *
 * Falls back to a single store derived from account_id, then to "singleton".
 * The fallback chain is carried over verbatim from the agent DO: a grant
 * predating the multi-account claim carries account_id only, and the
 * "singleton" tail is the pre-multi-tenant store name.
 */
function getStoreNames(): string[] {
  const props = getTenantProps();
  const ids = props?.accessible_account_ids;
  if (ids && ids.length > 0) {
    return ids.map((id) => `store-${id}`);
  }
  const accountId = props?.account_id;
  if (accountId !== undefined) {
    return [`store-${accountId}`];
  }
  return ["singleton"];
}

function getStores(env: Env): DurableObjectStub[] {
  return getStoreNames().map((name) => {
    const id = env.WEBHOOK_STORE.idFromName(name);
    return env.WEBHOOK_STORE.get(id);
  });
}

/** POST a mark-processed body (singular or batch) to one store. */
function markRequest(store: DurableObjectStub, body: unknown): Promise<Response> {
  return store.fetch(
    new Request("https://store/mark-processed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export function createWebhookMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "github-webhook-mcp",
    version: "1.0.0",
  });

  // ── get_pending_status ──────────────────────────────
  server.registerTool(
    "get_pending_status",
    {
      description: "Get a lightweight snapshot of pending GitHub webhook events",
      inputSchema: z.object({}),
    },
    async () => {
      const stores = getStores(env);
      const results = await Promise.all(
        stores.map((s) =>
          s
            .fetch(new Request("https://store/pending-status"))
            .then((r) => r.json() as Promise<PendingStatus>),
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

      return { content: [{ type: "text" as const, text: JSON.stringify(merged, null, 2) }] };
    },
  );

  // ── list_pending_events ─────────────────────────────
  server.registerTool(
    "list_pending_events",
    {
      description: "List lightweight summaries for pending GitHub webhook events",
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(20),
      }),
    },
    async ({ limit }) => {
      const stores = getStores(env);
      const results = await Promise.all(
        stores.map((s) =>
          s
            .fetch(new Request(`https://store/pending-events?limit=${limit}`))
            .then((r) => r.json() as Promise<EventSummary[]>),
        ),
      );

      const all = results.flat();
      all.sort((a, b) => b.received_at.localeCompare(a.received_at));
      const data = all.slice(0, limit);

      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── get_event ───────────────────────────────────────
  server.registerTool(
    "get_event",
    {
      description: "Get the full payload for a single webhook event by ID",
      inputSchema: z.object({
        event_id: z.string(),
      }),
    },
    async ({ event_id }) => {
      for (const store of getStores(env)) {
        const res = await store.fetch(
          new Request(`https://store/event?id=${encodeURIComponent(event_id)}`),
        );
        if (res.ok) {
          const data = await res.json();
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        }
      }
      return {
        content: [{ type: "text" as const, text: `Event ${event_id} not found` }],
        isError: true,
      };
    },
  );

  // ── get_webhook_events ──────────────────────────────
  server.registerTool(
    "get_webhook_events",
    {
      description: "Get pending (unprocessed) GitHub webhook events with full payloads",
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(20).optional(),
      }),
    },
    async ({ limit }) => {
      const l = limit ?? 20;
      const stores = getStores(env);
      const results = await Promise.all(
        stores.map((s) =>
          s
            .fetch(new Request(`https://store/webhook-events?limit=${l}`))
            .then((r) => r.json() as Promise<WebhookEvent[]>),
        ),
      );

      const all = results.flat();
      all.sort((a, b) => b.received_at.localeCompare(a.received_at));
      const data = all.slice(0, l);

      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── mark_processed ──────────────────────────────────
  server.registerTool(
    "mark_processed",
    {
      description:
        "Mark webhook events as processed. Pass event_ids to clear a whole batch in one call (preferred when several events were handled together); event_id marks a single event.",
      inputSchema: z.object({
        event_id: z.string().optional(),
        // min(1) on the ITEM, not just the array: an empty-string id would pass
        // schema validation, miss in every store, and reach the caller as
        // "not found" — a misleading verdict for what is really a malformed
        // request. Rejecting it here keeps "not found" the only per-id error.
        event_ids: z.array(z.string().min(1)).min(1).max(MARK_BATCH_MAX).optional(),
      }),
    },
    async ({ event_id, event_ids }) => {
      const stores = getStores(env);

      // ── Batch form (#245): one round trip for N ids ──
      if (event_ids) {
        const perStore = await Promise.all(
          stores.map((s) =>
            markRequest(s, { event_ids }).then((r) => r.json() as Promise<StoreBatchResponse>),
          ),
        );

        // Per-id verdict resolution across the fan-out lives in
        // mark-results.ts (unit-tested there).
        const summary = mergeMarkResults(event_ids, perStore);
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      }

      // ── Singular form: response shape unchanged ──
      if (!event_id) {
        return {
          content: [
            { type: "text" as const, text: "mark_processed requires event_id or event_ids" },
          ],
          isError: true,
        };
      }
      // Try all stores — the event lives in exactly one, others are no-ops
      const results = await Promise.all(
        stores.map((s) => markRequest(s, { event_id }).then((r) => r.json())),
      );
      // Return the first successful result
      return { content: [{ type: "text" as const, text: JSON.stringify(results[0]) }] };
    },
  );

  return server;
}
