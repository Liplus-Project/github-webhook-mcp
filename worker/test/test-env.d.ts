// Ambient declaration of the vitest-pool-workers `cloudflare:test` virtual module,
// scoped to just what the test/workers/**/*.test.ts files use. Declared by hand
// (instead of `/// <reference types="@cloudflare/vitest-pool-workers/types" />`)
// so the worker's `tsc --noEmit` does not pull a newer @cloudflare/workers-types
// whose stricter binding types could conflict with existing src code.
// DurableObjectNamespace / DurableObjectStub are global via the worker's
// @cloudflare/workers-types.

declare module "cloudflare:test" {
  interface ProvidedEnv {
    WEBHOOK_STORE: DurableObjectNamespace<import("../src/store.js").WebhookStore>;
    TENANT_REGISTRY: DurableObjectNamespace<import("../src/tenant.js").TenantRegistry>;
  }
  export const env: ProvidedEnv;
}
