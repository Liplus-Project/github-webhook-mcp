#!/usr/bin/env node
/**
 * GitHub Webhook MCP — Cloudflare Worker bridge
 *
 * Thin stdio MCP server that proxies tool calls to a remote
 * Cloudflare Worker + Durable Object backend via Streamable HTTP.
 * Optionally listens via WebSocket for real-time channel notifications
 * (enables DO hibernation on the Worker side).
 *
 * v0.11.1: authenticates via a Worker-hosted web OAuth flow.
 *   1. Bridge generates a random `state` and opens
 *      `https://<worker>/oauth/authorize?client_id=<cid>&state=<state>` in
 *      the local browser. The Worker redirects to GitHub's standard web OAuth
 *      (familiar login + 2FA UX).
 *   2. Bridge polls `https://<worker>/oauth/token` with
 *      `grant_type=urn:ietf:params:oauth:grant-type:web_authorization_poll`
 *      against the same state.
 *   3. Refresh `invalid_grant` triggers a tokens-file re-read before fallback:
 *      a sibling Claude Code process may have refreshed already, so we adopt
 *      its rotation rather than starting a fresh web flow.
 *
 * Discord MCP pattern: data lives in the cloud, local MCP is a thin bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
 * Marker written on every tokens file produced by this client (v0.11.1+).
 * Legacy files from earlier flows lack it; loadTokens() ignores them so
 * startup doesn't adopt stale state and the next tool call re-authenticates.
 */
const TOKENS_FLOW_MARKER = "web";

