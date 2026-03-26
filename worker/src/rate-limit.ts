/**
 * Simple in-memory sliding-window rate limiter.
 *
 * NOTE: This is per-isolate (not globally consistent across Workers instances).
 * For precise global rate limiting, use Cloudflare Rate Limiting rules in the
 * dashboard or a Durable Object-based counter. This provides a lightweight
 * first line of defense.
 */

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();

const WINDOW_MS = 60_000;      // 1 minute window
const MAX_WEBHOOK = 300;       // webhook endpoint: 300 req/min per IP
const MAX_API = 120;           // MCP/events endpoint: 120 req/min per IP

// Periodic cleanup to prevent unbounded map growth
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, counter] of counters) {
    if (now >= counter.resetAt) counters.delete(key);
  }
}

/**
 * Check rate limit for a given key (typically IP + endpoint type).
 * Returns true if the request is allowed, false if rate-limited.
 */
function check(key: string, max: number): boolean {
  cleanup();

  const now = Date.now();
  const existing = counters.get(key);

  if (!existing || now >= existing.resetAt) {
    counters.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  existing.count++;
  return existing.count <= max;
}

/**
 * Check rate limit for webhook endpoint.
 * Higher limit since GitHub can send bursts of webhooks.
 */
export function checkWebhookRateLimit(ip: string): boolean {
  return check(`wh:${ip}`, MAX_WEBHOOK);
}

/**
 * Check rate limit for API endpoints (MCP, events).
 */
export function checkApiRateLimit(ip: string): boolean {
  return check(`api:${ip}`, MAX_API);
}

/** Build a 429 response with Retry-After header. */
export function rateLimitResponse(): Response {
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": "60" },
  });
}
