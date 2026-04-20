#!/usr/bin/env node
/**
 * GitHub Webhook MCP — Cloudflare Worker bridge
 *
 * Thin stdio MCP server that proxies tool calls to a remote
 * Cloudflare Worker + Durable Object backend via Streamable HTTP.
 * Optionally listens via WebSocket for real-time channel notifications
 * (enables DO hibernation on the Worker side).
 * Authenticates via OAuth 2.1 Device Authorization Grant (RFC 8628);
 * user_code + verification URI are surfaced on stderr because stdio MCP
 * clients have no UI to drive an interactive browser flow.
 *
 * Discord MCP pattern: data lives in the cloud, local MCP is a thin bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import WebSocketClient from "ws";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

const WORKER_URL =
  process.env.WEBHOOK_WORKER_URL ||
  "https://github-webhook.smgjp.com";
const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

// ── OAuth Token Storage ──────────────────────────────────────────────────────

const TOKEN_DIR = join(homedir(), ".github-webhook-mcp");
const TOKEN_FILE = join(TOKEN_DIR, "oauth-tokens.json");
const CLIENT_REG_FILE = join(TOKEN_DIR, "oauth-client.json");

/**
 * Marker written on every tokens file produced by this client (v0.11.0+).
 * Legacy files from the localhost-callback flow don't have it, which is how
 * we detect a first-run migration scenario and surface the one-time notice.
 */
const TOKENS_FLOW_MARKER = "device";

