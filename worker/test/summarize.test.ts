/**
 * Unit tests for shared/src/summarize.ts :: summarizeEvent (#223).
 *
 * summarizeEvent is the core "webhook payload → lightweight EventSummary"
 * projection, shared between the Worker (store.ts broadcast + list_pending_events)
 * and the mcp-server / local-mcp bridge. It had zero direct coverage before this.
 *
 * These tests pin the field-extraction fallback ladders (number / title / url),
 * the workflow_run-only fields, and null safety on sparse payloads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeEvent } from "../../shared/src/summarize.js";
import type { WebhookEvent } from "../../shared/src/types.js";

function baseEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: "delivery-1",
    type: "issues",
    received_at: "2026-05-01T00:00:00.000Z",
    processed: false,
    payload: {},
    ...overrides,
  };
}

// ── Passthrough fields ───────────────────────────────────────────────

test("passes through id / type / received_at / processed verbatim", () => {
  const s = summarizeEvent(baseEvent({
    id: "abc",
    type: "push",
    received_at: "2026-05-02T12:00:00.000Z",
    processed: true,
  }));
  assert.equal(s.id, "abc");
  assert.equal(s.type, "push");
  assert.equal(s.received_at, "2026-05-02T12:00:00.000Z");
  assert.equal(s.processed, true);
});

test("trigger_status / last_triggered_at default to null when omitted", () => {
  const s = summarizeEvent(baseEvent());
  assert.equal(s.trigger_status, null);
  assert.equal(s.last_triggered_at, null);
});

test("trigger_status / last_triggered_at pass through when present", () => {
  const s = summarizeEvent(baseEvent({
    trigger_status: "triggered",
    last_triggered_at: "2026-05-03T01:02:03.000Z",
  }));
  assert.equal(s.trigger_status, "triggered");
  assert.equal(s.last_triggered_at, "2026-05-03T01:02:03.000Z");
});

// ── Empty payload → all derived fields null ──────────────────────────

test("empty payload yields all-null derived fields", () => {
  const s = summarizeEvent(baseEvent({ payload: {} }));
  assert.equal(s.action, null);
  assert.equal(s.repo, null);
  assert.equal(s.sender, null);
  assert.equal(s.number, null);
  assert.equal(s.title, null);
  assert.equal(s.url, null);
  assert.equal(s.head_branch, null);
  assert.equal(s.head_sha, null);
  assert.equal(s.conclusion, null);
});

// ── action / repo / sender ───────────────────────────────────────────

test("extracts action, repo full_name, and sender login", () => {
  const s = summarizeEvent(baseEvent({
    payload: {
      action: "opened",
      repository: { full_name: "octo/repo" },
      sender: { login: "alice" },
    },
  }));
  assert.equal(s.action, "opened");
  assert.equal(s.repo, "octo/repo");
  assert.equal(s.sender, "alice");
});

// ── number ladder: top-level > issue > pull_request ──────────────────

test("issue payload supplies number / title / url", () => {
  const s = summarizeEvent(baseEvent({
    type: "issues",
    payload: {
      issue: { number: 5, title: "A bug", html_url: "https://gh/issues/5" },
    },
  }));
  assert.equal(s.number, 5);
  assert.equal(s.title, "A bug");
  assert.equal(s.url, "https://gh/issues/5");
});

test("pull_request payload supplies number / title / url", () => {
  const s = summarizeEvent(baseEvent({
    type: "pull_request",
    payload: {
      pull_request: { number: 9, title: "A PR", html_url: "https://gh/pull/9" },
    },
  }));
  assert.equal(s.number, 9);
  assert.equal(s.title, "A PR");
  assert.equal(s.url, "https://gh/pull/9");
});

test("top-level number wins over issue.number", () => {
  const s = summarizeEvent(baseEvent({
    payload: { number: 1, issue: { number: 2 } },
  }));
  assert.equal(s.number, 1);
});

test("issue.number wins over pull_request.number", () => {
  const s = summarizeEvent(baseEvent({
    payload: {
      issue: { number: 2 },
      pull_request: { number: 3 },
    },
  }));
  assert.equal(s.number, 2);
});

// ── title ladder: issue > pull_request > discussion > check_run > workflow_run > workflow_job ──

test("issue.title wins over pull_request.title", () => {
  const s = summarizeEvent(baseEvent({
    payload: {
      issue: { title: "issue title" },
      pull_request: { title: "pr title" },
    },
  }));
  assert.equal(s.title, "issue title");
});

test("discussion supplies title and url", () => {
  const s = summarizeEvent(baseEvent({
    type: "discussion",
    payload: { discussion: { title: "How do I?", html_url: "https://gh/d/1" } },
  }));
  assert.equal(s.title, "How do I?");
  assert.equal(s.url, "https://gh/d/1");
  // eventNumber does not read discussion.number → stays null.
  assert.equal(s.number, null);
});

test("check_run supplies title from name and url", () => {
  const s = summarizeEvent(baseEvent({
    type: "check_run",
    payload: { check_run: { name: "build", html_url: "https://gh/c/1" } },
  }));
  assert.equal(s.title, "build");
  assert.equal(s.url, "https://gh/c/1");
});

test("workflow_job supplies title from name (last title fallback)", () => {
  const s = summarizeEvent(baseEvent({
    type: "workflow_job",
    payload: { workflow_job: { name: "lint" } },
  }));
  assert.equal(s.title, "lint");
});

// ── workflow_run-only fields ─────────────────────────────────────────

test("workflow_run event exposes head_branch / head_sha / conclusion + title/url", () => {
  const s = summarizeEvent(baseEvent({
    type: "workflow_run",
    payload: {
      workflow_run: {
        name: "CI",
        html_url: "https://gh/runs/1",
        head_branch: "main",
        head_sha: "deadbeef",
        conclusion: "success",
      },
    },
  }));
  assert.equal(s.title, "CI");
  assert.equal(s.url, "https://gh/runs/1");
  assert.equal(s.head_branch, "main");
  assert.equal(s.head_sha, "deadbeef");
  assert.equal(s.conclusion, "success");
});

test("workflow_run fields stay null when event type is not workflow_run", () => {
  // Even if a workflow_run object is present, the type gate suppresses the fields.
  const s = summarizeEvent(baseEvent({
    type: "issues",
    payload: {
      workflow_run: { head_branch: "main", head_sha: "x", conclusion: "success" },
    },
  }));
  assert.equal(s.head_branch, null);
  assert.equal(s.head_sha, null);
  assert.equal(s.conclusion, null);
});
