import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { TenantInfo, TenantQuota } from "../../src/tenant.js";

// Each test uses a uniquely-named DO instance for storage isolation. TenantRegistry
// self-initializes its schema on first fetch (idempotent CREATE TABLE IF NOT
// EXISTS). Behavior is exposed via fetch routes (not public methods), so tests
// drive it through stub.fetch(). Default events_limit per tenant is 10000.
function registryFor(name: string) {
  return env.TENANT_REGISTRY.get(env.TENANT_REGISTRY.idFromName(name));
}

const BASE = "https://do";

function post(stub: DurableObjectStub, route: string, body: unknown) {
  return stub.fetch(new Request(`${BASE}${route}`, { method: "POST", body: JSON.stringify(body) }));
}

function createInstallation(
  stub: DurableObjectStub,
  over: Partial<{ installation_id: number; account_id: number; account_login: string; account_type: string }> = {},
) {
  return post(stub, "/installation-created", {
    installation_id: 100,
    account_id: 200,
    account_login: "octo",
    account_type: "Organization",
    ...over,
  });
}

describe("TenantRegistry: installation-created + resolve", () => {
  it("registers an installation and resolves it to tenant info", async () => {
    const stub = registryFor("resolve-found");
    const created = await createInstallation(stub, { installation_id: 1, account_id: 11, account_login: "alice", account_type: "User" });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ registered: true, account_id: 11 });

    const res = await stub.fetch(new Request(`${BASE}/resolve?installation_id=1`));
    expect(res.status).toBe(200);
    const info = (await res.json()) as TenantInfo;
    expect(info).toEqual({ account_id: 11, account_login: "alice", account_type: "User" });
  });

  it("creates a quota row (events_stored=0, events_limit=10000) on registration", async () => {
    const stub = registryFor("quota-row-created");
    await createInstallation(stub, { installation_id: 2, account_id: 22 });

    const res = await stub.fetch(new Request(`${BASE}/quota?account_id=22`));
    expect(res.status).toBe(200);
    const quota = (await res.json()) as TenantQuota;
    expect(quota).toEqual({ account_id: 22, events_stored: 0, events_limit: 10000 });
  });

  it("returns 404 when resolving an unknown installation", async () => {
    const stub = registryFor("resolve-unknown");
    const res = await stub.fetch(new Request(`${BASE}/resolve?installation_id=999`));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("installation not found");
  });
});

describe("TenantRegistry: installation-deleted", () => {
  it("reports has_other_installations=false when the account's last installation is removed", async () => {
    const stub = registryFor("delete-last");
    await createInstallation(stub, { installation_id: 10, account_id: 50 });

    const res = await post(stub, "/installation-deleted", { installation_id: 10 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, account_id: 50, has_other_installations: false });

    // mapping is gone now
    const resolve = await stub.fetch(new Request(`${BASE}/resolve?installation_id=10`));
    expect(resolve.status).toBe(404);
  });

  it("reports has_other_installations=true when the account still has another installation", async () => {
    const stub = registryFor("delete-not-last");
    await createInstallation(stub, { installation_id: 20, account_id: 60 });
    await createInstallation(stub, { installation_id: 21, account_id: 60 });

    const res = await post(stub, "/installation-deleted", { installation_id: 20 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, account_id: 60, has_other_installations: true });
  });

  it("reports deleted=false for an unknown installation", async () => {
    const stub = registryFor("delete-unknown");
    const res = await post(stub, "/installation-deleted", { installation_id: 777 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: false, reason: "installation not found" });
  });
});

