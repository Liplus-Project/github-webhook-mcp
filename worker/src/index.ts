/**
 * Cloudflare Worker entrypoint for github-webhook-mcp.
 *
 * OAuth model: bespoke Worker-hosted web OAuth flow. See worker/src/oauth.ts.
 * v0.11.1 reverts the device-authorization-grant iteration (#203, v0.11.0)
 * back to a standard web OAuth UX. The redirect_uri is pinned to
 * `https://<worker>/oauth/callback` so the approval step never returns to
 * the client's localhost (fix for #195's chronic auth loop).
 *
 * Routes:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata (oauth.ts)
 *   POST /oauth/register                           RFC 7591 dynamic registration (oauth.ts)
 *   GET  /oauth/authorize                          State issuance + GitHub redirect (oauth.ts)
 *   GET  /oauth/callback                           GitHub code → bearer token exchange (oauth.ts)
 *   POST /oauth/token                              Web-auth polling + refresh_token (oauth.ts)
 *
 *   POST /webhooks/github                          Webhook ingest (no auth)
 *   POST /mcp                                      MCP protocol (Bearer token)
 *   GET  /events                                   SSE/WebSocket stream (Bearer token)
 */
import { WebhookMcpAgent } from "./agent.js";
import { WebhookStore } from "./store.js";
import { TenantRegistry } from "./tenant.js";
import {
  authenticateApiRequest,
  handleOAuthRequest,
  type GitHubUserProps,
  type OAuthEnv,
} from "./oauth.js";
import { isGitHubWebhookIP } from "./github-ip.js";
import { checkWebhookRateLimit, checkApiRateLimit, checkTenantQuota, rateLimitResponse } from "./rate-limit.js";

export { WebhookMcpAgent, WebhookStore, TenantRegistry };

interface Env extends OAuthEnv {
  MCP_OBJECT: DurableObjectNamespace;
  WEBHOOK_STORE: DurableObjectNamespace;
  TENANT_REGISTRY: DurableObjectNamespace;
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

/**
 * Resolve installation_id to account_id via TenantRegistry DO.
 * On installation.created, registers the mapping first.
 */
async function resolveInstallationTenant(
  env: Env,
  installationId: number,
  payload: Record<string, unknown>,
  eventType: string,
): Promise<{ account_id: number; account_login: string } | null> {
  const registryId = env.TENANT_REGISTRY.idFromName("global");
  const registry = env.TENANT_REGISTRY.get(registryId);

  if (eventType === "installation") {
    const action = (payload as { action?: string }).action;
    const installation = payload.installation as {
      id: number;
      account: { id: number; login: string; type: string };
    } | undefined;

    if (action === "created" && installation) {
      await registry.fetch(
        new Request("https://registry/installation-created", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            installation_id: installation.id,
            account_id: installation.account.id,
            account_login: installation.account.login,
            account_type: installation.account.type,
          }),
        }),
      );
      return {
        account_id: installation.account.id,
        account_login: installation.account.login,
      };
    }

    if (action === "deleted" && installation) {
      await registry.fetch(
        new Request("https://registry/installation-deleted", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installation_id: installation.id }),
        }),
      );
      return {
        account_id: installation.account.id,
        account_login: installation.account.login,
      };
    }
  }

  const resolveRes = await registry.fetch(
    new Request(`https://registry/resolve?installation_id=${installationId}`),
  );

  if (!resolveRes.ok) return null;

  const info = await resolveRes.json() as { account_id: number; account_login: string };
  return info;
}

// McpAgent.serve() returns a fetch handler for MCP protocol.
// It reads ctx.props (set below from the authenticated grant) and passes them
// to the DO via getAgentByName.
const mcpHandler = WebhookMcpAgent.serve("/mcp");

