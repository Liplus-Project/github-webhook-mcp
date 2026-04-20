/**
 * Black-box contract tests for the v0.11.1 device-flow UX response shape.
 *
 * The behaviour exercised here is the "auth-required" tool result that the
 * MCP client returns when a tool call arrives before the user has approved
 * the device code (see mcp-server/server/index.js :: formatAuthRequiredResponse
 * and its TypeScript twin in local-mcp/src/index.ts).
 *
 * We re-implement the user-visible contract inline because the module cannot
 * be imported without starting an MCP server (top-level await on mcp.connect).
 * The assertions cover the invariants that the Claude Code / Desktop UX
 * depends on:
 *   - the response surfaces a clickable URL (verification_uri_complete
 *     preferred over verification_uri)
 *   - the user_code is always included, even when the complete URL is present
 *   - the response is marked isError=true so hosts render it as a failed tool
 *     call the user can retry
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/** Mirrors formatAuthRequiredResponse() in server/index.js. */
function formatAuthRequiredResponse(pending) {
  const parts = [];
  parts.push("OAuth device authorization required.");
  parts.push("");
  if (pending.verification_uri_complete) {
    parts.push(`Open (code pre-filled): ${pending.verification_uri_complete}`);
    parts.push("");
    parts.push(`Or visit ${pending.verification_uri} and enter the code:`);
  } else {
    parts.push(`Visit: ${pending.verification_uri}`);
    parts.push("Enter the code:");
  }
  parts.push(`  ${pending.user_code}`);
  parts.push("");
  if (pending.expires_at) {
    const remainingMs = pending.expires_at - Date.now();
    if (remainingMs > 0) {
      const mins = Math.max(1, Math.round(remainingMs / 60_000));
      parts.push(`Code expires in about ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
  }
  parts.push(
    "A browser window should have opened automatically. " +
      "Retry the same tool call after approving — subsequent calls will succeed once authorization completes.",
  );
  return parts.join("\n");
}

/** Shape the tool handler returns when the device flow is pending. */
function buildAuthRequiredToolResult(pending) {
  return {
    content: [{ type: "text", text: formatAuthRequiredResponse(pending) }],
    isError: true,
  };
}

test("auth-required response prefers verification_uri_complete and still includes the raw code", () => {
  const pending = {
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    verification_uri_complete:
      "https://github.com/login/device?user_code=WDJB-MJHT",
    expires_at: Date.now() + 600_000,
  };
  const result = buildAuthRequiredToolResult(pending);

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const text = result.content[0].text;

  // Both surfaces must be present: the preferred pre-filled URL AND the raw
  // code (some hosts strip hyperlinks or trim long URLs).
  assert.ok(
    text.includes(pending.verification_uri_complete),
    "expected response to include verification_uri_complete",
  );
  assert.ok(text.includes(pending.user_code), "expected response to include user_code");
  assert.ok(
    text.includes("OAuth device authorization required"),
    "expected response to start with the OAuth required header",
  );
});

test("auth-required response falls back to verification_uri when complete URL is absent", () => {
  const pending = {
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    verification_uri_complete: null,
    expires_at: Date.now() + 600_000,
  };
  const result = buildAuthRequiredToolResult(pending);
  const text = result.content[0].text;

  assert.ok(text.includes(pending.verification_uri), "expected verification_uri");
  assert.ok(text.includes(pending.user_code), "expected user_code");
  // Without the complete URL we should NOT pretend there is a pre-filled link.
  assert.ok(
    !text.includes("code pre-filled"),
    "expected no 'code pre-filled' hint when verification_uri_complete is null",
  );
});

test("auth-required response omits expiry hint when expires_at is missing", () => {
  const pending = {
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    verification_uri_complete: null,
    expires_at: undefined,
  };
  const result = buildAuthRequiredToolResult(pending);
  const text = result.content[0].text;

  assert.ok(!/expires in/.test(text), "expected no expiry hint when expires_at is undefined");
});

test("auth-required response tells the user to retry after approval", () => {
  const pending = {
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    verification_uri_complete:
      "https://github.com/login/device?user_code=WDJB-MJHT",
    expires_at: Date.now() + 600_000,
  };
  const result = buildAuthRequiredToolResult(pending);
  const text = result.content[0].text;

  // The retry hint is what keeps subsequent tool calls from blocking a second
  // time — users must understand the workflow.
  assert.ok(
    /Retry the same tool call after approving/i.test(text),
    "expected retry-after-approval hint in response",
  );
});

test("response is marked isError so hosts render it as a failed tool call", () => {
  const pending = {
    user_code: "X",
    verification_uri: "https://example.com",
    verification_uri_complete: null,
    expires_at: undefined,
  };
  const result = buildAuthRequiredToolResult(pending);
  assert.equal(result.isError, true);
});
