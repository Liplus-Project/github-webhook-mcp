/**
 * Bespoke OAuth implementation for github-webhook-mcp.
 *
 * v0.11.1 reverts to a Worker-hosted web OAuth flow (standard GitHub login +
 * 2FA UX) after the v0.11.0 device-authorization-grant iteration proved
 * awkward for end users (#209). Both root causes that drove the original
 * localhost-callback auth loop (#195) are still avoided:
 *
 *   RC1: refresh-rotation desync — resolved client-side via tokens-file
 *        re-read on invalid_grant (see mcp-server / local-mcp).
 *   RC2: localhost ephemeral-port unreachability — resolved here by pinning
 *        the GitHub `redirect_uri` to `https://<worker>/oauth/callback` so the
 *        approval step never returns to the client's machine.
 *
 * Endpoints served:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST /oauth/register                           RFC 7591 dynamic registration
 *   GET  /oauth/authorize                          State issuance + GitHub redirect
 *   GET  /oauth/callback                           GitHub code → bearer token exchange
 *   POST /oauth/token                              Web auth polling + refresh_token
 *
 * GitHub upstream (web flow):
 *   https://github.com/login/oauth/authorize
 *   POST https://github.com/login/oauth/access_token
 */

import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  WEB_AUTH_STATE_TTL,
  WEB_AUTH_POLL_INTERVAL,
  deleteAccessToken,
  deleteGrant,
  deleteRefreshToken,
  deleteWebAuthState,
  getAccessToken,
  getClient,
  getGrant,
  getRefreshToken,
  getWebAuthState,
  grantIdFor,
  putAccessToken,
  putClient,
  putGrant,
  putRefreshToken,
  putWebAuthState,
  randomToken,
  type ClientRecord,
  type GrantRecord,
  type WebAuthStateRecord,
} from "./oauth-store.js";

/** GitHub web OAuth endpoints. */
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API = "https://api.github.com/user";

/** Custom grant type for the bridge-polling half of the web OAuth flow. */
const WEB_AUTH_POLL_GRANT = "urn:ietf:params:oauth:grant-type:web_authorization_poll";

/**
 * Props stored with each OAuth grant.
 * Contains the GitHub identity and upstream tokens for the authenticated user.
 */
export interface GitHubUserProps {
  /** GitHub user ID (numeric, stable identifier). */
  githubUserId: number;
  /** GitHub login (username). */
  githubLogin: string;
  /** GitHub access token (ghu_ prefix, 8h TTL). */
  githubAccessToken: string;
  /** GitHub refresh token (ghr_ prefix, 6mo TTL). null when not provided. */
  githubRefreshToken: string | null;
  /**
   * All account IDs (user + orgs) whose App installations the user can access.
   * Populated via GET /user/installations at authorization time.
   */
  accessibleAccountIds: number[];
}

/** OAuth-relevant environment bindings. */
export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

/**
 * Result of validating an access token on a protected request.
 * Callers attach `props` to the execution context so downstream handlers
 * (McpAgent, /events) can read the GitHub identity.
 */
export interface AuthContext {
  grant: GrantRecord;
  props: GitHubUserProps;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function oauthError(code: string, description: string, status = 400): Response {
  return jsonResponse({ error: code, error_description: description }, { status });
}

/**
 * Entry point called by the Worker for any `/oauth/*` or `/.well-known/*` path.
 * Returns null if the path is not an OAuth endpoint (caller continues routing).
 */
export async function handleOAuthRequest(
  request: Request,
  env: OAuthEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/.well-known/oauth-authorization-server") {
    return handleMetadata(request);
  }
  if (path === "/oauth/register" && request.method === "POST") {
    return handleRegister(request, env);
  }
  if (path === "/oauth/authorize" && request.method === "GET") {
    return handleAuthorize(request, env);
  }
  if (path === "/oauth/callback" && request.method === "GET") {
    return handleCallback(request, env);
  }
  if (path === "/oauth/token" && request.method === "POST") {
    return handleToken(request, env);
  }

