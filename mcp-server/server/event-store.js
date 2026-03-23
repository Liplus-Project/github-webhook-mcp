import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = resolve(__dirname, "..", "..", "events.json");
const PRIMARY_ENCODING = "utf-8";
const LEGACY_ENCODINGS = ["utf-8", "cp932", "shift_jis"];
const DEFAULT_PURGE_DAYS = 1;

function purgeDays() {
  const env = process.env.PURGE_AFTER_DAYS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_PURGE_DAYS;
}

export function dataFilePath() {
  return process.env.EVENTS_JSON_PATH || DEFAULT_DATA_FILE;
}

// ── Load / Save ─────────────────────────────────────────────────────────────

export function load() {
  const filePath = dataFilePath();
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath);

  // Try UTF-8 first (with BOM stripping)
  try {
    let text = raw.toString("utf-8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const events = JSON.parse(text);
    return events;
  } catch {
    // fall through to legacy encodings
  }

  // Try legacy encodings
  for (const encoding of LEGACY_ENCODINGS) {
    try {
      const text = iconv.decode(raw, encoding);
      const events = JSON.parse(text);
      // Migrate to UTF-8
      save(events);
      return events;
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to decode event store: ${filePath}`);
}

export function save(events) {
  const filePath = dataFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(events, null, 2), PRIMARY_ENCODING);
}

// ── Purge ──────────────────────────────────────────────────────────────────

export function purgeProcessed(events) {
  const days = purgeDays();
  if (days < 0) return { kept: events, purged: 0 };
  const cutoff = Date.now() - days * 86_400_000;
  const before = events.length;
  const kept = events.filter((e) => {
    if (!e.processed) return true;
    const ts = Date.parse(e.received_at);
    return Number.isNaN(ts) || ts > cutoff;
  });
  return { kept, purged: before - kept.length };
}

// ── Query ───────────────────────────────────────────────────────────────────

export function getPending() {
  return load().filter((e) => !e.processed);
}

export function addEvent(eventType, payload) {
  const events = load();
  const event = {
    id: randomUUID(),
    type: eventType,
    payload,
    received_at: new Date().toISOString(),
    processed: false,
  };
  events.push(event);
  save(events);
  return event;
}

export function getEvent(eventId) {
  for (const event of load()) {
    if (event.id === eventId) return event;
  }
  return null;
}

export function getPendingStatus() {
  const pending = getPending();
  const types = {};
  for (const event of pending) {
    types[event.type] = (types[event.type] || 0) + 1;
  }
  return {
    pending_count: pending.length,
    latest_received_at: pending.length > 0 ? pending[pending.length - 1].received_at : null,
    types,
  };
}

// ── Summary ─────────────────────────────────────────────────────────────────

function eventNumber(payload) {
  return (
    payload.number ??
    payload.issue?.number ??
    payload.pull_request?.number ??
    null
  );
}

function eventTitle(payload) {
  return (
    payload.issue?.title ??
    payload.pull_request?.title ??
    payload.discussion?.title ??
    payload.check_run?.name ??
    payload.workflow_run?.name ??
    payload.workflow_job?.name ??
    null
  );
}

function eventUrl(payload) {
  return (
    payload.issue?.html_url ??
    payload.pull_request?.html_url ??
    payload.discussion?.html_url ??
    payload.check_run?.html_url ??
    payload.workflow_run?.html_url ??
    null
  );
}

export function summarizeEvent(event) {
  const payload = event.payload || {};
  return {
    id: event.id,
    type: event.type,
    received_at: event.received_at,
    processed: event.processed,
    trigger_status: event.trigger_status ?? null,
    last_triggered_at: event.last_triggered_at ?? null,
    action: payload.action ?? null,
    repo: payload.repository?.full_name ?? null,
    sender: payload.sender?.login ?? null,
    number: eventNumber(payload),
    title: eventTitle(payload),
    url: eventUrl(payload),
  };
}

export function getPendingSummaries(limit = 20) {
  let pending = getPending();
  if (limit > 0) {
    pending = pending.slice(-limit);
  }
  return pending.map(summarizeEvent);
}

// ── Mutation ────────────────────────────────────────────────────────────────

export function markDone(eventId) {
  const events = load();
  let found = false;
  for (const event of events) {
    if (event.id === eventId) {
      event.processed = true;
      found = true;
      break;
    }
  }
  if (!found) return { success: false, purged: 0 };
  const { kept, purged } = purgeProcessed(events);
  save(kept);
  return { success: true, purged };
}