/**
 * Top-level fetch handler. Routes OAuth endpoints to oauth.ts, authenticates
 * API routes (/mcp, /events) via Bearer token, and passes through webhook and
 * other routes directly.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── OAuth endpoints ────────────────────────────────────────
    // oauth.ts owns metadata discovery, registration, device authorization,
    // token issuance/refresh, and the 410 Gone responses for the removed
    // /oauth/authorize + /oauth/callback endpoints.
    if (
      url.pathname.startsWith("/oauth/") ||
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      const res = await handleOAuthRequest(request, env);
      if (res) return res;
    }

    // ── Webhook receiver (no OAuth required) ──────────────────
    // Authentication chain mirrors the pre-v0.11.0 order:
    //   IP allowlist → per-IP rate limit → signature → tenant resolution
    //   → per-tenant quota → WebhookStore DO /ingest
    if (url.pathname === "/webhooks/github" && request.method === "POST") {
      if (!(await isGitHubWebhookIP(request))) {
        return new Response("Forbidden", { status: 403 });
      }

      const webhookIP = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!checkWebhookRateLimit(webhookIP)) return rateLimitResponse();

      const body = await request.text();

      if (env.GITHUB_WEBHOOK_SECRET) {
        const sig = request.headers.get("X-Hub-Signature-256") || "";
        const valid = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, body, sig);
        if (!valid) {
          return new Response("Invalid signature", { status: 403 });
        }
      }

      const eventType = request.headers.get("X-GitHub-Event") || "unknown";
      const deliveryId = request.headers.get("X-GitHub-Delivery") || crypto.randomUUID();

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body);
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }

      const installation = payload.installation as { id: number } | undefined;
      const installationId = installation?.id;

      if (!installationId) {
        return new Response(
          JSON.stringify({ error: "missing installation.id in payload" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const tenant = await resolveInstallationTenant(env, installationId, payload, eventType);
      if (!tenant) {
        return new Response(
          JSON.stringify({ error: "unknown installation", installation_id: installationId }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      if (eventType !== "installation") {
        const registryId = env.TENANT_REGISTRY.idFromName("global");
        const registry = env.TENANT_REGISTRY.get(registryId);
        const quotaResult = await checkTenantQuota(registry, tenant.account_id);
        if (!quotaResult.allowed) {
          return quotaResult.response;
        }
      }

      const storeName = `store-${tenant.account_id}`;
      const doId = env.WEBHOOK_STORE.idFromName(storeName);
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
            payload,
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

    // ── Rate limit for API endpoints ─────────────────────────
    const apiIP = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkApiRateLimit(apiIP)) return rateLimitResponse();

    // ── Protected API routes (/mcp, /events) ─────────────────
    // Authenticate once here so both routes share the same middleware.
    const isMcpRoute = url.pathname.startsWith("/mcp");
    const isEventsRoute = url.pathname === "/events";
    if (isMcpRoute || isEventsRoute) {
      const result = await authenticateApiRequest(request, env);
      if ("response" in result) {
        return result.response;
      }
      const props = result.auth.props;

      if (isEventsRoute && (request.method === "GET" || request.headers.get("Upgrade") === "websocket")) {
        return handleEvents(request, env, ctx, props);
      }

      if (isMcpRoute) {
        // Rewrite ctx.props to TenantProps shape expected by WebhookMcpAgent.
        (ctx as unknown as { props: { account_id: number; account_login: string; accessible_account_ids: number[] } }).props = {
          account_id: props.githubUserId,
          account_login: props.githubLogin,
          accessible_account_ids: props.accessibleAccountIds ?? [props.githubUserId],
        };
        return mcpHandler.fetch(request, env, ctx);
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handle /events — WebSocket or SSE fanout across all accessible tenant stores.
 * Extracted from the inline handler to keep the top-level routing legible.
 */
async function handleEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  props: GitHubUserProps,
): Promise<Response> {
  const accountIds = props.accessibleAccountIds?.length
    ? props.accessibleAccountIds
    : [props.githubUserId];
  const storeStubs = accountIds.map((id) => {
    const doId = env.WEBHOOK_STORE.idFromName(`store-${id}`);
    return env.WEBHOOK_STORE.get(doId);
  });

  // Single store — direct pass-through (no fanout overhead).
  if (storeStubs.length === 1) {
    return storeStubs[0].fetch(request);
  }

  // ── Multi-store fanout: WebSocket ──
  if (request.headers.get("Upgrade") === "websocket") {
    const clientPair = new WebSocketPair();
    const clientWs = clientPair[0];
    const serverWs = clientPair[1];
    serverWs.accept();

    const upstreamSockets: WebSocket[] = [];

    for (const stub of storeStubs) {
      const upstreamRes = await stub.fetch(
        new Request("https://do/events", {
          headers: { "Upgrade": "websocket" },
        }),
      );
      const upstreamWs = upstreamRes.webSocket;
      if (!upstreamWs) continue;

      upstreamWs.accept();
      upstreamSockets.push(upstreamWs);

      let firstMessage = true;
      upstreamWs.addEventListener("message", (event: MessageEvent) => {
        if (firstMessage) {
          firstMessage = false;
          return;
        }
        try {
          serverWs.send(typeof event.data === "string" ? event.data : "");
        } catch {
          // Client disconnected.
        }
      });

      upstreamWs.addEventListener("close", () => {
        const idx = upstreamSockets.indexOf(upstreamWs);
        if (idx >= 0) upstreamSockets.splice(idx, 1);
      });
    }

    serverWs.addEventListener("message", (event: MessageEvent) => {
      for (const ws of upstreamSockets) {
        try {
          ws.send(typeof event.data === "string" ? event.data : "");
        } catch { /* upstream gone */ }
      }
    });

    serverWs.addEventListener("close", () => {
      for (const ws of upstreamSockets) {
        try { ws.close(1000, "client disconnected"); } catch { /* ok */ }
      }
    });

    serverWs.send(JSON.stringify({ status: "connected", stores: accountIds.length }));

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  // ── Multi-store fanout: SSE ──
  const sseEncoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  writer.write(sseEncoder.encode(
    `data: ${JSON.stringify({ status: "connected", stores: accountIds.length })}\n\n`,
  ));

  const upstreamAborts: AbortController[] = [];

  for (const stub of storeStubs) {
    const abortCtrl = new AbortController();
    upstreamAborts.push(abortCtrl);

    const upstreamRes = await stub.fetch(
      new Request("https://do/events", {
        signal: abortCtrl.signal,
      }),
    );

    if (!upstreamRes.body) continue;

    const reader = upstreamRes.body.getReader();
    const pump = async () => {
      let skipFirst = true;
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          buffer += text;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            if (!frame.trim()) continue;
            if (skipFirst) {
              skipFirst = false;
              continue;
            }
            await writer.write(sseEncoder.encode(frame + "\n\n"));
          }
        }
      } catch {
        // Stream ended or aborted.
      }
    };
    ctx.waitUntil(pump());
  }

  request.signal.addEventListener("abort", () => {
    for (const ctrl of upstreamAborts) {
      ctrl.abort();
    }
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