  return null;
}

// ── /.well-known/oauth-authorization-server (RFC 8414) ────────────

function handleMetadata(request: Request): Response {
  const origin = new URL(request.url).origin;
  return jsonResponse({
    issuer: origin,
    registration_endpoint: `${origin}/oauth/register`,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    grant_types_supported: [
      WEB_AUTH_POLL_GRANT,
      "refresh_token",
    ],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [],
  });
}

// ── /oauth/register (RFC 7591) ────────────────────────────────────

async function handleRegister(request: Request, env: OAuthEnv): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return oauthError("invalid_request", "Body must be JSON", 400);
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : undefined;
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];

  const clientId = randomToken(16);
  const record: ClientRecord = {
    client_id: clientId,
    client_name: clientName,
    // Public client (no per-client secret). The Worker uses its own
    // GITHUB_CLIENT_SECRET as a confidential client when talking to GitHub.
    redirect_uris: redirectUris,
    grant_types: [
      WEB_AUTH_POLL_GRANT,
      "refresh_token",
    ],
    token_endpoint_auth_method: "none",
    created_at: new Date().toISOString(),
  };

  await putClient(env.OAUTH_KV, record);

  return jsonResponse({
    client_id: record.client_id,
    client_name: record.client_name,
    redirect_uris: record.redirect_uris,
    grant_types: record.grant_types,
    token_endpoint_auth_method: record.token_endpoint_auth_method,
    client_id_issued_at: Math.floor(Date.parse(record.created_at) / 1000),
  }, { status: 201 });
}

// ── /oauth/authorize ──────────────────────────────────────────────

/**
 * Issue a pending web_auth_state record and redirect the user agent to the
 * GitHub web OAuth flow. The bridge opens this URL in the local browser; the
 * Worker is the redirect_uri target (see handleCallback), so the approval
 * never needs to return to the client's host.
 */
