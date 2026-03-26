/**
 * Cloudflare Worker entrypoint for github-webhook-mcp
 *
 * Routes:
 *   POST /webhooks/github  — receive GitHub webhooks, verify signature, store in DO
 *   GET  /events           — SSE stream of new events (Worker-level, not inside DO)
 *   *    /mcp              — McpAgent DO handles MCP protocol (Streamable HTTP)
 */
import { WebhookMcpAgent } from "./agent.js";
import { WebhookStore } from "./store.js";
import { isGitHubWebhookIP } from "./github-ip.js";
import { checkWebhookRateLimit, checkApiRateLimit, rateLimitResponse } from "./rate-limit.js";

export { WebhookMcpAgent, WebhookStore };

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  WEBHOOK_STORE: DurableObjectNamespace;
  GITHUB_WEBHOOK_SECRET?: string;
  MCP_AUTH_TOKEN?: string;
}

/**
 * Check Bearer token authentication.
 * Returns a 401 Response if auth fails, or null if auth passes.
 * Skips check when MCP_AUTH_TOKEN is not configured (backward compatible).
 */
function checkBearerAuth(request: Request, env: Env): Response | null {
  if (!env.MCP_AUTH_TOKEN) return null;

  // Check Authorization header first
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === env.MCP_AUTH_TOKEN) {
    return null;
  }

  // Fall back to ?token= query parameter (for WebSocket clients)
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam === env.MCP_AUTH_TOKEN) {
    return null;
  }

  return new Response("Unauthorized", { status: 401 });
}

async function verifyGitHubSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signature;
}

// McpAgent.serve() returns a fetch handler for MCP protocol
const mcpHandler = WebhookMcpAgent.serve("/mcp");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Webhook receiver ───────────────────────────────────
    if (url.pathname === "/webhooks/github" && request.method === "POST") {
      // IP allowlist — block non-GitHub IPs before any processing
      if (!(await isGitHubWebhookIP(request))) {
        return new Response("Forbidden", { status: 403 });
      }

      // Rate limit per IP
      const webhookIP = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!checkWebhookRateLimit(webhookIP)) return rateLimitResponse();

      const body = await request.text();

      // Signature verification
      if (env.GITHUB_WEBHOOK_SECRET) {
        const sig = request.headers.get("X-Hub-Signature-256") || "";
        const valid = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, body, sig);
        if (!valid) {
          return new Response("Invalid signature", { status: 403 });
        }
      }

      const eventType = request.headers.get("X-GitHub-Event") || "unknown";
      const deliveryId = request.headers.get("X-GitHub-Delivery") || crypto.randomUUID();

      // Forward to WebhookStore DO
      const doId = env.WEBHOOK_STORE.idFromName("singleton");
      const stub = env.WEBHOOK_STORE.get(doId);
      await stub.fetch(
        new Request("https://do/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: deliveryId,
            type: eventType,
            received_at: new Date().toISOString(),
            processed: false,
            payload: JSON.parse(body),
          }),
        }),
      );

      return new Response(
        JSON.stringify({ accepted: true, id: deliveryId }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // ── Rate limit for API endpoints ───────────────────────
    const apiIP = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkApiRateLimit(apiIP)) return rateLimitResponse();

    // ── SSE stream (routed to WebhookStore DO) ─────────────
    if (url.pathname === "/events" && request.method === "GET") {
      const authError = checkBearerAuth(request, env);
      if (authError) return authError;

      const doId = env.WEBHOOK_STORE.idFromName("singleton");
      const stub = env.WEBHOOK_STORE.get(doId);
      return stub.fetch(request);
    }

    // ── MCP endpoint (delegate to McpAgent.serve handler) ──
    if (url.pathname.startsWith("/mcp")) {
      const authError = checkBearerAuth(request, env);
      if (authError) return authError;

      return mcpHandler.fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
