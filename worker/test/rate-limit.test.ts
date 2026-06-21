/**
 * Unit tests for worker/src/rate-limit.ts (#223).
 *
 * Covers the in-memory sliding-window limiter (webhook 300/min, api 120/min),
 * window reset after expiry, the DO-backed checkTenantQuota branch logic, and
 * the 429 helper. The limiter keeps module-level per-key state, so each test
 * uses a unique IP to stay independent of the others.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkWebhookRateLimit,
  checkApiRateLimit,
  checkTenantQuota,
  rateLimitResponse,
} from "../src/rate-limit.js";

// ── Sliding window limits ────────────────────────────────────────────

test("webhook limiter allows exactly 300 requests then blocks", () => {
  const ip = "10.0.0.1";
  for (let i = 1; i <= 300; i++) {
    assert.equal(checkWebhookRateLimit(ip), true, `request ${i} should pass`);
  }
  assert.equal(checkWebhookRateLimit(ip), false, "301st request must be blocked");
});

test("api limiter allows exactly 120 requests then blocks", () => {
  const ip = "10.0.0.2";
  for (let i = 1; i <= 120; i++) {
    assert.equal(checkApiRateLimit(ip), true, `request ${i} should pass`);
  }
  assert.equal(checkApiRateLimit(ip), false, "121st request must be blocked");
});

test("webhook and api counters are independent for the same IP", () => {
  const ip = "10.0.0.3";
  // Exhaust webhook budget.
  for (let i = 0; i < 300; i++) checkWebhookRateLimit(ip);
  assert.equal(checkWebhookRateLimit(ip), false, "webhook exhausted");
  // API budget for the same IP is untouched.
  assert.equal(checkApiRateLimit(ip), true, "api budget independent");
});

test("counter resets after the window expires", () => {
  const ip = "10.0.0.4";
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 120; i++) checkApiRateLimit(ip);
    assert.equal(checkApiRateLimit(ip), false, "blocked within the window");
    // Advance past the 60s window.
    t += 60_001;
    assert.equal(checkApiRateLimit(ip), true, "allowed again after window reset");
  } finally {
    Date.now = realNow;
  }
});

// ── checkTenantQuota: DO-backed branch logic ─────────────────────────

/** Minimal DurableObjectStub mock that returns a fixed response and records the request. */
function stubRegistry(response: Response, captured?: { req?: Request }) {
  return {
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (captured) captured.req = req;
      return response;
    },
  } as unknown as DurableObjectStub;
}

test("checkTenantQuota allows when the registry returns 200", async () => {
  const captured: { req?: Request } = {};
  const registry = stubRegistry(
    Response.json({ allowed: true, events_stored: 1, events_limit: 10000 }),
    captured,
  );
  const result = await checkTenantQuota(registry, 42);
  assert.deepEqual(result, { allowed: true });
  // It posts to the /quota-check endpoint with the account_id.
  assert.equal(captured.req!.method, "POST");
  assert.match(captured.req!.url, /\/quota-check$/);
  assert.deepEqual(await captured.req!.json(), { account_id: 42 });
});

test("checkTenantQuota blocks with a 429 response when the registry returns 429", async () => {
  const registry = stubRegistry(
    Response.json({ allowed: false, reason: "quota exceeded" }, { status: 429 }),
  );
  const result = await checkTenantQuota(registry, 7);
  assert.equal(result.allowed, false);
  if (result.allowed === false) {
    assert.equal(result.response.status, 429);
    assert.equal(result.response.headers.get("Retry-After"), "3600");
    assert.deepEqual(await result.response.json(), { error: "tenant quota exceeded" });
  }
});

test("checkTenantQuota passes through (allowed) on 404 unknown tenant", async () => {
  const registry = stubRegistry(
    Response.json({ allowed: false, reason: "tenant not found" }, { status: 404 }),
  );
  const result = await checkTenantQuota(registry, 999);
  // 404 is left to downstream tenant resolution; the quota gate does not block.
  assert.deepEqual(result, { allowed: true });
});

// ── 429 helper ───────────────────────────────────────────────────────

test("rateLimitResponse returns 429 with Retry-After: 60", async () => {
  const res = rateLimitResponse();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(await res.text(), "Too Many Requests");
});
