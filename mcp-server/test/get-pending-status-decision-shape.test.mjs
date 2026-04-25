/**
 * Decision-JSON wrapping tests for `get_pending_status` (issue #215).
 *
 * Background: with `LI_PLUS_WEBHOOK_DELIVERY=mcp_hook`, this tool runs from a
 * `type: "mcp_tool"` Claude Code UserPromptSubmit hook. Per docs literal at
 * https://code.claude.com/docs/en/hooks the tool's text content is parsed as
 * JSON and processed as a decision; the canonical UserPromptSubmit decision
 * shape is:
 *
 *   {
 *     "hookSpecificOutput": {
 *       "hookEventName": "UserPromptSubmit",
 *       "additionalContext": "<plain text>"
 *     }
 *   }
 *
 * The remote handler returns generic `{pending_count, types, latest_received_at}`
 * JSON which parses fine but matches no decision schema, so the hook output is
 * silently discarded. This wrapper re-shapes the local bridge response into
 * the decision form so Claude Code injects `additionalContext` into the
 * UserPromptSubmit prompt context.
 *
 * Tests mirror the wrapper inline because server/index.js cannot be imported
 * without starting an MCP server (top-level `await server.connect`); same
 * convention as migration / open-browser / web-auth-required tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

function formatPendingStatusSummary(payload) {
  const count =
    payload && typeof payload.pending_count === "number"
      ? payload.pending_count
      : 0;
  if (count === 0) {
    return "No pending GitHub webhook events.";
  }
  const typesObj =
    payload && payload.types && typeof payload.types === "object"
      ? payload.types
      : null;
  const typesStr = typesObj
    ? Object.entries(typesObj)
        .map(([type, n]) => `${type}:${n}`)
        .join(", ")
    : "";
  const latest =
    payload && typeof payload.latest_received_at === "string"
      ? ` latest ${payload.latest_received_at}`
      : "";
  return (
    `${count} pending GitHub webhook events` +
    (typesStr ? ` (${typesStr})` : "") +
    `.${latest}`
  );
}

function wrapGetPendingStatusAsDecisionJson(result) {
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    return result;
  }
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    return result;
  }
  let summary;
  try {
    summary = formatPendingStatusSummary(JSON.parse(first.text));
  } catch {
    summary = first.text.slice(0, 200);
  }
  const decision = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: summary,
    },
  };
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify(decision) }],
  };
}

test("wraps non-empty pending payload as UserPromptSubmit decision JSON", () => {
  const remote = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          pending_count: 12,
          latest_received_at: "2026-04-25T10:00:00Z",
          types: { issues: 7, push: 5 },
        }),
      },
    ],
  };

  const wrapped = wrapGetPendingStatusAsDecisionJson(remote);
  assert.equal(wrapped.content.length, 1);
  assert.equal(wrapped.content[0].type, "text");

  const decision = JSON.parse(wrapped.content[0].text);
  assert.equal(decision.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(typeof decision.hookSpecificOutput.additionalContext, "string");
  assert.match(decision.hookSpecificOutput.additionalContext, /12 pending/);
  assert.match(decision.hookSpecificOutput.additionalContext, /issues:7/);
  assert.match(decision.hookSpecificOutput.additionalContext, /push:5/);
  assert.match(
    decision.hookSpecificOutput.additionalContext,
    /latest 2026-04-25T10:00:00Z/,
  );
  assert.equal("decision" in decision, false);
});

test("wraps zero-pending payload with explicit no-events sentence", () => {
  const remote = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          pending_count: 0,
          latest_received_at: null,
          types: {},
        }),
      },
    ],
  };

  const decision = JSON.parse(
    wrapGetPendingStatusAsDecisionJson(remote).content[0].text,
  );
  assert.equal(
    decision.hookSpecificOutput.additionalContext,
    "No pending GitHub webhook events.",
  );
});

test("falls back to truncated raw text when remote payload is not JSON", () => {
  const remote = {
    content: [
      { type: "text", text: "remote returned an unexpected plain string" },
    ],
  };

  const decision = JSON.parse(
    wrapGetPendingStatusAsDecisionJson(remote).content[0].text,
  );
  assert.equal(decision.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(
    decision.hookSpecificOutput.additionalContext,
    "remote returned an unexpected plain string",
  );
});

test("passes result through untouched when content is missing or non-text", () => {
  const noContent = { isError: true };
  assert.deepEqual(wrapGetPendingStatusAsDecisionJson(noContent), noContent);

  const empty = { content: [] };
  assert.deepEqual(wrapGetPendingStatusAsDecisionJson(empty), empty);

  const nonText = { content: [{ type: "image", data: "x" }] };
  assert.deepEqual(wrapGetPendingStatusAsDecisionJson(nonText), nonText);
});

test("preserves sibling result fields like isError when wrapping", () => {
  const remote = {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify({ pending_count: 0, types: {} }),
      },
    ],
  };
  const wrapped = wrapGetPendingStatusAsDecisionJson(remote);
  assert.equal(wrapped.isError, false);
});
