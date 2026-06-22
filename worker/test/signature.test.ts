/**
 * Unit tests for worker/src/signature.ts (#227).
 *
 * verifyGitHubSignature is the webhook trust boundary: it must accept a body
 * signed with the matching secret and reject every other case. The expected
 * valid signature is generated INDEPENDENTLY via Node's node:crypto
 * (createHmac → "sha256=" + hex digest), giving an oracle that does not call
 * the function under test. crypto.subtle exists in Node 20+, so this runs as a
 * pure tsx --test unit test (no Miniflare).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyGitHubSignature } from "../src/signature.js";

const SECRET = "s3cr3t-webhook-key";
const BODY = JSON.stringify({ action: "opened", number: 42 });

/** Independent oracle: GitHub's X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 hex. */
function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// ── Valid case ───────────────────────────────────────────────────────

test("accepts a signature generated with the same secret and body", async () => {
  const signature = sign(SECRET, BODY);
  assert.equal(await verifyGitHubSignature(SECRET, BODY, signature), true);
});

// ── Tampered body ────────────────────────────────────────────────────

test("rejects when the body was tampered after signing", async () => {
  // Sign body A, verify against body B.
  const signature = sign(SECRET, BODY);
  const tamperedBody = JSON.stringify({ action: "opened", number: 9999 });
  assert.equal(await verifyGitHubSignature(SECRET, tamperedBody, signature), false);
});

// ── Wrong secret ─────────────────────────────────────────────────────

test("rejects when verified with a different secret", async () => {
  const signature = sign(SECRET, BODY);
  assert.equal(await verifyGitHubSignature("wrong-secret", BODY, signature), false);
});

// ── Malformed signature formats ──────────────────────────────────────

test("rejects an empty signature string", async () => {
  assert.equal(await verifyGitHubSignature(SECRET, BODY, ""), false);
});

test("rejects a signature without the sha256= prefix", async () => {
  // Same hex digest but missing the "sha256=" prefix.
  const hexOnly = createHmac("sha256", SECRET).update(BODY).digest("hex");
  assert.equal(await verifyGitHubSignature(SECRET, BODY, hexOnly), false);
});

test("rejects a sha256=-prefixed hex of the wrong length", async () => {
  // Truncated digest (valid prefix, too few hex chars).
  const shortHex = createHmac("sha256", SECRET).update(BODY).digest("hex").slice(0, 32);
  assert.equal(await verifyGitHubSignature(SECRET, BODY, "sha256=" + shortHex), false);
});
