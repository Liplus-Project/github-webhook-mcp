import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = resolve(__dirname, "..", "..", "events.json");
const PRIMARY_ENCODING = "utf-8";
const LEGACY_ENCODINGS = ["utf-8", "cp932", "shift_jis"];

function dataFilePath() {
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
  writeFileSync(filePath, JSON.stringify(events, null, 2), PRIMARY_ENCODING);
}

// ── Query ───────────────────────────────────────────────────────────────────

export function getPending() {
  return load().filter((e) => !e.processed);
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
  for (const event of events) {
    if (event.id === eventId) {
      event.processed = true;
      save(events);
      return true;
    }
  }
  return false;
}