describe("TenantRegistry: quota-check (gate + atomic increment)", () => {
  it("allows and increments stored when within limit", async () => {
    const stub = registryFor("quota-check-allow");
    await createInstallation(stub, { installation_id: 30, account_id: 70 });

    const res = await post(stub, "/quota-check", { account_id: 70 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, events_stored: 1, events_limit: 10000 });

    // increment is persisted
    const quota = (await (await stub.fetch(new Request(`${BASE}/quota?account_id=70`))).json()) as TenantQuota;
    expect(quota.events_stored).toBe(1);
  });

  it("rejects with 429 when stored is at/over the limit within an active window, without incrementing", async () => {
    const stub = registryFor("quota-check-at-limit");
    await createInstallation(stub, { installation_id: 31, account_id: 71 });

    // Open the window with one real check (events_stored=1, window_started_at=now),
    // then push the rest of the way to the limit (10000) within that same window
    // via a single delta increment, avoiding 10000 individual calls.
    const first = await post(stub, "/quota-check", { account_id: 71 });
    expect(await first.json()).toEqual({ allowed: true, events_stored: 1, events_limit: 10000 });
    const inc = await post(stub, "/quota-increment", { account_id: 71, delta: 9999 });
    expect(inc.status).toBe(200);
    expect(await inc.json()).toEqual({ events_stored: 10000, events_limit: 10000, over_limit: false });

    // stored (10000) >= limit (10000), window still active -> 429
    const res = await post(stub, "/quota-check", { account_id: 71 });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      allowed: false,
      events_stored: 10000,
      events_limit: 10000,
      reason: "quota exceeded",
    });

    // no increment happened on the rejected check
    const quota = (await (await stub.fetch(new Request(`${BASE}/quota?account_id=71`))).json()) as TenantQuota;
    expect(quota.events_stored).toBe(10000);
  });

  it("resets a stale window (events_stored at limit, window_started_at=0) instead of 429ing forever (#231)", async () => {
    const stub = registryFor("quota-check-stale-window-reset");
    await createInstallation(stub, { installation_id: 32, account_id: 72 });

    // Reproduce the pre-fix lockout: events_stored pushed to the limit while
    // window_started_at stays 0 (the migrated monotonic-counter state). Before
    // the fix this 429'd permanently; the zero/elapsed window now resets it.
    await post(stub, "/quota-increment", { account_id: 72, delta: 10000 });

    const res = await post(stub, "/quota-check", { account_id: 72 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, events_stored: 1, events_limit: 10000 });

    // the counter was reset to 1 (this event), not left at the locked 10000
    const quota = (await (await stub.fetch(new Request(`${BASE}/quota?account_id=72`))).json()) as TenantQuota;
    expect(quota.events_stored).toBe(1);
  });

  it("returns 404 for an unknown tenant", async () => {
    const stub = registryFor("quota-check-unknown");
    const res = await post(stub, "/quota-check", { account_id: 9999 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ allowed: false, reason: "tenant not found" });
  });
});

describe("TenantRegistry: quota (GET)", () => {
  it("returns the quota snapshot when found", async () => {
    const stub = registryFor("quota-get-found");
    await createInstallation(stub, { installation_id: 40, account_id: 80 });

    const res = await stub.fetch(new Request(`${BASE}/quota?account_id=80`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_id: 80, events_stored: 0, events_limit: 10000 });
  });

  it("returns 404 for an unknown tenant", async () => {
    const stub = registryFor("quota-get-unknown");
    const res = await stub.fetch(new Request(`${BASE}/quota?account_id=12345`));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tenant not found");
  });
});

describe("TenantRegistry: quota-increment", () => {
  it("increments stored and surfaces over_limit when stored exceeds limit", async () => {
    const stub = registryFor("quota-increment-over");
    await createInstallation(stub, { installation_id: 50, account_id: 90 });

    const res = await post(stub, "/quota-increment", { account_id: 90, delta: 10001 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events_stored: 10001, events_limit: 10000, over_limit: true });
  });

  it("returns 404 for an unknown tenant", async () => {
    const stub = registryFor("quota-increment-unknown");
    const res = await post(stub, "/quota-increment", { account_id: 4242 });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tenant not found");
  });
});

describe("TenantRegistry: quota-decrement", () => {
  it("decrements stored and clamps at 0 (never negative)", async () => {
    const stub = registryFor("quota-decrement-clamp");
    await createInstallation(stub, { installation_id: 60, account_id: 95 });

    // bring stored to 3
    await post(stub, "/quota-increment", { account_id: 95, delta: 3 });

    // decrement by 5 -> clamps at 0
    const res = await post(stub, "/quota-decrement", { account_id: 95, delta: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decremented: true });

    const quota = (await (await stub.fetch(new Request(`${BASE}/quota?account_id=95`))).json()) as TenantQuota;
    expect(quota.events_stored).toBe(0);
  });
});

describe("TenantRegistry: unknown route", () => {
  it("returns 404 for an unrecognized path", async () => {
    const stub = registryFor("unknown-route");
    const res = await stub.fetch(new Request(`${BASE}/nope`));
    expect(res.status).toBe(404);
  });
});