async function loadTokens() {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(data);
    // Legacy files (pre-v0.11.0) lack the flow marker and carry tokens the
    // new Worker cannot honor. Ignore them here so startup doesn't adopt
    // stale state; performOAuthFlow() will surface the migration notice and
    // remove the file the first time it runs.
    if (!parsed || parsed.flow !== TOKENS_FLOW_MARKER) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let _cachedTokens = null;
let _refreshLock = null;
let _deviceFlowLock = null;
let _legacyMigrationNotified = false;

/**
 * Tracks the in-flight device authorization so tool calls can return an
 * auth-required response immediately (instead of blocking for ~600s) while
 * polling continues in the background. Cleared on success or failure so the
 * next tool call after expiry starts a fresh device code.
 */
let _pendingDeviceAuth = null;
let _pendingDeviceAuthError = null;

// ── OAuth Discovery & Registration ───────────────────────────────────────────

async function discoverOAuthMetadata() {
  const res = await fetch(`${WORKER_URL}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(`OAuth discovery failed: ${res.status}`);
  }
  return await res.json();
}

async function loadClientRegistration() {
  try {
    const data = await readFile(CLIENT_REG_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveClientRegistration(reg) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(CLIENT_REG_FILE, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function ensureClientRegistration(metadata) {
  const existing = await loadClientRegistration();
  // Legacy registrations were created for authorization_code + refresh_token.
  // Re-register if the existing one is missing the device_code grant type so
  // the Worker recognizes us as a device-flow client.
  if (existing && Array.isArray(existing.grant_types) &&
      existing.grant_types.includes(DEVICE_CODE_GRANT)) {
    return existing;
  }

  if (!metadata.registration_endpoint) {
    throw new Error("OAuth server does not support dynamic client registration");
  }

  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "github-webhook-mcp-cli",
      // Device flow does not use redirect_uris; leave empty for RFC 8628.
      redirect_uris: [],
      grant_types: [DEVICE_CODE_GRANT, "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!res.ok) {
    throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  }

  const reg = await res.json();
  await saveClientRegistration(reg);
  return reg;
}

// ── OAuth Device Authorization Grant (RFC 8628) ─────────────────────────────

/**
 * Detect a pre-v0.11.0 tokens file and surface a one-time migration notice
 * on stderr. Legacy files were written by the localhost-callback flow and
 * carry tokens the new Worker will reject, so we discard them and let the
 * device flow re-establish authentication from scratch.
 */
async function checkLegacyTokensMigration() {
  let raw;
  try {
    raw = await readFile(TOKEN_FILE, "utf-8");
  } catch {
    return; // No tokens file at all — not a migration case.
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file — treat as legacy/unusable and remove.
    parsed = null;
  }

  if (parsed && parsed.flow === TOKENS_FLOW_MARKER) {
    return; // Already a device-flow tokens file — no migration needed.
  }

  if (_legacyMigrationNotified) return;
  _legacyMigrationNotified = true;

  process.stderr.write(
    "[github-webhook-mcp] Detected legacy OAuth tokens from pre-v0.11.0 " +
    "(localhost callback flow). This client now uses the Device " +
    "Authorization Grant (RFC 8628). One-time re-authentication is " +
    "required; follow the device-code prompt below.\n",
  );

  try {
    await unlink(TOKEN_FILE);
  } catch {
    // Non-fatal: saveTokens() will overwrite it on success anyway.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort platform-native browser launcher for the device-flow
 * verification URL. Failures are non-fatal: we still surface the URL on
 * stderr / in the tool response so the user can open it manually.
 */
function openBrowser(url) {
  if (!url || typeof url !== "string") return;
  try {
    const plat = osPlatform();
    let command;
    let args;
    let options = { detached: true, stdio: "ignore" };

    if (plat === "win32") {
      // `start` is a cmd.exe builtin, not a standalone executable.
      // The empty "" argument is the window title placeholder expected by
      // `start` when the URL is quoted.
      command = "cmd.exe";
      args = ["/c", "start", "", url];
    } else if (plat === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    const child = spawn(command, args, options);
    child.on("error", (err) => {
      process.stderr.write(
        `[github-webhook-mcp] Failed to auto-open browser (${err.message || err}). ` +
        `Open this URL manually: ${url}\n`,
      );
    });
    if (typeof child.unref === "function") child.unref();
  } catch (err) {
    process.stderr.write(
      `[github-webhook-mcp] Failed to auto-open browser (${err && err.message ? err.message : err}). ` +
      `Open this URL manually: ${url}\n`,
    );
  }
}

async function requestDeviceAuthorization(metadata, client) {
  const endpoint =
    metadata.device_authorization_endpoint ||
    `${WORKER_URL}/oauth/device_authorization`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.client_id }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Device authorization request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }

  const data = await res.json();
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(
      `Device authorization response missing required fields: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return data;
}

/**
 * Poll the Worker's /oauth/token endpoint until the user approves, denies,
 * or the device_code expires. Interval comes from the server; `slow_down`
 * replies bump it by 5s per RFC 8628 §3.5.
 */
async function pollForDeviceToken(metadata, client, deviceAuth) {
  const endpoint = metadata.token_endpoint || `${WORKER_URL}/oauth/token`;
  let interval = Math.max(1, Number(deviceAuth.interval) || 5);
  const deadline = Date.now() + (Number(deviceAuth.expires_in) || 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT,
          device_code: deviceAuth.device_code,
          client_id: client.client_id,
        }),
      });
    } catch (err) {
      // Transient network error — keep polling.
      console.error("[oauth] token poll network error:", err.message || err);
      continue;
    }

    if (res.ok) {
      return await res.json();
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const err = body && typeof body.error === "string" ? body.error : null;

    if (err === "authorization_pending") {
      continue;
    }
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "access_denied") {
      throw new Error("OAuth authorization denied by user");
    }
    if (err === "expired_token") {
      throw new Error(
        "OAuth device code expired before approval. Re-run the client to retry.",
      );
    }

    // Unexpected error — surface and stop polling.
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}` +
      (body ? ` — ${JSON.stringify(body).slice(0, 200)}` : ""),
    );
  }

  throw new Error(
    "OAuth device code expired before approval. Re-run the client to retry.",
  );
}

/**
 * Start a device authorization flow: obtain device_code/user_code, surface the
 * verification URL (stderr + auto-open browser), and kick off a background
 * poll. Callers that await the returned promise will block until the user
 * approves — this is what the WebSocket bootstrap does. Callers that only
 * need the deviceAuth metadata (for a non-blocking tool response) can read
 * `_pendingDeviceAuth` as soon as this function resolves past the await
 * below; see `getAccessTokenOrPendingAuth()`.
 *
 * Serialization: _deviceFlowLock ensures that concurrent callers (WebSocket
 * bootstrap racing the first tool call) share a single device code rather
 * than each launching their own approval prompt.
 */
async function performOAuthFlow() {
  if (_deviceFlowLock) {
    return await _deviceFlowLock;
  }

  // Phase 1: obtain the device code. This is fast (one HTTP round-trip) and
  // we surface the verification URL as soon as it returns.
  const startPromise = (async () => {
    await checkLegacyTokensMigration();

    const metadata = await discoverOAuthMetadata();
    const client = await ensureClientRegistration(metadata);
    const deviceAuth = await requestDeviceAuthorization(metadata, client);

    const complete = deviceAuth.verification_uri_complete;
    const browserUrl = complete || deviceAuth.verification_uri;

    // stdio MCP clients have no UI surface of their own, so we publish the
    // user_code and verification URI on stderr where the host logs land. The
    // auth-required tool response (below) is the primary channel for Claude
    // Code / Desktop; stderr is the fallback surface.
    const lines = [
      "",
      "[github-webhook-mcp] OAuth device authorization required.",
      `[github-webhook-mcp] Visit: ${deviceAuth.verification_uri}`,
      `[github-webhook-mcp] Enter code: ${deviceAuth.user_code}`,
    ];
    if (complete && complete !== deviceAuth.verification_uri) {
      lines.push(`[github-webhook-mcp] Or open directly: ${complete}`);
    }
    lines.push(
      `[github-webhook-mcp] Opening browser for authentication...`,
      `[github-webhook-mcp] Waiting for approval (expires in ${deviceAuth.expires_in || "?"}s)...`,
      "",
    );
    process.stderr.write(lines.join("\n"));

    // Best-effort browser auto-open. Failures are logged to stderr but do
    // not abort the flow — the URL is still available in the tool response.
    openBrowser(browserUrl);

    const expiresAt = deviceAuth.expires_in
      ? Date.now() + Number(deviceAuth.expires_in) * 1000
      : undefined;

    _pendingDeviceAuth = {
      user_code: deviceAuth.user_code,
      verification_uri: deviceAuth.verification_uri,
      verification_uri_complete: complete || null,
      expires_at: expiresAt,
    };
    _pendingDeviceAuthError = null;

    return { metadata, client, deviceAuth };
  })();

  // Phase 2: poll in the background (still inside the same lock promise so
  // that simultaneous callers await one shared flow). Errors are recorded
  // and re-thrown so awaiting callers see them.
  _deviceFlowLock = (async () => {
    try {
      const { metadata, client, deviceAuth } = await startPromise;
      const tokenData = await pollForDeviceToken(metadata, client, deviceAuth);

      if (!tokenData.access_token) {
        throw new Error(
          `Token response missing access_token: ${JSON.stringify(tokenData).slice(0, 200)}`,
        );
      }

      const tokens = {
        flow: TOKENS_FLOW_MARKER,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : undefined,
      };

      await saveTokens(tokens);
      _cachedTokens = tokens;
      _pendingDeviceAuth = null;
      _pendingDeviceAuthError = null;
      process.stderr.write("[github-webhook-mcp] OAuth device authorization complete.\n");
      return tokens;
    } catch (err) {
      _pendingDeviceAuth = null;
      _pendingDeviceAuthError = err && err.message ? err.message : String(err);
      throw err;
    }
  })();

  // Make sure the caller-visible promise settles deterministically when the
  // background poll finishes (or errors). Don't await inside the lock itself;
  // other callers may want to see _pendingDeviceAuth without blocking.
  const lockPromise = _deviceFlowLock;
  lockPromise.finally(() => {
    if (_deviceFlowLock === lockPromise) {
      _deviceFlowLock = null;
    }
  });

  // Wait for phase 1 so the caller sees _pendingDeviceAuth populated (or the
  // startPromise's error) before we return the outer promise.
  await startPromise;
  return lockPromise;
}

async function refreshAccessToken(refreshToken) {
  const metadata = await discoverOAuthMetadata();
  const client = await loadClientRegistration();
  if (!client) throw new Error("No client registration found");

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      `Token refresh failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
    console.error("[oauth] refresh failed:", err.message);
    throw err;
  }

  const data = await res.json();

  if (!data.access_token) {
    const err = new Error(
      `Token refresh returned no access_token: ${JSON.stringify(data).slice(0, 200)}`,
    );
    console.error("[oauth] refresh malformed:", err.message);
    throw err;
  }

  const tokens = {
    flow: TOKENS_FLOW_MARKER,
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };

  await saveTokens(tokens);
  console.error("[oauth] token refreshed successfully, expires in %ds", data.expires_in || "unknown");
  return tokens;
}

