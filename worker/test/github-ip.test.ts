/**
 * Unit tests for worker/src/github-ip.ts (#223).
 *
 * Two surfaces:
 *   - ipMatchesCIDRs: pure IPv4 CIDR membership math (boundaries, /32, /0,
 *     IPv6-CIDR skip, IPv6 / unparseable client passthrough).
 *   - isGitHubWebhookIP: the request-level guard. The GitHub-meta fetch is
 *     stubbed to fail so the function falls back to the hardcoded FALLBACK_CIDRS
 *     deterministically (no real network in CI).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ipMatchesCIDRs, isGitHubWebhookIP } from "../src/github-ip.js";

// A GitHub webhook range from the hardcoded fallback list.
const GH_RANGE = "140.82.112.0/20"; // covers 140.82.112.0 – 140.82.127.255

// ── ipMatchesCIDRs: membership math ──────────────────────────────────

test("matches an address inside a /20 range", () => {
  assert.equal(ipMatchesCIDRs("140.82.112.5", [GH_RANGE]), true);
  assert.equal(ipMatchesCIDRs("140.82.120.200", [GH_RANGE]), true);
});

test("respects /20 range boundaries", () => {
  assert.equal(ipMatchesCIDRs("140.82.127.255", [GH_RANGE]), true, "last addr in range");
  assert.equal(ipMatchesCIDRs("140.82.128.0", [GH_RANGE]), false, "first addr past range");
  assert.equal(ipMatchesCIDRs("140.82.111.255", [GH_RANGE]), false, "addr just below range");
});

test("rejects an address outside every CIDR", () => {
  assert.equal(ipMatchesCIDRs("8.8.8.8", [GH_RANGE, "185.199.108.0/22"]), false);
});

test("/32 matches only the exact host", () => {
  assert.equal(ipMatchesCIDRs("1.2.3.4", ["1.2.3.4/32"]), true);
  assert.equal(ipMatchesCIDRs("1.2.3.5", ["1.2.3.4/32"]), false);
});

test("/0 matches any IPv4 address", () => {
  assert.equal(ipMatchesCIDRs("203.0.113.7", ["0.0.0.0/0"]), true);
});

test("IPv6 CIDRs in the list are skipped (no match for an IPv4 client)", () => {
  assert.equal(ipMatchesCIDRs("8.8.8.8", ["2606:50c0::/32"]), false);
});

test("IPv6 client address passes through as true", () => {
  assert.equal(ipMatchesCIDRs("2606:50c0::1", [GH_RANGE]), true);
});

test("unparseable IPv4 (octet > 255) passes through as true", () => {
  // parseIPv4 returns null → treated as the IPv6/passthrough branch.
  assert.equal(ipMatchesCIDRs("999.1.1.1", [GH_RANGE]), true);
});

// ── isGitHubWebhookIP: request guard ─────────────────────────────────

test("isGitHubWebhookIP allows requests without CF-Connecting-IP (local dev)", async () => {
  const req = new Request("https://worker/webhooks/github", { method: "POST" });
  assert.equal(await isGitHubWebhookIP(req), true);
});

test("isGitHubWebhookIP allows a GitHub-range IP via the fallback list", async () => {
  const realFetch = globalThis.fetch;
  // Force the meta fetch to fail so getGitHubHookCIDRs uses FALLBACK_CIDRS.
  globalThis.fetch = (async () => { throw new Error("network disabled in test"); }) as typeof fetch;
  try {
    const req = new Request("https://worker/webhooks/github", {
      method: "POST",
      headers: { "CF-Connecting-IP": "140.82.112.50" },
    });
    assert.equal(await isGitHubWebhookIP(req), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("isGitHubWebhookIP blocks a non-GitHub IP via the fallback list", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network disabled in test"); }) as typeof fetch;
  try {
    const req = new Request("https://worker/webhooks/github", {
      method: "POST",
      headers: { "CF-Connecting-IP": "8.8.8.8" },
    });
    assert.equal(await isGitHubWebhookIP(req), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