async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const state = url.searchParams.get("state");
  const scope = url.searchParams.get("scope") ?? "";

  if (!clientId) {
    return oauthError("invalid_request", "client_id is required", 400);
  }
  if (!state || state.length < 8) {
    return oauthError("invalid_request", "state parameter is required (min 8 chars)", 400);
  }

  const client = await getClient(env.OAUTH_KV, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const now = nowSec();
  const record: WebAuthStateRecord = {
    state,
    client_id: clientId,
    scope,
    expires_at: now + WEB_AUTH_STATE_TTL,
    status: "pending",
  };
  await putWebAuthState(env.OAUTH_KV, record);

  // Always redirect to our own /oauth/callback so the approval step returns to
  // the Worker rather than the client's localhost. This is the fix for RC2
  // (#195): no ephemeral port to bind or re-bind.
  const redirectUri = `${url.origin}/oauth/callback`;
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });
  if (scope) params.set("scope", scope);

  return Response.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`, 302);
}

// ── /oauth/callback ───────────────────────────────────────────────

/**
 * Complete the GitHub exchange after the user approves. Flip the web_auth_state
 * record to `approved` and attach the Worker-issued bearer pair so the next
 * client poll can consume it. The browser tab shows a "close this window"
 * confirmation — no information that needs to be copied back to the client.
 */
async function handleCallback(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const ghError = url.searchParams.get("error");

  if (!state) {
    return htmlResponse(
      "Authorization failed",
      "The callback is missing the state parameter. Return to your MCP client and try again.",
      400,
    );
  }

  const record = await getWebAuthState(env.OAUTH_KV, state);
  if (!record) {
    return htmlResponse(
      "Authorization expired",
      "This authorization request has expired or was never initiated. Return to your MCP client and start a new login.",
      400,
    );
  }

  // User denied authorization on the GitHub consent screen.
  if (ghError === "access_denied" || !code) {
    record.status = "denied";
    await putWebAuthState(env.OAUTH_KV, record);
    return htmlResponse(
      "Authorization denied",
      "You declined to authorize the app. You can close this window.",
      200,
    );
  }

  // Exchange the GitHub authorization code for upstream tokens as a
  // confidential client (requires GITHUB_CLIENT_SECRET, which lives in the
  // Worker environment and is never exposed to the MCP bridge).
  const redirectUri = `${url.origin}/oauth/callback`;
  const ghRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "github-webhook-mcp",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      state,
    }).toString(),
  });

  type GitHubTokenResponse = {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!ghRes.ok) {
    console.log(`[oauth] github code exchange non-2xx status=${ghRes.status}`);
    return htmlResponse(
      "Authorization failed",
      "GitHub rejected the authorization code. Return to your MCP client and try again.",
      502,
    );
  }

  const gh = await ghRes.json() as GitHubTokenResponse;
  if (gh.error || !gh.access_token) {
    console.log(`[oauth] github code exchange error=${gh.error} desc=${gh.error_description}`);
    return htmlResponse(
      "Authorization failed",
      gh.error_description ?? "GitHub did not return an access token. Return to your MCP client and try again.",
      502,
    );
  }

  const props = await fetchGitHubProps(gh.access_token, gh.refresh_token ?? null);
  if (!props) {
    return htmlResponse(
      "Authorization failed",
      "Could not fetch the GitHub user profile. Return to your MCP client and try again.",
      502,
    );
  }

  const issued = await issueTokensForNewGrant(env, record.client_id, record.scope, props);

  record.status = "approved";
  record.access_token = issued.access_token;
  record.refresh_token = issued.refresh_token;
  await putWebAuthState(env.OAUTH_KV, record);

  console.log(`[oauth] web grant approved user=${props.githubLogin} (${props.githubUserId})`);

  return htmlResponse(
    "Authorization complete",
    "You can close this window and return to your MCP client. The next tool call will succeed automatically.",
    200,
  );
}

function htmlResponse(title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
             margin: 0; padding: 2rem; display: flex; align-items: center;
             justify-content: center; min-height: 100vh; background: #f6f8fa; color: #24292f; }
      main { max-width: 32rem; background: white; border-radius: 12px;
             box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 2rem; text-align: center; }
      h1 { margin: 0 0 1rem; font-size: 1.5rem; }
      p  { margin: 0; line-height: 1.6; color: #57606a; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── /oauth/token ──────────────────────────────────────────────────

async function handleToken(request: Request, env: OAuthEnv): Promise<Response> {
  const form = await readForm(request);
  const grantType = form.get("grant_type");

  if (grantType === WEB_AUTH_POLL_GRANT) {
    return handleTokenWebAuthPoll(form, env);
  }
  if (grantType === "refresh_token") {
    return handleTokenRefresh(form, env);
  }
  return oauthError(
    "unsupported_grant_type",
    `grant_type=${grantType ?? "(missing)"} is not supported`,
    400,
  );
}

/**
 * Client-side poll for the web OAuth flow. Mirrors RFC 8628's polling error
 * shape so the bridge error-handling code stays straightforward:
 *   pending  → 400 authorization_pending
 *   approved → 200 token pair (record is deleted)
 *   expired  → 400 expired_token
 *   denied   → 400 access_denied
 */
async function handleTokenWebAuthPoll(
  form: URLSearchParams,
  env: OAuthEnv,
): Promise<Response> {
  const state = form.get("state");
  const clientId = form.get("client_id");
  if (!state || !clientId) {
    return oauthError("invalid_request", "state and client_id are required", 400);
  }

  const client = await getClient(env.OAUTH_KV, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const record = await getWebAuthState(env.OAUTH_KV, state);
  if (!record || record.client_id !== clientId) {
    return oauthError("expired_token", "state is invalid or expired", 400);
  }

  const now = nowSec();
  if (now >= record.expires_at) {
    await deleteWebAuthState(env.OAUTH_KV, state);
    return oauthError("expired_token", "state has expired", 400);
  }

  if (record.status === "denied") {
    await deleteWebAuthState(env.OAUTH_KV, state);
    return oauthError("access_denied", "User denied authorization", 400);
  }

  if (record.status === "pending") {
    return oauthError("authorization_pending", "User has not yet approved", 400);
  }

  if (record.status === "approved" && record.access_token && record.refresh_token) {
    const accessRecord = await getAccessToken(env.OAUTH_KV, record.access_token);
    const refreshRecord = await getRefreshToken(env.OAUTH_KV, record.refresh_token);
    if (!accessRecord || !refreshRecord) {
      await deleteWebAuthState(env.OAUTH_KV, state);
      return oauthError("expired_token", "issued tokens are no longer available", 400);
    }

    const body = jsonResponse({
      access_token: record.access_token,
      token_type: "Bearer",
      expires_in: Math.max(0, accessRecord.expires_at - now),
      refresh_token: record.refresh_token,
      scope: record.scope,
    });

    // Consume the state record — subsequent polls will return expired_token.
    await deleteWebAuthState(env.OAUTH_KV, state);
    return body;
  }

  return oauthError("expired_token", "state is in an unexpected state", 400);
}

async function issueTokensForNewGrant(
  env: OAuthEnv,
  clientId: string,
  scope: string,
  props: GitHubUserProps,
): Promise<{ access_token: string; refresh_token: string }> {
  const now = nowSec();
  const grantId = grantIdFor(String(props.githubUserId));
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);

  const grant: GrantRecord = {
    grant_id: grantId,
    client_id: clientId,
    user_id: String(props.githubUserId),
    scope,
    props,
    access_token: accessToken,
    refresh_token: refreshToken,
    created_at: new Date(now * 1000).toISOString(),
    updated_at: new Date(now * 1000).toISOString(),
  };

  await putGrant(env.OAUTH_KV, grant);
  await putAccessToken(env.OAUTH_KV, {
    access_token: accessToken,
    grant_id: grantId,
    expires_at: now + ACCESS_TOKEN_TTL,
  });
  await putRefreshToken(env.OAUTH_KV, {
    refresh_token: refreshToken,
    grant_id: grantId,
    expires_at: now + REFRESH_TOKEN_TTL,
  });

  console.log(`[oauth] grant issued user=${props.githubLogin} (${props.githubUserId}) grant=${grantId}`);

  return { access_token: accessToken, refresh_token: refreshToken };
}

async function handleTokenRefresh(form: URLSearchParams, env: OAuthEnv): Promise<Response> {
  const refreshTokenIn = form.get("refresh_token");
  const clientId = form.get("client_id");
  if (!refreshTokenIn || !clientId) {
    return oauthError("invalid_request", "refresh_token and client_id are required", 400);
  }

  const client = await getClient(env.OAUTH_KV, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const refresh = await getRefreshToken(env.OAUTH_KV, refreshTokenIn);
  if (!refresh) {
    return oauthError("invalid_grant", "Refresh token is invalid or has been rotated", 400);
  }
  const now = nowSec();
  if (now >= refresh.expires_at) {
    await deleteRefreshToken(env.OAUTH_KV, refreshTokenIn);
    return oauthError("invalid_grant", "Refresh token has expired", 400);
  }

  const grant = await getGrant(env.OAUTH_KV, refresh.grant_id);
  if (!grant || grant.client_id !== clientId) {
    return oauthError("invalid_grant", "Grant not found or client mismatch", 400);
  }

  // Rotate: delete old tokens, issue new ones.
  await deleteAccessToken(env.OAUTH_KV, grant.access_token);
  await deleteRefreshToken(env.OAUTH_KV, grant.refresh_token);

  const newAccess = randomToken(32);
  const newRefresh = randomToken(32);

  grant.access_token = newAccess;
  grant.refresh_token = newRefresh;
  grant.updated_at = new Date(now * 1000).toISOString();

  await putGrant(env.OAUTH_KV, grant);
  await putAccessToken(env.OAUTH_KV, {
    access_token: newAccess,
    grant_id: grant.grant_id,
    expires_at: now + ACCESS_TOKEN_TTL,
  });
  await putRefreshToken(env.OAUTH_KV, {
    refresh_token: newRefresh,
    grant_id: grant.grant_id,
    expires_at: now + REFRESH_TOKEN_TTL,
  });

  return jsonResponse({
    access_token: newAccess,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: newRefresh,
    scope: grant.scope,
  });
}

// ── GitHub profile + installations fetch ──────────────────────────

async function fetchGitHubProps(
  accessToken: string,
  refreshToken: string | null,
): Promise<GitHubUserProps | null> {
  const userRes = await fetch(GITHUB_USER_API, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "github-webhook-mcp",
      "Accept": "application/vnd.github+json",
    },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json() as { id: number; login: string };

  let accessibleAccountIds: number[] = [user.id];
  try {
    const installRes = await fetch(
      "https://api.github.com/user/installations?per_page=100",
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": "github-webhook-mcp",
          "Accept": "application/vnd.github+json",
        },
      },
    );
    if (installRes.ok) {
      const installData = await installRes.json() as {
        installations?: Array<{ account: { id: number } }>;
      };
      if (installData.installations) {
        const ids = installData.installations.map((i) => i.account.id);
        accessibleAccountIds = [...new Set([user.id, ...ids])];
      }
    }
  } catch {
    // Non-fatal — fall back to user-only access.
  }

  return {
    githubUserId: user.id,
    githubLogin: user.login,
    githubAccessToken: accessToken,
    githubRefreshToken: refreshToken,
    accessibleAccountIds,
  };
}

// ── Access-token validation middleware ────────────────────────────

/**
 * Validate the Bearer access token on a protected API request.
 *
 * Returns:
 *   { auth }           — token is valid; caller should attach auth.props to ctx
 *   { response }       — token is missing / invalid; caller should return this
 */
export async function authenticateApiRequest(
  request: Request,
  env: OAuthEnv,
): Promise<{ auth: AuthContext } | { response: Response }> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      response: new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="github-webhook-mcp"' },
      }),
    };
  }

  const token = match[1].trim();
  const tokenRecord = await getAccessToken(env.OAUTH_KV, token);
  if (!tokenRecord) {
    return { response: bearerError("invalid_token", "Access token is invalid", 401) };
  }

  const now = nowSec();
  if (now >= tokenRecord.expires_at) {
    await deleteAccessToken(env.OAUTH_KV, token);
    return { response: bearerError("invalid_token", "Access token has expired", 401) };
  }

  const grant = await getGrant(env.OAUTH_KV, tokenRecord.grant_id);
  if (!grant) {
    return { response: bearerError("invalid_token", "Grant not found", 401) };
  }

  return { auth: { grant, props: grant.props } };
}

function bearerError(code: string, description: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="${code}", error_description="${description}"`,
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────

async function readForm(request: Request): Promise<URLSearchParams> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const body = await request.json() as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  const text = await request.text();
  return new URLSearchParams(text);
}

/** Default polling interval for the web OAuth flow (seconds). */
export { WEB_AUTH_POLL_INTERVAL };
/** Custom grant type used by the bridge-polling half of the web OAuth flow. */
export { WEB_AUTH_POLL_GRANT };

/**
 * Revoke a grant (and all its tokens). Exposed for future /oauth/revoke or
 * admin operations; currently unused from the HTTP surface.
 */
export async function revokeGrant(env: OAuthEnv, grantId: string): Promise<void> {
  const grant = await getGrant(env.OAUTH_KV, grantId);
  if (!grant) return;
  await deleteAccessToken(env.OAUTH_KV, grant.access_token);
  await deleteRefreshToken(env.OAUTH_KV, grant.refresh_token);
  await deleteGrant(env.OAUTH_KV, grantId);
}
