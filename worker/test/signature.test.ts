/**
 * Unit tests for worker/src/signature.ts (#227, constant-time switch in #229).
 *
 * verifyGitHubSignature is the webhook trust boundary: it must accept a body
 * signed with the matching secret and reject every other case. The primary
 * oracle is GitHub's OWN published example vector from "Validating webhook
 * deliveries" (secret / body / signature below), which cross-checks the impl
 * against GitHub's real contract independently of any code under test. An
 * independent node:crypto createHmac oracle is also kept for additional
 * generated cases.
 *
 * #229 switched the internal compare from a non-constant-time `===` (which
 * early-exits and leaks the expected signature through timing) to
 * crypto.subtle.verify (constant-time internal compare). The timing property
 * itself is not unit-observable; these tests pin the FUNCTIONAL contract that
 * the constant-time implementation preserves. crypto.subtle exists in Node 20+,
 * so this runs as a pure tsx --test unit test (no Miniflare).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyGitHubSignature } from "../src/signature.js";

// GitHub's published example vector ("Validating webhook deliveries" docs).
const SECRET = "It's a Secret to Everybody";
const BODY = "Hello, World!";
const VALID =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

/** Independent oracle: GitHub's X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 hex. */
function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// ── Valid case (GitHub's published example vector) ───────────────────

test("accepts GitHub's published example vector", async () => {
  assert.equal(await verifyGitHubSignature(SECRET, BODY, VALID), true);
});

// ── Tampered body ────────────────────────────────────────────────────

test("rejects when the body was tampered after signing", async () => {
  // Verify a different body against the signature for the original body.
  assert.equal(await verifyGitHubSignature(SECRET, "Hello, World?", VALID), false);
});

// ── Wrong secret ─────────────────────────────────────────────────────

test("rejects when verified with a different secret", async () => {
  assert.equal(await verifyGitHubSignature("wrong-secret", BODY, VALID), false);
});

// ── Malformed signature formats ──────────────────────────────────────

test("rejects a signature without the sha256= prefix", async () => {
  // Bare hex, no "sha256=" prefix.
  const bareHex = createHmac("sha256", SECRET).update(BODY).digest("hex");
  assert.equal(await verifyGitHubSignature(SECRET, BODY, bareHex), false);
});

test("rejects an empty signature string", async () => {
  assert.equal(await verifyGitHubSignature(SECRET, BODY, ""), false);
});

test("rejects a sha256=-prefixed hex of the wrong length", async () => {
  assert.equal(await verifyGitHubSignature(SECRET, BODY, "sha256=deadbeef"), false);
});

test("rejects a sha256=-prefixed non-hex string of the right length", async () => {
  assert.equal(
    await verifyGitHubSignature(SECRET, BODY, "sha256=" + "z".repeat(64)),
    false,
  );
});
