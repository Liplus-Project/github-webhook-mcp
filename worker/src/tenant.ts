/**
 * TenantRegistry Durable Object — manages installation_id to account_id mapping
 * and per-tenant quota counters.
 *
 * Single instance that holds the global mapping table.
 * Handles installation.created / installation.deleted webhook events.
 */
import { DurableObject } from "cloudflare:workers";

/** Result of resolving an installation_id to tenant info */
export interface TenantInfo {
  account_id: number;
  account_login: string;
  account_type: string;
}

/** Quota snapshot for a tenant */
export interface TenantQuota {
  account_id: number;
  events_stored: number;
  events_limit: number;
}

/**
 * Per-tenant quota window. events_stored is a throughput counter that resets at
 * the start of each window, so the quota is "events per window" — it can never
 * become a permanent lifetime lockout. (#231 regression: the counter only ever
 * incremented and, once it reached events_limit, returned 429 forever because
 * nothing reset it across the DO's persistent storage.)
 */
const QUOTA_WINDOW_MS = 60 * 60 * 1000; // 1 hour (matches the 429 Retry-After: 3600)

export class TenantRegistry extends DurableObject {
  private initialized = false;

  private ensureTables() {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS installations (
        installation_id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_installations_account
        ON installations (account_id)
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quotas (
        account_id INTEGER PRIMARY KEY,
        events_stored INTEGER NOT NULL DEFAULT 0,
        events_limit INTEGER NOT NULL DEFAULT 10000,
        window_started_at INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Migration for quotas tables created before the windowed-quota fix (#231):
    // add window_started_at if absent. Existing rows keep DEFAULT 0, which
    // /quota-check treats as an elapsed window and resets on the next check —
    // clearing the permanent lockout left by the old monotonic counter.
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE quotas ADD COLUMN window_started_at INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already exists (table created post-fix) — nothing to migrate.
    }

    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureTables();
    const url = new URL(request.url);

    // ── Resolve installation_id → tenant info ──
    if (url.pathname === "/resolve" && request.method === "GET") {
      const installationId = url.searchParams.get("installation_id");
      if (!installationId) {
        return Response.json({ error: "missing installation_id" }, { status: 400 });
      }

      const rows = this.ctx.storage.sql.exec(
        `SELECT account_id, account_login, account_type FROM installations WHERE installation_id = ?`,
        Number(installationId),
      ).toArray();

      if (rows.length === 0) {
        return Response.json({ error: "installation not found" }, { status: 404 });
      }

      const row = rows[0];
      const info: TenantInfo = {
        account_id: row.account_id as number,
        account_login: row.account_login as string,
        account_type: row.account_type as string,
      };
      return Response.json(info);
    }

    // ── Handle installation.created event ──
    if (url.pathname === "/installation-created" && request.method === "POST") {
      const body = await request.json() as {
        installation_id: number;
        account_id: number;
        account_login: string;
        account_type: string;
      };

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO installations (installation_id, account_id, account_login, account_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        body.installation_id,
        body.account_id,
        body.account_login,
        body.account_type,
        new Date().toISOString(),
      );

      // Ensure quota row exists for this account
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO quotas (account_id, events_stored, events_limit)
         VALUES (?, 0, 10000)`,
        body.account_id,
      );

      return Response.json({ registered: true, account_id: body.account_id });
    }

    // ── Handle installation.deleted event ──
    if (url.pathname === "/installation-deleted" && request.method === "POST") {
      const body = await request.json() as { installation_id: number };

      // Look up account_id before deleting
      const rows = this.ctx.storage.sql.exec(
        `SELECT account_id FROM installations WHERE installation_id = ?`,
        body.installation_id,
      ).toArray();

      if (rows.length === 0) {
        return Response.json({ deleted: false, reason: "installation not found" });
      }

      const accountId = rows[0].account_id as number;

      // Delete the installation mapping
      this.ctx.storage.sql.exec(
        `DELETE FROM installations WHERE installation_id = ?`,
        body.installation_id,
      );

      // Check if account still has other installations
      const remaining = this.ctx.storage.sql.exec(
        `SELECT COUNT(*) as cnt FROM installations WHERE account_id = ?`,
        accountId,
      ).toArray();

      const hasOtherInstallations = (remaining[0].cnt as number) > 0;

      return Response.json({
        deleted: true,
        account_id: accountId,
        has_other_installations: hasOtherInstallations,
      });
    }

    // ── Get quota for a tenant ──
    if (url.pathname === "/quota" && request.method === "GET") {
      const accountId = url.searchParams.get("account_id");
      if (!accountId) {
        return Response.json({ error: "missing account_id" }, { status: 400 });
      }

      const rows = this.ctx.storage.sql.exec(
        `SELECT account_id, events_stored, events_limit FROM quotas WHERE account_id = ?`,
        Number(accountId),
      ).toArray();

      if (rows.length === 0) {
        return Response.json({ error: "tenant not found" }, { status: 404 });
      }

      const row = rows[0];
      const quota: TenantQuota = {
        account_id: row.account_id as number,
        events_stored: row.events_stored as number,
        events_limit: row.events_limit as number,
      };
      return Response.json(quota);
    }

    // ── Check quota and atomically increment if within the current window ──
    // Returns { allowed: true/false, events_stored, events_limit }
    // Used by the Worker to gate webhook ingestion before forwarding to WebhookStore DO.
    if (url.pathname === "/quota-check" && request.method === "POST") {
      const body = await request.json() as { account_id: number };

      const rows = this.ctx.storage.sql.exec(
        `SELECT events_stored, events_limit, window_started_at FROM quotas WHERE account_id = ?`,
        body.account_id,
      ).toArray();

      if (rows.length === 0) {
        // Unknown tenant — reject (tenant must be registered via installation.created)
        return Response.json({ allowed: false, reason: "tenant not found" }, { status: 404 });
      }

      const stored = rows[0].events_stored as number;
      const limit = rows[0].events_limit as number;
      const windowStartedAt = rows[0].window_started_at as number;
      const now = Date.now();

      // Start a fresh window when the previous one elapsed (or was never set —
      // e.g. rows migrated from the pre-fix monotonic counter). This counts the
      // current event as #1 of the new window and clears any stale lockout, so
      // the quota can never become a permanent 429 (#231).
      if (windowStartedAt === 0 || now - windowStartedAt >= QUOTA_WINDOW_MS) {
        this.ctx.storage.sql.exec(
          `UPDATE quotas SET events_stored = 1, window_started_at = ? WHERE account_id = ?`,
          now,
          body.account_id,
        );
        return Response.json({
          allowed: true,
          events_stored: 1,
          events_limit: limit,
        });
      }

      if (stored >= limit) {
        return Response.json({
          allowed: false,
          events_stored: stored,
          events_limit: limit,
          reason: "quota exceeded",
        }, { status: 429 });
      }

      // Within the current window — atomically increment.
      this.ctx.storage.sql.exec(
        `UPDATE quotas SET events_stored = events_stored + 1 WHERE account_id = ?`,
        body.account_id,
      );

      return Response.json({
        allowed: true,
        events_stored: stored + 1,
        events_limit: limit,
      });
    }

    // ── Increment event counter ──
    if (url.pathname === "/quota-increment" && request.method === "POST") {
      const body = await request.json() as { account_id: number; delta?: number };
      const delta = body.delta ?? 1;

      this.ctx.storage.sql.exec(
        `UPDATE quotas SET events_stored = events_stored + ? WHERE account_id = ?`,
        delta,
        body.account_id,
      );

      // Check if over limit
      const rows = this.ctx.storage.sql.exec(
        `SELECT events_stored, events_limit FROM quotas WHERE account_id = ?`,
        body.account_id,
      ).toArray();

      if (rows.length === 0) {
        return Response.json({ error: "tenant not found" }, { status: 404 });
      }

      const stored = rows[0].events_stored as number;
      const limit = rows[0].events_limit as number;

      return Response.json({
        events_stored: stored,
        events_limit: limit,
        over_limit: stored > limit,
      });
    }

    // ── Decrement event counter ──
    if (url.pathname === "/quota-decrement" && request.method === "POST") {
      const body = await request.json() as { account_id: number; delta?: number };
      const delta = body.delta ?? 1;

      this.ctx.storage.sql.exec(
        `UPDATE quotas SET events_stored = MAX(0, events_stored - ?) WHERE account_id = ?`,
        delta,
        body.account_id,
      );

      return Response.json({ decremented: true });
    }

    return new Response("Not found", { status: 404 });
  }
}
