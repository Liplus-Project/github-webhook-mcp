/**
 * WebhookStore Durable Object — single-instance event storage.
 * Webhook data is ingested here and queried by McpAgent tools.
 * Uses Hibernatable WebSocket API for real-time event delivery.
 */
import { DurableObject } from "cloudflare:workers";
import type { WebhookEvent, EventSummary, PendingStatus } from "../../shared/src/types.js";
import { summarizeEvent } from "../../shared/src/summarize.js";

export class WebhookStore extends DurableObject {
  private initialized = false;

  private ensureTable() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        trigger_status TEXT,
        last_triggered_at TEXT,
        payload TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  /** Broadcast to all connected WebSocket clients */
  private broadcast(data: unknown) {
    const msg = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // Client disconnected; will be cleaned up by webSocketClose
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureTable();
    const url = new URL(request.url);

    // ── WebSocket upgrade ──
    if (url.pathname === "/events" && request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      // Send initial connected message
      pair[1].send(JSON.stringify({ status: "connected" }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // ── SSE fallback (for EventSource clients) ──
    if (url.pathname === "/events" && request.method === "GET") {
      // Upgrade hint: clients should use WebSocket for reliable delivery.
      // SSE fallback kept for compatibility but may miss events during DO hibernation.
      const encoder = new TextEncoder();
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      writer.write(encoder.encode(`data: ${JSON.stringify({ status: "connected", hint: "use WebSocket for reliable delivery" })}\n\n`));

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          writer.write(encoder.encode(`data: ${JSON.stringify({ heartbeat: Date.now() })}\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        writer.close().catch(() => {});
      });

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── Ingest ──
    if (url.pathname === "/ingest" && request.method === "POST") {
      const event = await request.json() as WebhookEvent;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO events (id, type, received_at, processed, trigger_status, last_triggered_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.type,
        event.received_at,
        event.processed ? 1 : 0,
        event.trigger_status ?? null,
        event.last_triggered_at ?? null,
        JSON.stringify(event.payload),
      );

      // Broadcast to WebSocket clients (survives hibernation)
      const summary = summarizeEvent(event);
      this.broadcast({ event_id: event.id, type: event.type, summary });

      return Response.json({ stored: true });
    }

    // ── get_pending_status ──
    if (url.pathname === "/pending-status") {
      const rows = this.ctx.storage.sql.exec(
        `SELECT type, COUNT(*) as cnt FROM events WHERE processed = 0 GROUP BY type`,
      ).toArray();
      const latestRow = this.ctx.storage.sql.exec(
        `SELECT received_at FROM events WHERE processed = 0 ORDER BY received_at DESC LIMIT 1`,
      ).toArray();

      const types: Record<string, number> = {};
      let total = 0;
      for (const row of rows) {
        types[row.type as string] = row.cnt as number;
        total += row.cnt as number;
      }

      const status: PendingStatus = {
        pending_count: total,
        latest_received_at: latestRow.length > 0 ? latestRow[0].received_at as string : null,
        types,
      };
      return Response.json(status);
    }

    // ── list_pending_events ──
    if (url.pathname === "/pending-events") {
      const limit = Number(url.searchParams.get("limit") || "20");
      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM events WHERE processed = 0 ORDER BY received_at DESC LIMIT ?`,
        limit,
      ).toArray();

      const summaries: EventSummary[] = rows.map((row) => {
        const event: WebhookEvent = {
          id: row.id as string,
          type: row.type as string,
          received_at: row.received_at as string,
          processed: (row.processed as number) === 1,
          trigger_status: row.trigger_status as string | null,
          last_triggered_at: row.last_triggered_at as string | null,
          payload: JSON.parse(row.payload as string),
        };
        return summarizeEvent(event);
      });
      return Response.json(summaries);
    }

    // ── get_webhook_events (full payloads) ──
    if (url.pathname === "/webhook-events") {
      const limit = Number(url.searchParams.get("limit") || "20");
      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM events WHERE processed = 0 ORDER BY received_at DESC LIMIT ?`,
        limit,
      ).toArray();

      const events: WebhookEvent[] = rows.map((row) => ({
        id: row.id as string,
        type: row.type as string,
        received_at: row.received_at as string,
        processed: (row.processed as number) === 1,
        trigger_status: row.trigger_status as string | null,
        last_triggered_at: row.last_triggered_at as string | null,
        payload: JSON.parse(row.payload as string),
      }));
      return Response.json(events);
    }

    // ── get_event ──
    if (url.pathname === "/event") {
      const eventId = url.searchParams.get("id");
      if (!eventId) return Response.json({ error: "missing id" }, { status: 400 });

      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM events WHERE id = ?`, eventId,
      ).toArray();

      if (rows.length === 0) return Response.json({ error: "not found" }, { status: 404 });

      const row = rows[0];
      const event: WebhookEvent = {
        id: row.id as string,
        type: row.type as string,
        received_at: row.received_at as string,
        processed: (row.processed as number) === 1,
        trigger_status: row.trigger_status as string | null,
        last_triggered_at: row.last_triggered_at as string | null,
        payload: JSON.parse(row.payload as string),
      };
      return Response.json(event);
    }

    // ── mark_processed ──
    if (url.pathname === "/mark-processed" && request.method === "POST") {
      const { event_id } = await request.json() as { event_id: string };
      this.ctx.storage.sql.exec(
        `UPDATE events SET processed = 1 WHERE id = ?`, event_id,
      );
      return Response.json({ success: true, event_id });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Hibernatable WebSocket handlers ──
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Clients can send ping; respond with pong
    if (message === "ping") {
      ws.send(JSON.stringify({ pong: Date.now() }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // Cloudflare automatically removes from getWebSockets()
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    ws.close(1011, "WebSocket error");
  }
}