async function getAccessToken() {
  if (!_cachedTokens) {
    _cachedTokens = await loadTokens();
  }

  if (_cachedTokens) {
    // Proactive refresh: refresh 5 minutes before expiry instead of after
    const REFRESH_BUFFER_MS = 5 * 60_000;
    if (!_cachedTokens.expires_at || _cachedTokens.expires_at > Date.now() + REFRESH_BUFFER_MS) {
      return _cachedTokens.access_token;
    }

    if (_cachedTokens.refresh_token) {
      // Serialize concurrent refresh attempts to prevent race conditions.
      // Without this lock, the WebSocket startup and the first tool call can
      // both trigger refreshAccessToken() with the same refresh token
      // simultaneously, causing the token file to end up with an orphaned
      // refresh token that the Worker no longer recognizes.
      if (!_refreshLock) {
        _refreshLock = refreshAccessToken(_cachedTokens.refresh_token);
      }
      try {
        _cachedTokens = await _refreshLock;
        return _cachedTokens.access_token;
      } catch (err) {
        console.error("[oauth] refresh failed, falling back to full OAuth flow:", err.message || err);
      } finally {
        _refreshLock = null;
      }
    } else {
      console.error("[oauth] no refresh_token available, requiring full OAuth flow");
    }
  }

  _cachedTokens = await performOAuthFlow();
  return _cachedTokens.access_token;
}

