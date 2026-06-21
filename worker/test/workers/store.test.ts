import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { WebhookEvent, EventSummary, PendingStatus } from "../../../shared/src/types.js";

// Each test uses a uniquely-named DO instance for storage isolation. WebhookStore
// self-initializes its schema on first fetch (idempotent CREATE TABLE IF NOT
// EXISTS), so no migration step is needed. The DO exposes behavior via fetch
// routes (not public methods), so tests drive it through stub.fetch().
function storeFor(name: string) {
  return env.WEBHOOK_STORE.get(env.WEBHOOK_STORE.idFromName(name));
}

const BASE = "https://do";

function makeEvent(over: Partial<WebhookEvent> & Pick<WebhookEvent, "id">): WebhookEvent {
  return {
    type: "issues",
    received_at: "2026-01-01T00:00:00Z",
    processed: false,
    trigger_status: null,
    last_triggered_at: null,
    payload: {},
    ...over,
  };
}

async function ingest(stub: DurableObjectStub, event: WebhookEvent) {
  const res = await stub.fetch(
    new Request(`${BASE}/ingest`, {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ stored: boolean }>;
}

describe("WebhookStore: ingest + pending-status", () => {
  it("ingests events and reports counts by type with the latest received_at", async () => {
    const stub = storeFor("status-counts");
    await ingest(stub, makeEvent({ id: "a", type: "issues", received_at: "2026-01-01T00:00:00Z" }));
    await ingest(stub, makeEvent({ id: "b", type: "issues", received_at: "2026-01-03T00:00:00Z" }));
    await ingest(stub, makeEvent({ id: "c", type: "pull_request", received_at: "2026-01-02T00:00:00Z" }));

    const res = await stub.fetch(new Request(`${BASE}/pending-status`));
    expect(res.status).toBe(200);
    const status = (await res.json()) as PendingStatus;

    expect(status.pending_count).toBe(3);
    expect(status.types).toEqual({ issues: 2, pull_request: 1 });
    expect(status.latest_received_at).toBe("2026-01-03T00:00:00Z");
  });

  it("returns empty status when nothing is pending", async () => {
    const stub = storeFor("status-empty");
    const res = await stub.fetch(new Request(`${BASE}/pending-status`));
    const status = (await res.json()) as PendingStatus;
    expect(status.pending_count).toBe(0);
    expect(status.types).toEqual({});
    expect(status.latest_received_at).toBeNull();
  });

  it("stores idempotently on id (INSERT OR REPLACE): re-ingesting the same id does not duplicate", async () => {
    const stub = storeFor("status-idem");
    await ingest(stub, makeEvent({ id: "dup", type: "issues", received_at: "2026-01-01T00:00:00Z" }));
    await ingest(stub, makeEvent({ id: "dup", type: "push", received_at: "2026-02-01T00:00:00Z" }));

    const res = await stub.fetch(new Request(`${BASE}/pending-status`));
    const status = (await res.json()) as PendingStatus;
    expect(status.pending_count).toBe(1);
    expect(status.types).toEqual({ push: 1 });
    expect(status.latest_received_at).toBe("2026-02-01T00:00:00Z");
  });
});

describe("WebhookStore: pending-events (summaries)", () => {
  it("returns summaries newest-first, honors limit, and excludes processed events", async () => {
    const stub = storeFor("pending-events");
    await ingest(
      stub,
      makeEvent({
        id: "e1",
        type: "issues",
        received_at: "2026-01-01T00:00:00Z",
        payload: {
          action: "opened",
          number: 1,
          repository: { full_name: "o/r" },
          sender: { login: "alice" },
          issue: { number: 1, title: "first", html_url: "https://gh/1" },
        },
      }),
    );
    await ingest(stub, makeEvent({ id: "e2", type: "issues", received_at: "2026-01-02T00:00:00Z" }));
    await ingest(stub, makeEvent({ id: "e3", type: "issues", received_at: "2026-01-03T00:00:00Z" }));

    // newest-first
    const allRes = await stub.fetch(new Request(`${BASE}/pending-events`));
    const all = (await allRes.json()) as EventSummary[];
    expect(all.map((s) => s.id)).toEqual(["e3", "e2", "e1"]);

    // summary shape (summarizeEvent) for the rich payload
    const e1 = all.find((s) => s.id === "e1")!;
    expect(e1.action).toBe("opened");
    expect(e1.repo).toBe("o/r");
    expect(e1.sender).toBe("alice");
    expect(e1.number).toBe(1);
    expect(e1.title).toBe("first");
    expect(e1.url).toBe("https://gh/1");

    // limit
    const limRes = await stub.fetch(new Request(`${BASE}/pending-events?limit=2`));
    const lim = (await limRes.json()) as EventSummary[];
    expect(lim.map((s) => s.id)).toEqual(["e3", "e2"]);

    // mark e3 processed -> drops out of pending-events
    const mp = await stub.fetch(
      new Request(`${BASE}/mark-processed`, {
        method: "POST",
        body: JSON.stringify({ event_id: "e3" }),
      }),
    );
    expect(mp.status).toBe(200);
    const afterRes = await stub.fetch(new Request(`${BASE}/pending-events`));
    const after = (await afterRes.json()) as EventSummary[];
    expect(after.map((s) => s.id)).toEqual(["e2", "e1"]);
  });
});

describe("WebhookStore: webhook-events (full payloads)", () => {
  it("returns full WebhookEvent records with parsed payload, newest-first", async () => {
    const stub = storeFor("full-events");
    await ingest(
      stub,
      makeEvent({
        id: "f1",
        type: "push",
        received_at: "2026-01-01T00:00:00Z",
        payload: { ref: "refs/heads/main", extra: { nested: true } },
      }),
    );
    await ingest(stub, makeEvent({ id: "f2", type: "push", received_at: "2026-01-02T00:00:00Z" }));

    const res = await stub.fetch(new Request(`${BASE}/webhook-events`));
    const events = (await res.json()) as WebhookEvent[];
    expect(events.map((e) => e.id)).toEqual(["f2", "f1"]);

    const f1 = events.find((e) => e.id === "f1")!;
    expect(f1.type).toBe("push");
    expect(f1.processed).toBe(false);
    expect(f1.payload).toEqual({ ref: "refs/heads/main", extra: { nested: true } });
  });
});

describe("WebhookStore: get_event (/event?id=)", () => {
  it("returns the full event when found", async () => {
    const stub = storeFor("event-found");
    await ingest(
      stub,
      makeEvent({ id: "g1", type: "issues", received_at: "2026-01-01T00:00:00Z", payload: { action: "closed" } }),
    );

    const res = await stub.fetch(new Request(`${BASE}/event?id=g1`));
    expect(res.status).toBe(200);
    const event = (await res.json()) as WebhookEvent;
    expect(event.id).toBe("g1");
    expect(event.payload).toEqual({ action: "closed" });
  });

  it("returns 404 for a missing id", async () => {
    const stub = storeFor("event-missing");
    const res = await stub.fetch(new Request(`${BASE}/event?id=nope`));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });

  it("returns 400 when the id query param is absent", async () => {
    const stub = storeFor("event-no-id");
    const res = await stub.fetch(new Request(`${BASE}/event`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing id");
  });
});

describe("WebhookStore: mark-processed", () => {
  it("flips processed so the event drops out of pending but remains fetchable by id", async () => {
    const stub = storeFor("mark-processed");
    await ingest(stub, makeEvent({ id: "m1", type: "issues", received_at: "2026-01-01T00:00:00Z" }));

    const mp = await stub.fetch(
      new Request(`${BASE}/mark-processed`, {
        method: "POST",
        body: JSON.stringify({ event_id: "m1" }),
      }),
    );
    expect(mp.status).toBe(200);
    expect(await mp.json()).toEqual({ success: true, event_id: "m1" });

    // no longer pending
    const statusRes = await stub.fetch(new Request(`${BASE}/pending-status`));
    const status = (await statusRes.json()) as PendingStatus;
    expect(status.pending_count).toBe(0);

    // but still retrievable by id, with processed = true
    const evRes = await stub.fetch(new Request(`${BASE}/event?id=m1`));
    const ev = (await evRes.json()) as WebhookEvent;
    expect(ev.processed).toBe(true);
  });
});

describe("WebhookStore: unknown route", () => {
  it("returns 404 for an unrecognized path", async () => {
    const stub = storeFor("unknown-route");
    const res = await stub.fetch(new Request(`${BASE}/nope`));
    expect(res.status).toBe(404);
  });
});
