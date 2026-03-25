/**
 * Shared type definitions for github-webhook-mcp
 * Used by both worker/ (Cloudflare) and local-mcp/ (stdio bridge)
 */

/** Stored webhook event in DO SQLite */
export interface WebhookEvent {
  id: string;
  type: string;
  received_at: string;
  processed: boolean;
  trigger_status?: string | null;
  last_triggered_at?: string | null;
  payload: Record<string, unknown>;
}

/** Lightweight summary returned by list_pending_events */
export interface EventSummary {
  id: string;
  type: string;
  received_at: string;
  processed: boolean;
  trigger_status: string | null;
  last_triggered_at: string | null;
  action: string | null;
  repo: string | null;
  sender: string | null;
  number: number | null;
  title: string | null;
  url: string | null;
}

/** Response from get_pending_status */
export interface PendingStatus {
  pending_count: number;
  latest_received_at: string | null;
  types: Record<string, number>;
}

/** SSE event pushed from Worker to local bridge */
export interface SSEEvent {
  event_id: string;
  type: string;
  summary: EventSummary;
}