/**
 * Sentinel thrown by `getAccessTokenForToolCall()` when the device flow is
 * still pending approval. The tool handler catches this and returns a
 * structured auth-required response to the MCP client without blocking on
 * the poll loop.
 */
class AuthRequiredError extends Error {
  constructor(pending, note) {
    super(note || "OAuth device authorization required");
    this.name = "AuthRequiredError";
    this.pending = pending;
  }
}

/**
 * Like getAccessToken(), but never blocks on the device-flow poll. If no
 * tokens are available, it starts the flow (if not already running) and
 * throws an AuthRequiredError carrying the current device-code details so
 * the caller can surface them in the tool response immediately.
 */
async function getAccessTokenForToolCall() {
  if (!_cachedTokens) {
    _cachedTokens = await loadTokens();
  }

  if (_cachedTokens) {
    const REFRESH_BUFFER_MS = 5 * 60_000;
    if (!_cachedTokens.expires_at || _cachedTokens.expires_at > Date.now() + REFRESH_BUFFER_MS) {
      return _cachedTokens.access_token;
    }

    if (_cachedTokens.refresh_token) {
      // Refresh synchronously — refresh calls are one round-trip, unlike
      // the full device flow, so blocking a tool call here is fine.
      if (!_refreshLock) {
        _refreshLock = refreshAccessToken(_cachedTokens.refresh_token);
      }
      try {
        _cachedTokens = await _refreshLock;
        return _cachedTokens.access_token;
      } catch (err) {
        console.error(
          "[oauth] refresh failed, starting device flow in background:",
          err.message || err,
        );
      } finally {
        _refreshLock = null;
      }
    }
  }

  // No usable tokens. Start the device flow if it isn't already running;
  // either way, hand the caller the current pending device_code details.
  if (!_pendingDeviceAuth && !_deviceFlowLock) {
    // Swallow the outer promise; the background poll settles via
    // _deviceFlowLock. Errors during phase 1 (e.g. network failure to
    // /oauth/device_authorization) propagate synchronously below.
    performOAuthFlow().catch((err) => {
      // Already captured into _pendingDeviceAuthError; log for operators.
      console.error("[oauth] device flow background poll ended with error:", err.message || err);
    });

    // Wait briefly (phase 1 is a single HTTP round-trip) so _pendingDeviceAuth
    // is populated before we throw — but never block for the full poll.
    // performOAuthFlow() only returns once phase 1 has resolved, so we can
    // await the lock promise safely. The lock is created synchronously inside
    // performOAuthFlow(), so it's guaranteed to be non-null here.
    if (_deviceFlowLock) {
      try {
        // Awaiting the lock resolves when polling finishes. We instead await
        // via a tick to give startPromise time to populate _pendingDeviceAuth.
        await Promise.race([
          // Let phase 1 populate _pendingDeviceAuth.
          new Promise((resolve) => setImmediate(resolve)),
          // If phase 1 fails fast, the lock rejects and we re-throw.
          _deviceFlowLock.then(() => undefined, (err) => { throw err; }),
        ]);
      } catch (err) {
        throw err;
      }
    }
  }

  // Give phase 1 a little more time to finish (device_authorization request
  // is a single round-trip — normally sub-second). Poll the state briefly
  // so we return a populated auth-required response instead of an empty one.
  const phase1Deadline = Date.now() + 15_000;
  while (!_pendingDeviceAuth && !_pendingDeviceAuthError && Date.now() < phase1Deadline) {
    await sleep(100);
  }

  if (_pendingDeviceAuthError && !_pendingDeviceAuth) {
    throw new Error(`OAuth device flow failed: ${_pendingDeviceAuthError}`);
  }

  if (_pendingDeviceAuth) {
    throw new AuthRequiredError(_pendingDeviceAuth);
  }

  // Phase 1 timed out — surface as a regular error.
  throw new Error("OAuth device flow did not produce a verification URL in time.");
}

