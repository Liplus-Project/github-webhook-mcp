// Minimal worker entry for the Workers-pool Durable Object tests. Re-exports just
// the two SQLite-backed DOs (WebhookStore / TenantRegistry) so the test pool can
// bind them without loading the full worker graph (mcp/oauth/index + OAuth KV
// bindings). Both DOs self-initialize their schema on first fetch, so no
// migration step is needed.
export { WebhookStore } from "./store.js";
export { TenantRegistry } from "./tenant.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("test-only entry");
  },
};
