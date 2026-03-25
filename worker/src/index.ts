/**
 * Cloudflare Worker entrypoint for github-webhook-mcp
 *
 * Routes:
 *   POST /webhooks/github  — receive GitHub webhooks, verify signature, store in DO
 *   GET  /events           — SSE stream of new events (Worker-level, not inside DO)
 *   *    /mcp              — McpAgent DO handles MCP protocol (Streamable HTTP)
 */
import { WebhookMcpAgent } from "./agent.js";

export { WebhookMcpAgent };

interface Env {
  WEBHOOK_DO: DurableObjectNamespace;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      // Forward to DO via RPC-style fetch
      const doId = env.WEBHOOK_DO.idFromName("singleton");
      const stub = env.WEBHOOK_DO.get(doId);
      const doResponse = await stub.fetch(
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

    // ── SSE stream ─────────────────────────────────────────
    if (url.pathname === "/events" && request.method === "GET") {
      // TODO: implement SSE with DO event notifications
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ status: "connected" })}\n\n`),
          );
          // Heartbeat to keep connection alive
          const interval = setInterval(() => {
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ heartbeat: Date.now() })}\n\n`),
              );
            } catch {
              clearInterval(interval);
            }
          }, 30000);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── MCP endpoint ───────────────────────────────────────
    if (url.pathname.startsWith("/mcp")) {
      return WebhookMcpAgent.serve("/mcp").fetch(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