async function buildAuthHeaders(token, extra) {
  const h = { ...extra };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// ── Remote MCP Session (lazy, reused) ────────────────────────────────────────

let _sessionId = null;

async function getSessionIdWithToken(token) {
  if (_sessionId) return _sessionId;

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await buildAuthHeaders(token, {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "local-bridge", version: "1.0.0" },
      },
      id: "init",
    }),
  });

  _sessionId = res.headers.get("mcp-session-id") || "";
  return _sessionId;
}

async function callRemoteToolWithToken(name, args, token, _retried = false) {
  const sessionId = await getSessionIdWithToken(token);

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await buildAuthHeaders(token, {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: crypto.randomUUID(),
    }),
  });

  // 401 = token expired or revoked. Clear session + token cache and retry
  // once with a freshly acquired token (refresh or full flow).
  if (res.status === 401) {
    if (_retried) {
      return { content: [{ type: "text", text: "Authentication failed after retry. Please re-authenticate." }] };
    }
    _cachedTokens = null;
    _sessionId = null;
    const freshToken = await getAccessTokenForToolCall();
    return callRemoteToolWithToken(name, args, freshToken, true);
  }

  const text = await res.text();

  // Streamable HTTP may return SSE format
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

  if (json.error) {
    // Session expired — retry once with a fresh session
    if ((json.error.code === -32600 || json.error.code === -32001) && !_retried) {
      _sessionId = null;
      return callRemoteToolWithToken(name, args, token, true);
    }
    return { content: [{ type: "text", text: JSON.stringify(json.error) }] };
  }

  return json.result;
}

