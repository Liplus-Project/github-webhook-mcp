/**
 * Bespoke OAuth implementation for github-webhook-mcp.
 *
 * Implements OAuth 2.1 Device Authorization Grant (RFC 8628) with GitHub as the
 * upstream identity provider (also via device flow). Replaces the previous
 * @cloudflare/workers-oauth-provider integration, which did not support device
 * flow and relied on an ephemeral localhost callback that failed across process
 * restarts (see #195 / #198).
 *
 * Endpoints served:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST /oauth/register                           RFC 7591 dynamic registration
 *   POST /oauth/device_authorization               RFC 8628 §3.1
 *   POST /oauth/token                              RFC 8628 §3.4 + refresh_token
 *   GET  /oauth/device                             Human-friendly approval redirect
 *   GET  /oauth/authorize                          410 Gone (legacy endpoint)
 *   GET  /oauth/callback                           410 Gone (legacy endpoint)
 *
 * GitHub upstream (device flow):
 *   POST https://github.com/login/device/code
 *   POST https://github.com/login/oauth/access_token
 */

import {
  ACCESS_TOKEN_TTL,
  DEVICE_CODE_TTL,
  DEVICE_POLL_INTERVAL,
  REFRESH_TOKEN_TTL,
  deleteAccessToken,
  deleteDevice,
  deleteGrant,
  deleteRefreshToken,
  getAccessToken,
  getClient,
  getDevice,
  getGrant,
  getRefreshToken,
  grantIdFor,
  putAccessToken,
  putClient,
  putDevice,
  putGrant,
  putRefreshToken,
  randomToken,
  randomUserCode,
  type ClientRecord,
  type DeviceRecord,
  type GrantRecord,
} from "./oauth-store.js";

/** GitHub device flow endpoints. */
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API = "https://api.github.com/user";
const GITHUB_VERIFICATION_URI = "https://github.com/login/device";

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
  if (path === "/oauth/device_authorization" && request.method === "POST") {
    return handleDeviceAuthorization(request, env);
  }
  if (path === "/oauth/token" && request.method === "POST") {
    return handleToken(request, env);
  }
  if (path === "/oauth/device" && request.method === "GET") {
    // Human-friendly landing page: forward the user to GitHub's device page.
    // The actual approval is driven by GitHub's device flow — the user enters
    // the code at https://github.com/login/device directly. This route exists
    // mainly so verification_uri_complete can include a user_code query param
    // and land somewhere informative.
    return handleDeviceLanding(request);
  }

  // Legacy endpoints removed in v0.11.0 (see #198). Return 410 Gone so old
  // clients fail loudly rather than silently fall into an auth loop.
  if (path === "/oauth/authorize" || path === "/oauth/callback") {
    return new Response(
      "This endpoint was removed in v0.11.0. Update your MCP client to use the device authorization grant (RFC 8628).",
      { status: 410, headers: { "Content-Type": "text/plain" } },
    );
  }

  return null;
}

// ── /.well-known/oauth-authorization-server (RFC 8414) ────────────

