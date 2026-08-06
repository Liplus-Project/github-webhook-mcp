/**
 * Retired MCP-serving Durable Object class.
 *
 * `WebhookMcpAgent` is retained solely to satisfy Cloudflare's "class must
 * exist in script for classes declared in past migrations" constraint (the
 * `v2` migration declares it). It receives no live traffic since the stateless
 * flip (issue #249): `/mcp` is served per request by `createMcpHandler`, so no
 * session ID resolves to a DO instance any more. The class exists only so
 * `wrangler deploy` does not fail with "script does not export class
 * 'WebhookMcpAgent'". Deleting it needs a `deleted_classes` migration, which
 * is a separate, destructive change.
 *
 * It lives apart from `mcp.ts` so that file imports nothing from
 * `cloudflare:workers` and stays loadable outside workerd — which is what lets
 * the stateless serving contract be tested in plain node
 * (`test/mcp-stateless-contract.test.ts`).
 *
 * The Durable Objects that hold real data (`WebhookStore`, `TenantRegistry`)
 * are untouched by the flip; only the MCP-serving class left the path.
 */

import { DurableObject } from "cloudflare:workers";

export class WebhookMcpAgent extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("WebhookMcpAgent has been retired; /mcp is served statelessly", {
      status: 410,
    });
  }
}