// ── MCP Server Setup ─────────────────────────────────────────────────────────

const capabilities = { tools: {} };
if (CHANNEL_ENABLED) {
  capabilities.experimental = { "claude/channel": {} };
}

const server = new Server(
  { name: "github-webhook-mcp", version: PACKAGE_VERSION },
  {
    capabilities,
    instructions: CHANNEL_ENABLED
      ? 'GitHub webhook events arrive as <channel source="github-webhook-mcp" ...>. They are one-way: read them and act, no reply expected.'
      : undefined,
  },
);

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_pending_status",
    title: "Get Pending Status",
    description:
      "Get a lightweight snapshot of pending GitHub webhook events. Use this for periodic polling before requesting details.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "Get Pending Status",
      readOnlyHint: true,
    },
  },
  {
    name: "list_pending_events",
    title: "List Pending Events",
    description:
      "List lightweight summaries for pending GitHub webhook events. Returns metadata only, without full payloads.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description:
            "Maximum number of pending events to return (1-100, default 20)",
        },
      },
    },
    annotations: {
      title: "List Pending Events",
      readOnlyHint: true,
    },
  },
  {
    name: "get_event",
    title: "Get Event Payload",
    description: "Get the full payload for a single webhook event by ID.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The event ID to retrieve" },
      },
      required: ["event_id"],
    },
    annotations: {
      title: "Get Event Payload",
      readOnlyHint: true,
    },
  },
  {
    name: "get_webhook_events",
    title: "Get Webhook Events",
    description:
      "Get pending (unprocessed) GitHub webhook events with full payloads. Prefer get_pending_status or list_pending_events for polling.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "Get Webhook Events",
      readOnlyHint: true,
    },
  },
  {
    name: "mark_processed",
    title: "Mark Event Processed",
    description:
      "Mark a webhook event as processed so it won't appear again.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "The event ID to mark as processed",
        },
      },
      required: ["event_id"],
    },
    annotations: {
      title: "Mark Event Processed",
      destructiveHint: true,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function formatAuthRequiredResponse(pending) {
  const parts = [];
  parts.push("OAuth device authorization required.");
  parts.push("");
  if (pending.verification_uri_complete) {
    parts.push(`Open (code pre-filled): ${pending.verification_uri_complete}`);
    parts.push("");
    parts.push(`Or visit ${pending.verification_uri} and enter the code:`);
  } else {
    parts.push(`Visit: ${pending.verification_uri}`);
    parts.push("Enter the code:");
  }
  parts.push(`  ${pending.user_code}`);
  parts.push("");
  if (pending.expires_at) {
    const remainingMs = pending.expires_at - Date.now();
    if (remainingMs > 0) {
      const mins = Math.max(1, Math.round(remainingMs / 60_000));
      parts.push(`Code expires in about ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
  }
  parts.push(
    "A browser window should have opened automatically. " +
      "Retry the same tool call after approving — subsequent calls will succeed once authorization completes.",
  );
  return parts.join("\n");
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const token = await getAccessTokenForToolCall();
    const result = await callRemoteToolWithToken(name, args ?? {}, token);
    // First successful tool call confirms OAuth is working
    markOAuthEstablished();
    return result;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return {
        content: [{ type: "text", text: formatAuthRequiredResponse(err.pending) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Failed to reach worker: ${err}` }],
      isError: true,
    };
  }
});

// ── WebSocket Listener → Channel Notifications ──────────────────────────────

