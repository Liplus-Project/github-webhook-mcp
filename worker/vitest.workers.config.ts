import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Workers-realistic pool: runs test/workers/**/*.test.ts inside workerd with the
// two SQLite-backed Durable Objects (WebhookStore / TenantRegistry). No D1 and no
// migrations here — the DOs self-initialize their schema (CREATE TABLE IF NOT
// EXISTS) on first fetch. The DOs are loaded from a minimal entry
// (src/test-do-entry.ts) that exports only those two classes, so the full worker
// graph (mcp/oauth/index + OAuth KV) is never bound.
//
// vitest 4 wiring: cloudflareTest() is a Vite plugin (provides the `cloudflare:test`
// module + transforms); cloudflarePool() is the pool runner for `test.pool`.
const workersOptions = {
  main: "src/test-do-entry.ts",
  singleWorker: true,
  miniflare: {
    compatibilityDate: "2025-03-26",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      WEBHOOK_STORE: { className: "WebhookStore", useSQLite: true },
      TENANT_REGISTRY: { className: "TenantRegistry", useSQLite: true },
    },
  },
};

export default defineConfig({
  plugins: [cloudflareTest(workersOptions)],
  test: {
    include: ["test/workers/**/*.test.ts"],
    pool: cloudflarePool(workersOptions),
  },
});