async function loadTokens() {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(data);
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
let _webAuthLock = null;

/**
 * Tracks the in-flight web authorization so tool calls can return an
 * auth-required response immediately (instead of blocking for ~600s) while
 * polling continues in the background. Cleared on success or failure so the
 * next tool call after expiry starts a fresh authorize URL.
 */
let _pendingWebAuth = null;
let _pendingWebAuthError = null;

// ── OAuth Discovery & Registration ───────────────────────────────────────────

const WEB_AUTH_POLL_GRANT = "urn:ietf:params:oauth:grant-type:web_authorization_poll";

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

async function ensureClientRegistration(metadata) {
  const existing = await loadClientRegistration();
  // Accept any client registration that already lists our web-auth poll grant.
  // Legacy device-flow or authorization-code clients get re-registered so the
  // Worker recognizes us as a v0.11.1 web-flow client.
  if (existing && Array.isArray(existing.grant_types) &&
      existing.grant_types.includes(WEB_AUTH_POLL_GRANT)) {
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
      redirect_uris: [],
      grant_types: [WEB_AUTH_POLL_GRANT, "refresh_token"],
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

// ── OAuth Web Flow ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateState() {
  return randomBytes(32).toString("base64url");
}

/**
 * Best-effort platform-native browser launcher for the web-flow authorize URL.
 * Failures are non-fatal: we still surface the URL on stderr / in the tool
 * response so the user can open it manually.
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

/**
 * Poll the Worker's /oauth/token endpoint until the user approves, denies, or
 * the state expires. The Worker mirrors RFC 8628's polling error shape so we
 * can surface `authorization_pending` without exposing the poll to the user.
 */
async function pollForWebAuthToken(metadata, client, state, expiresInSec) {
  const endpoint = metadata.token_endpoint || `${WORKER_URL}/oauth/token`;
  const interval = 2; // Worker issues Bearer tokens quickly; 2s poll is plenty.
  const deadline = Date.now() + (expiresInSec || 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: WEB_AUTH_POLL_GRANT,
          state,
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
    if (err === "access_denied") {
      throw new Error("OAuth authorization denied by user");
    }
    if (err === "expired_token") {
      throw new Error(
        "OAuth state expired before approval. Re-run the client to retry.",
      );
    }

    // Unexpected error — surface and stop polling.
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}` +
      (body ? ` — ${JSON.stringify(body).slice(0, 200)}` : ""),
    );
  }

  throw new Error(
    "OAuth state expired before approval. Re-run the client to retry.",
  );
}

/**
 * Start a Worker-hosted web OAuth flow: mint a state, open the authorize URL
 * in the local browser, and kick off a background poll. Callers that await
 * the returned promise will block until the user approves. Callers that only
 * need the pending metadata (for a non-blocking tool response) can read
 * `_pendingWebAuth` as soon as phase 1 resolves; see
 * `getAccessTokenForToolCall()`.
 *
 * Serialization: _webAuthLock ensures that concurrent callers (WebSocket
 * bootstrap racing the first tool call) share a single authorize URL rather
 * than each launching their own browser window.
 */
async function performOAuthFlow() {
  if (_webAuthLock) {
    return await _webAuthLock;
  }

  // Phase 1: mint state + open the authorize URL. This is local-only (no HTTP
  // round-trip) so it returns almost immediately.
  const startPromise = (async () => {
    const metadata = await discoverOAuthMetadata();
    const client = await ensureClientRegistration(metadata);

    const state = generateState();
    const authorizeEndpoint = metadata.authorization_endpoint || `${WORKER_URL}/oauth/authorize`;
    const authorizeUrl =
      `${authorizeEndpoint}?client_id=${encodeURIComponent(client.client_id)}` +
      `&state=${encodeURIComponent(state)}`;

    // Client-side state validity window — keep aligned with Worker's WEB_AUTH_STATE_TTL.
    const expiresInSec = 600;
    const expiresAt = Date.now() + expiresInSec * 1000;

    const lines = [
      "",
      "[github-webhook-mcp] OAuth authorization required.",
      `[github-webhook-mcp] Opening: ${authorizeUrl}`,
      `[github-webhook-mcp] Approve in the browser window; the tab can be closed when done.`,
      `[github-webhook-mcp] Waiting for approval (state expires in ${expiresInSec}s)...`,
      "",
    ];
    process.stderr.write(lines.join("\n"));

    // Best-effort browser auto-open. Failures are logged to stderr but do
    // not abort the flow — the URL is still available in the tool response.
    openBrowser(authorizeUrl);

    _pendingWebAuth = {
      authorize_url: authorizeUrl,
      expires_at: expiresAt,
    };
    _pendingWebAuthError = null;

    return { metadata, client, state, expiresInSec };
  })();

  // Phase 2: poll in the background (still inside the same lock promise so
  // that simultaneous callers await one shared flow). Errors are recorded
  // and re-thrown so awaiting callers see them.
  _webAuthLock = (async () => {
    try {
      const { metadata, client, state, expiresInSec } = await startPromise;
      const tokenData = await pollForWebAuthToken(metadata, client, state, expiresInSec);

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
      _pendingWebAuth = null;
      _pendingWebAuthError = null;
      process.stderr.write("[github-webhook-mcp] OAuth authorization complete.\n");
      return tokens;
    } catch (err) {
      _pendingWebAuth = null;
      _pendingWebAuthError = err && err.message ? err.message : String(err);
      throw err;
    }
  })();

  const lockPromise = _webAuthLock;
  lockPromise.finally(() => {
    if (_webAuthLock === lockPromise) {
      _webAuthLock = null;
    }
  });

  // Wait for phase 1 so the caller sees _pendingWebAuth populated (or the
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
    err.status = res.status;
    err.bodyText = body;
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

/**
 * Detect the `invalid_grant` error shape on a refresh failure. When that hits,
 * a sibling Claude Code process may have refreshed first — re-read the tokens
 * file and see whether a newer rotation landed on disk.
 */
function isInvalidGrantError(err) {
  if (!err) return false;
  if (err.status !== 400) return false;
  const body = typeof err.bodyText === "string" ? err.bodyText : "";
  return body.includes("invalid_grant");
}

/**
 * RC1 fix: before giving up on a stale refresh_token, re-read the tokens file
 * to see whether a concurrent process already rotated it. If the on-disk
 * refresh_token differs from the one that just failed, adopt it and retry.
 */
async function tryRefreshViaDiskReread(previousRefreshToken) {
  const fresh = await loadTokens();
  if (!fresh || !fresh.refresh_token) return null;
  if (fresh.refresh_token === previousRefreshToken) return null;
  try {
    const tokens = await refreshAccessToken(fresh.refresh_token);
    return tokens;
  } catch (err) {
    console.error(
      "[oauth] disk-reread refresh also failed:",
      err && err.message ? err.message : err,
    );
    return null;
  }
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
      if (!_refreshLock) {
        _refreshLock = refreshAccessToken(_cachedTokens.refresh_token);
      }
      try {
        _cachedTokens = await _refreshLock;
        return _cachedTokens.access_token;
      } catch (err) {
        // RC1: maybe a sibling process already rotated. Re-read and retry once
        // before falling through to a full web-flow restart.
        if (isInvalidGrantError(err)) {
          const reread = await tryRefreshViaDiskReread(_cachedTokens.refresh_token);
          if (reread) {
            _cachedTokens = reread;
            return _cachedTokens.access_token;
          }
        }
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
 * Sentinel thrown by `getAccessTokenForToolCall()` when the web flow is still
 * pending approval. The tool handler catches this and returns a structured
 * auth-required response to the MCP client without blocking on the poll loop.
 */
class AuthRequiredError extends Error {
  constructor(pending, note) {
    super(note || "OAuth authorization required");
    this.name = "AuthRequiredError";
    this.pending = pending;
  }
}

/**
 * Like getAccessToken(), but never blocks on the web-flow poll. If no tokens
 * are available, it starts the flow (if not already running) and throws an
 * AuthRequiredError carrying the current authorize URL so the caller can
 * surface it in the tool response immediately.
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
      if (!_refreshLock) {
        _refreshLock = refreshAccessToken(_cachedTokens.refresh_token);
      }
      try {
        _cachedTokens = await _refreshLock;
        return _cachedTokens.access_token;
      } catch (err) {
        if (isInvalidGrantError(err)) {
          const reread = await tryRefreshViaDiskReread(_cachedTokens.refresh_token);
          if (reread) {
            _cachedTokens = reread;
            return _cachedTokens.access_token;
          }
        }
        console.error(
          "[oauth] refresh failed, starting web flow in background:",
          err.message || err,
        );
      } finally {
        _refreshLock = null;
      }
    }
  }

  // No usable tokens. Start the web flow if it isn't already running;
  // either way, hand the caller the current pending authorize URL.
  if (!_pendingWebAuth && !_webAuthLock) {
    performOAuthFlow().catch((err) => {
      console.error("[oauth] web flow background poll ended with error:", err.message || err);
    });

    if (_webAuthLock) {
      try {
        await Promise.race([
          new Promise((resolve) => setImmediate(resolve)),
          _webAuthLock.then(() => undefined, (err) => { throw err; }),
        ]);
      } catch (err) {
        throw err;
      }
    }
  }

  // Give phase 1 a little more time to finish. Phase 1 now includes a discovery
  // fetch + (possibly) a register fetch, so allow up to 15s before giving up.
  const phase1Deadline = Date.now() + 15_000;
  while (!_pendingWebAuth && !_pendingWebAuthError && Date.now() < phase1Deadline) {
    await sleep(100);
  }

  if (_pendingWebAuthError && !_pendingWebAuth) {
    throw new Error(`OAuth web flow failed: ${_pendingWebAuthError}`);
  }

  if (_pendingWebAuth) {
    throw new AuthRequiredError(_pendingWebAuth);
  }

  throw new Error("OAuth web flow did not produce an authorize URL in time.");
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
  parts.push("OAuth authorization required.");
  parts.push("");
  parts.push(`Open this URL in your browser: ${pending.authorize_url}`);
  parts.push("");
  if (pending.expires_at) {
    const remainingMs = pending.expires_at - Date.now();
    if (remainingMs > 0) {
      const mins = Math.max(1, Math.round(remainingMs / 60_000));
      parts.push(`This link is valid for about ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
  }
  parts.push(
    "A browser window should have opened automatically. " +
      "Sign in on GitHub, then retry the same tool call — subsequent calls will succeed once authorization completes.",
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
