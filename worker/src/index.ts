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

export { WebhookMcpAgent, WebhookStore };

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  WEBHOOK_STORE: DurableObjectNamespace;
  GITHUB_WEBHOOK_SECRET?: string;
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

    // ── SSE stream (routed to WebhookStore DO) ─────────────
    if (url.pathname === "/events" && request.method === "GET") {
      const doId = env.WEBHOOK_STORE.idFromName("singleton");
      const stub = env.WEBHOOK_STORE.get(doId);
      return stub.fetch(request);
    }

    // ── MCP endpoint (delegate to McpAgent.serve handler) ──
    if (url.pathname.startsWith("/mcp")) {
      return mcpHandler.fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
