/**
 * Cloudflare Worker entrypoint for github-webhook-mcp
 *
 * Routes (handled by OAuthProvider wrapper):
 *   /.well-known/oauth-authorization-server — RFC 8414 metadata discovery
 *   /oauth/register  — RFC 7591 dynamic client registration
 *   /oauth/token     — Token issuance and refresh
 *
 * Routes (OAuth-protected API, validated by OAuthProvider):
 *   POST /mcp   — McpAgent DO (Streamable HTTP MCP protocol)
 *   GET  /events — SSE/WebSocket stream via tenant WebhookStore DO
 *
 * Routes (defaultHandler, no OAuth token required):
 *   POST /webhooks/github — GitHub webhook receiver
 *     Auth chain: IP allowlist → rate limit → signature → tenant → quota
 *   GET  /oauth/authorize  — Start GitHub OAuth flow
 *   GET  /oauth/callback   — GitHub OAuth callback
 */
import { WebhookMcpAgent } from "./agent.js";
import { WebhookStore } from "./store.js";
import { TenantRegistry } from "./tenant.js";
import {
  createOAuthProvider,
  handleAuthorize,
  handleGitHubCallback,
  type OAuthEnv,
  type GitHubUserProps,
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

  // Handle installation lifecycle events
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

  // Normal resolution: lookup installation_id -> account_id
  const resolveRes = await registry.fetch(
    new Request(`https://registry/resolve?installation_id=${installationId}`),
  );

  if (!resolveRes.ok) return null;

  const info = await resolveRes.json() as { account_id: number; account_login: string };
  return info;
}

// McpAgent.serve() returns a fetch handler for MCP protocol.
// It reads ctx.props (set by OAuthProvider) and passes them to the DO via getAgentByName.
const mcpHandler = WebhookMcpAgent.serve("/mcp");

/**
 * Inner handler — processes requests after OAuthProvider routing.
 *
 * For API routes (/mcp, /events): OAuthProvider has already validated the
 * access token and set ctx.props with GitHubUserProps.
 *
 * For default routes: OAuthProvider passes through without token validation.
 * env.OAUTH_PROVIDER is set with OAuthHelpers for the authorize/callback flow.
 */
const innerHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Webhook receiver (no OAuth required) ──────────────────
    // Authentication check order:
    //   1. IP allowlist (cheapest — no body read, no crypto)
    //   2. Per-IP rate limit (in-memory, no I/O)
    //   3. Signature verification (requires body read + HMAC)
    //   4. Tenant resolution (DO call)
    //   5. Per-tenant quota check (DO call, atomic increment)
    //   6. Forward to WebhookStore DO
    // Each layer blocks before the next to minimize DO calls on invalid requests.
    if (url.pathname === "/webhooks/github" && request.method === "POST") {
      // 1. IP allowlist — block non-GitHub IPs before any processing
      if (!(await isGitHubWebhookIP(request))) {
        return new Response("Forbidden", { status: 403 });
      }

      // 2. Rate limit per IP — lightweight in-memory check
      const webhookIP = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!checkWebhookRateLimit(webhookIP)) return rateLimitResponse();

      // 3. Signature verification — read body and verify HMAC
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

      // 4. Tenant resolution — resolve installation_id → account via TenantRegistry DO
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

      // 5. Per-tenant quota check — atomic check-and-increment in TenantRegistry DO
      //    Prevents a single tenant from consuming unbounded storage.
      //    Skip for installation lifecycle events (created/deleted) to avoid blocking registration.
      if (eventType !== "installation") {
        const registryId = env.TENANT_REGISTRY.idFromName("global");
        const registry = env.TENANT_REGISTRY.get(registryId);
        const quotaResult = await checkTenantQuota(registry, tenant.account_id);
        if (!quotaResult.allowed) {
          return quotaResult.response;
        }
      }

      // 6. Forward to tenant-specific WebhookStore DO (store-{accountId})
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

    // ── SSE/WebSocket stream (OAuth-protected, ctx.props set) ─
    if (url.pathname === "/events" && (request.method === "GET" || request.headers.get("Upgrade") === "websocket")) {
      const props = (ctx as unknown as { props: GitHubUserProps }).props;
      if (!props?.githubUserId) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Route to tenant-specific WebhookStore DO
      const storeName = `store-${props.githubUserId}`;
      const doId = env.WEBHOOK_STORE.idFromName(storeName);
      const stub = env.WEBHOOK_STORE.get(doId);
      return stub.fetch(request);
    }

    // ── MCP endpoint (OAuth-protected, ctx.props set) ────────
    // McpAgent.serve() handler reads ctx.props automatically and passes
    // them to the DO via getAgentByName. The agent uses props.account_id
    // to resolve its tenant-specific WebhookStore.
    if (url.pathname.startsWith("/mcp")) {
      const props = (ctx as unknown as { props: GitHubUserProps }).props;
      if (!props?.githubUserId) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Rewrite ctx.props to TenantProps shape expected by WebhookMcpAgent.
      // accessible_account_ids includes the user's own ID plus any org IDs
      // whose App installations the user has access to, enabling cross-org event visibility.
      (ctx as unknown as { props: { account_id: number; account_login: string; accessible_account_ids: number[] } }).props = {
        account_id: props.githubUserId,
        account_login: props.githubLogin,
        accessible_account_ids: props.accessibleAccountIds ?? [props.githubUserId],
      };

      return mcpHandler.fetch(request, env, ctx);
    }

    // ── OAuth authorize (redirect to GitHub) ─────────────────
    if (url.pathname === "/oauth/authorize") {
      const oauthHelpers = (env as unknown as { OAUTH_PROVIDER: Parameters<typeof handleAuthorize>[2] }).OAUTH_PROVIDER;
      return handleAuthorize(request, env, oauthHelpers);
    }

    // ── OAuth callback (GitHub redirects back here) ──────────
    if (url.pathname === "/oauth/callback") {
      const oauthHelpers = (env as unknown as { OAUTH_PROVIDER: Parameters<typeof handleGitHubCallback>[2] }).OAUTH_PROVIDER;
      return handleGitHubCallback(request, env, oauthHelpers);
    }

    return new Response("Not found", { status: 404 });
  },
};

// OAuthProvider wraps the inner handler, adding OAuth endpoints
// and protecting /mcp and /events routes with access token validation.
export default createOAuthProvider(innerHandler as unknown as ExportedHandler<OAuthEnv & Record<string, unknown>>);
