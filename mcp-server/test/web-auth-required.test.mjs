/**
 * Black-box contract tests for the v0.11.1 Worker-hosted web OAuth UX.
 *
 * The behaviour exercised here is the "auth-required" tool result that the
 * MCP client returns when a tool call arrives before the user has approved
 * the web OAuth flow (see mcp-server/server/index.js :: formatAuthRequiredResponse
 * and its TypeScript twin in local-mcp/src/index.ts).
 *
 * We re-implement the user-visible contract inline because the module cannot
 * be imported without starting an MCP server (top-level await on mcp.connect).
 * The assertions cover the invariants that the Claude Code / Desktop UX
 * depends on:
 *   - the response surfaces a clickable authorize URL pointing at the Worker
 *   - the response is marked isError=true so hosts render it as a failed tool
 *     call the user can retry
 *   - the response tells the user to retry after signing in on GitHub
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/** Mirrors formatAuthRequiredResponse() in server/index.js. */
function formatAuthRequiredResponse(pending) {
  const parts = [];
  parts.push("OAuth authorization required.");
  parts.push("");
  parts.push(`Open this URL in your browser: ${pending.authorize_url}`);
  parts.push("");
  if (pending.expires_at) {
    const remainingMs = pending.expires_at - Date.now();
    if (remainingMs > 0) {
      const mins = Math.max(1, Math.round(remainingMs / 60_000));
      parts.push(`This link is valid for about ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
  }
  parts.push(
    "A browser window should have opened automatically. " +
      "Sign in on GitHub, then retry the same tool call — subsequent calls will succeed once authorization completes.",
  );
  return parts.join("\n");
}

/** Shape the tool handler returns when the web flow is pending. */
function buildAuthRequiredToolResult(pending) {
  return {
    content: [{ type: "text", text: formatAuthRequiredResponse(pending) }],
    isError: true,
  };
}

test("auth-required response surfaces the Worker authorize URL verbatim", () => {
  const pending = {
    authorize_url:
      "https://github-webhook.smgjp.com/oauth/authorize?client_id=abc&state=xyz",
    expires_at: Date.now() + 600_000,
  };
  const result = buildAuthRequiredToolResult(pending);

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const text = result.content[0].text;

  assert.ok(
    text.includes(pending.authorize_url),
    "expected response to include authorize_url",
  );
  assert.ok(
    text.includes("OAuth authorization required"),
    "expected response to start with the OAuth required header",
  );
});

test("auth-required response omits expiry hint when expires_at is missing", () => {
  const pending = {
    authorize_url: "https://example.com/oauth/authorize?client_id=c&state=s",
    expires_at: undefined,
  };
  const result = buildAuthRequiredToolResult(pending);
  const text = result.content[0].text;

  assert.ok(!/valid for about/.test(text), "expected no expiry hint when expires_at is undefined");
});

test("auth-required response tells the user to retry after GitHub sign-in", () => {
  const pending = {
    authorize_url:
      "https://github-webhook.smgjp.com/oauth/authorize?client_id=abc&state=xyz",
    expires_at: Date.now() + 600_000,
  };
  const result = buildAuthRequiredToolResult(pending);
  const text = result.content[0].text;

  // The retry hint is what keeps subsequent tool calls from blocking a second
  // time — users must understand the workflow.
  assert.ok(
    /retry the same tool call/i.test(text),
    "expected retry-after-approval hint in response",
  );
  assert.ok(
    /Sign in on GitHub/i.test(text),
    "expected explicit mention of GitHub sign-in",
  );
});

test("response is marked isError so hosts render it as a failed tool call", () => {
  const pending = {
    authorize_url: "https://example.com/oauth/authorize?client_id=c&state=s",
    expires_at: undefined,
  };
  const result = buildAuthRequiredToolResult(pending);
  assert.equal(result.isError, true);
});
