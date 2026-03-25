/**
 * Summarize a webhook event into a lightweight EventSummary.
 * Shared between worker and local-mcp.
 */
import type { WebhookEvent, EventSummary } from "./types.js";

function eventNumber(payload: Record<string, unknown>): number | null {
  return (
    (payload.number as number) ??
    (payload.issue as Record<string, unknown>)?.number ??
    (payload.pull_request as Record<string, unknown>)?.number ??
    null
  ) as number | null;
}

function eventTitle(payload: Record<string, unknown>): string | null {
  return (
    (payload.issue as Record<string, unknown>)?.title ??
    (payload.pull_request as Record<string, unknown>)?.title ??
    (payload.discussion as Record<string, unknown>)?.title ??
    (payload.check_run as Record<string, unknown>)?.name ??
    (payload.workflow_run as Record<string, unknown>)?.name ??
    (payload.workflow_job as Record<string, unknown>)?.name ??
    null
  ) as string | null;
}

function eventUrl(payload: Record<string, unknown>): string | null {
  return (
    (payload.issue as Record<string, unknown>)?.html_url ??
    (payload.pull_request as Record<string, unknown>)?.html_url ??
    (payload.discussion as Record<string, unknown>)?.html_url ??
    (payload.check_run as Record<string, unknown>)?.html_url ??
    (payload.workflow_run as Record<string, unknown>)?.html_url ??
    null
  ) as string | null;
}

export function summarizeEvent(event: WebhookEvent): EventSummary {
  const payload = event.payload || {};
  return {
    id: event.id,
    type: event.type,
    received_at: event.received_at,
    processed: event.processed,
    trigger_status: event.trigger_status ?? null,
    last_triggered_at: event.last_triggered_at ?? null,
    action: (payload.action as string) ?? null,
    repo: (payload.repository as Record<string, unknown>)?.full_name as string ?? null,
    sender: (payload.sender as Record<string, unknown>)?.login as string ?? null,
    number: eventNumber(payload),
    title: eventTitle(payload),
    url: eventUrl(payload),
  };
}