function handleMetadata(request: Request): Response {
  const origin = new URL(request.url).origin;
  return jsonResponse({
    issuer: origin,
    registration_endpoint: `${origin}/oauth/register`,
    device_authorization_endpoint: `${origin}/oauth/device_authorization`,
    token_endpoint: `${origin}/oauth/token`,
    grant_types_supported: [
      "urn:ietf:params:oauth:grant-type:device_code",
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
    // Device flow clients are public — no secret issued.
    redirect_uris: redirectUris,
    grant_types: [
      "urn:ietf:params:oauth:grant-type:device_code",
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

// ── /oauth/device_authorization (RFC 8628 §3.1) ───────────────────

async function handleDeviceAuthorization(request: Request, env: OAuthEnv): Promise<Response> {
  const form = await readForm(request);
  const clientId = form.get("client_id");
  if (!clientId) {
    return oauthError("invalid_request", "client_id is required", 400);
  }

  const client = await getClient(env.OAUTH_KV, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const scope = form.get("scope") ?? "";

  // Request a device code from GitHub first so that our device_code and the
  // upstream device_code line up. The user types the GitHub user_code into
  // https://github.com/login/device directly; our own user_code is informational.
  const githubDeviceRes = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "github-webhook-mcp",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
    }).toString(),
  });

  if (!githubDeviceRes.ok) {
    const text = await githubDeviceRes.text();
    console.log(`[oauth] github device_code failed status=${githubDeviceRes.status} body=${text.slice(0, 200)}`);
    return oauthError("server_error", "Upstream device authorization failed", 502);
  }

  type GitHubDeviceResponse = {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  const gh = await githubDeviceRes.json() as GitHubDeviceResponse;

  if (gh.error || !gh.device_code || !gh.user_code) {
    console.log(`[oauth] github device_code error=${gh.error} desc=${gh.error_description}`);
    return oauthError(
      gh.error === "device_flow_disabled" ? "server_error" : (gh.error ?? "server_error"),
      gh.error_description ?? "Upstream device authorization failed",
      gh.error === "device_flow_disabled" ? 503 : 400,
    );
  }

  // Use the GitHub device_code as our own device_code. The record on our side
  // carries polling state and, once approved, the issued grant props.
  const expiresIn = gh.expires_in ?? DEVICE_CODE_TTL;
  const interval = gh.interval ?? DEVICE_POLL_INTERVAL;
  const now = nowSec();

  const record: DeviceRecord = {
    device_code: gh.device_code,
    user_code: randomUserCode(),
    client_id: clientId,
    scope,
    expires_at: now + expiresIn,
    interval,
    next_poll_at: now + interval,
    status: "pending",
  };

  await putDevice(env.OAUTH_KV, record);

  // verification_uri_complete uses GitHub's user_code so the user lands on a
  // page with the code already filled in. The local user_code we generated is
  // not used by GitHub but kept for log correlation.
  const verificationUriComplete = `${GITHUB_VERIFICATION_URI}?user_code=${encodeURIComponent(gh.user_code)}`;

  return jsonResponse({
    device_code: record.device_code,
    user_code: gh.user_code,
    verification_uri: gh.verification_uri ?? GITHUB_VERIFICATION_URI,
    verification_uri_complete: verificationUriComplete,
    expires_in: expiresIn,
    interval,
  });
}

// ── /oauth/token ──────────────────────────────────────────────────

async function handleToken(request: Request, env: OAuthEnv): Promise<Response> {
  const form = await readForm(request);
  const grantType = form.get("grant_type");

  if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    return handleTokenDeviceCode(form, env);
  }
  if (grantType === "refresh_token") {
    return handleTokenRefresh(form, env);
  }
  return oauthError("unsupported_grant_type", `grant_type=${grantType ?? "(missing)"} is not supported`, 400);
}

async function handleTokenDeviceCode(form: URLSearchParams, env: OAuthEnv): Promise<Response> {
  const deviceCode = form.get("device_code");
  const clientId = form.get("client_id");
  if (!deviceCode || !clientId) {
    return oauthError("invalid_request", "device_code and client_id are required", 400);
  }

  const client = await getClient(env.OAUTH_KV, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const record = await getDevice(env.OAUTH_KV, deviceCode);
  if (!record || record.client_id !== clientId) {
    return oauthError("expired_token", "Device code is invalid or expired", 400);
  }

  const now = nowSec();
  if (now >= record.expires_at) {
    await deleteDevice(env.OAUTH_KV, record);
    return oauthError("expired_token", "Device code has expired", 400);
  }

  if (record.status === "denied") {
    await deleteDevice(env.OAUTH_KV, record);
    return oauthError("access_denied", "User denied authorization", 400);
  }

  // Poll GitHub for the user's approval. GitHub enforces its own interval;
  // we also enforce our own to protect against clients ignoring `interval`.
  if (record.status === "pending") {
    if (now < record.next_poll_at) {
      // Client polled faster than allowed — per RFC 8628 §3.5, bump interval
      // by 5s and return slow_down.
      record.interval += 5;
      record.next_poll_at = now + record.interval;
      await putDevice(env.OAUTH_KV, record);
      return oauthError("slow_down", "Polling too fast; increase interval", 400);
    }

    const ghRes = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "github-webhook-mcp",
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
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
      interval?: number;
    };
    const gh = await ghRes.json() as GitHubTokenResponse;

    if (gh.error === "authorization_pending") {
      record.next_poll_at = now + record.interval;
      await putDevice(env.OAUTH_KV, record);
      return oauthError("authorization_pending", "User has not yet approved", 400);
    }
    if (gh.error === "slow_down") {
      record.interval += 5;
      record.next_poll_at = now + record.interval;
      await putDevice(env.OAUTH_KV, record);
      return oauthError("slow_down", "GitHub requested slower polling", 400);
    }
    if (gh.error === "expired_token" || gh.error === "device_flow_disabled") {
      await deleteDevice(env.OAUTH_KV, record);
      return oauthError("expired_token", gh.error_description ?? "Device code expired", 400);
    }
    if (gh.error === "access_denied") {
      await deleteDevice(env.OAUTH_KV, record);
      return oauthError("access_denied", "User denied authorization", 400);
    }
    if (gh.error || !gh.access_token) {
      console.log(`[oauth] github token error=${gh.error} desc=${gh.error_description}`);
      return oauthError("server_error", gh.error_description ?? "Upstream token exchange failed", 502);
    }

    // Approved — fetch GitHub user profile and installations.
    const props = await fetchGitHubProps(gh.access_token, gh.refresh_token ?? null);
    if (!props) {
      return oauthError("server_error", "Failed to fetch GitHub user profile", 502);
    }

    record.status = "approved";
    record.props = props;
    // Keep the device record around briefly so the client's next poll
    // (which this response already satisfies) doesn't race with deletion.
    await putDevice(env.OAUTH_KV, record);

    return await issueTokensForNewGrant(env, record, props);
  }

  // status === "approved" — this shouldn't normally happen because we delete
  // the record on first successful exchange. Defensive: re-issue only if the
  // stored props still exist.
  if (record.status === "approved" && record.props) {
    return await issueTokensForNewGrant(env, record, record.props);
  }

  return oauthError("expired_token", "Device code is in an unexpected state", 400);
}

async function issueTokensForNewGrant(
  env: OAuthEnv,
  device: DeviceRecord,
  props: GitHubUserProps,
): Promise<Response> {
  const now = nowSec();
  const grantId = grantIdFor(String(props.githubUserId));
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);

  const grant: GrantRecord = {
    grant_id: grantId,
    client_id: device.client_id,
    user_id: String(props.githubUserId),
    scope: device.scope,
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

  // Consume the device record so subsequent polls return expired_token.
  await deleteDevice(env.OAUTH_KV, device);

  console.log(`[oauth] grant issued user=${props.githubLogin} (${props.githubUserId}) grant=${grantId}`);

  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: device.scope,
  });
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

// ── /oauth/device landing page (informational) ────────────────────

function handleDeviceLanding(request: Request): Response {
  const url = new URL(request.url);
  const userCode = url.searchParams.get("user_code") ?? "";
  const target = userCode
    ? `${GITHUB_VERIFICATION_URI}?user_code=${encodeURIComponent(userCode)}`
    : GITHUB_VERIFICATION_URI;
  return Response.redirect(target, 302);
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