/** Track whether OAuth has been established (first successful tool call). */
let _oauthEstablished = false;

function markOAuthEstablished() {
  if (!_oauthEstablished) {
    _oauthEstablished = true;
    if (CHANNEL_ENABLED && !_wsConnected) {
      process.stderr.write("[github-webhook-mcp] OAuth established, starting WebSocket connection\n");
      connectWebSocket();
    }
  }
}

let _wsConnected = false;

async function connectWebSocket() {
  const wsUrl = WORKER_URL.replace(/^http/, "ws") + "/events";

  _wsConnected = true;
  let retryCount = 0;
  const MAX_RETRY_DELAY = 60_000; // 60 seconds
  const BASE_RETRY_DELAY = 1_000; // 1 second

  async function connect() {
    let token;
    try {
      token = await getAccessToken();
    } catch (err) {
      process.stderr.write(`[github-webhook-mcp] WebSocket: failed to get access token: ${err}\n`);
      scheduleRetry();
      return;
    }

    if (!token) {
      process.stderr.write("[github-webhook-mcp] WebSocket: no access token available, will retry\n");
      scheduleRetry();
      return;
    }

    let ws;
    let pingTimer = null;

    try {
      ws = new WebSocketClient(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      process.stderr.write(`[github-webhook-mcp] WebSocket: failed to create connection: ${err}\n`);
      scheduleRetry();
      return;
    }

    ws.on("open", () => {
      retryCount = 0; // Reset backoff on successful connection
      process.stderr.write("[github-webhook-mcp] WebSocket: connected\n");
      // Send periodic pings to keep connection alive (25s keepalive)
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocketClient.OPEN) {
          ws.send("ping");
        }
      }, 25_000);
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Skip status, pong, heartbeat messages
        if ("status" in data || "pong" in data || "heartbeat" in data) return;
        if (!data.summary) return;

        const s = data.summary;
        const lines = [
          `[${s.type}] ${s.repo ?? ""}`,
          s.action ? `action: ${s.action}` : null,
          s.title ? `#${s.number ?? ""} ${s.title}` : null,
          s.sender ? `by ${s.sender}` : null,
          s.url ?? null,
        ].filter(Boolean);

        server.notification({
          method: "notifications/claude/channel",
          params: {
            content: lines.join("\n"),
            meta: {
              chat_id: "github",
              message_id: s.id,
              user: s.sender ?? "github",
              ts: s.received_at,
            },
          },
        });
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("close", (code) => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      if (code === 1008 || code === 4401) {
        // Policy violation or unauthorized — refresh token
        process.stderr.write(`[github-webhook-mcp] WebSocket: closed with code ${code}, refreshing token\n`);
        _cachedTokens = null;
      } else {
        process.stderr.write(`[github-webhook-mcp] WebSocket: closed (code ${code})\n`);
      }
      scheduleRetry();
    });

    ws.on("error", (err) => {
      process.stderr.write(`[github-webhook-mcp] WebSocket: error: ${err.message}\n`);
      // Will trigger close event, which handles reconnect
    });
  }

  function scheduleRetry() {
    const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, retryCount), MAX_RETRY_DELAY);
    retryCount++;
    process.stderr.write(`[github-webhook-mcp] WebSocket: retrying in ${Math.round(delay / 1000)}s (attempt ${retryCount})\n`);
    setTimeout(() => void connect(), delay);
  }

  await connect();
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

if (CHANNEL_ENABLED) {
  // Check if tokens already exist from a previous session.
  // If so, start WebSocket immediately. Otherwise, defer until after the first
  // successful tool call establishes OAuth.
  loadTokens().then((tokens) => {
    if (tokens && tokens.access_token) {
      _cachedTokens = tokens;
      markOAuthEstablished();
    }
    // If no tokens, WebSocket will start after the first successful tool call
  }).catch(() => {
    // Token load failed, WebSocket will start after first tool call
  });
}
