#!/usr/bin/env node
/**
 * Local stdio MCP bridge for github-webhook-mcp
 *
 * - Connects to Cloudflare Worker's /events WebSocket endpoint
 * - Forwards new events as Claude Code channel notifications
 * - Proxies MCP tool calls to the remote Worker (reuses a single session)
 * - Authenticates via OAuth 2.1 Device Authorization Grant (RFC 8628).
 *   user_code + verification URI are surfaced on stderr because stdio MCP
 *   clients have no UI to drive an interactive browser flow.
 *
 * Discord MCP pattern: data lives in the cloud, local MCP is a thin bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKER_URL = process.env.WEBHOOK_WORKER_URL || "https://github-webhook.smgjp.com";
const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

// ── OAuth Token Storage ──────────────────────────────────────────────────────

interface TokenData {
  /** Flow marker for files produced by this client (v0.11.0+). */
  flow?: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // Unix timestamp in ms
}

const TOKEN_DIR = join(homedir(), ".github-webhook-mcp");
const TOKEN_FILE = join(TOKEN_DIR, "oauth-tokens.json");
const CLIENT_REG_FILE = join(TOKEN_DIR, "oauth-client.json");

/**
 * Marker written on every tokens file produced by this client (v0.11.0+).
 * Legacy files from the localhost-callback flow don't have it, which is how
 * we detect a first-run migration scenario and surface the one-time notice.
 */
const TOKENS_FLOW_MARKER = "device";

async function loadTokens(): Promise<TokenData | null> {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(data) as TokenData | null;
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

async function saveTokens(tokens: TokenData): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let _cachedTokens: TokenData | null = null;
let _refreshLock: Promise<TokenData> | null = null;
let _deviceFlowLock: Promise<TokenData> | null = null;
let _legacyMigrationNotified = false;

// ── OAuth Discovery & Registration ───────────────────────────────────────────

interface OAuthMetadata {
  authorization_endpoint?: string;
  token_endpoint: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
}

async function discoverOAuthMetadata(): Promise<OAuthMetadata> {
  const res = await fetch(`${WORKER_URL}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(`OAuth discovery failed: ${res.status}`);
  }
  return await res.json() as OAuthMetadata;
}

interface ClientRegistration {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
  grant_types?: string[];
}

async function loadClientRegistration(): Promise<ClientRegistration | null> {
  try {
    const data = await readFile(CLIENT_REG_FILE, "utf-8");
    return JSON.parse(data) as ClientRegistration;
  } catch {
    return null;
  }
}

async function saveClientRegistration(reg: ClientRegistration): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(CLIENT_REG_FILE, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function ensureClientRegistration(
  metadata: OAuthMetadata,
): Promise<ClientRegistration> {
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

  const reg = await res.json() as ClientRegistration;
  await saveClientRegistration(reg);
  return reg;
}

// ── OAuth Device Authorization Grant (RFC 8628) ─────────────────────────────

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenPollingResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Detect a pre-v0.11.0 tokens file and surface a one-time migration notice
 * on stderr. Legacy files were written by the localhost-callback flow and
 * carry tokens the new Worker will reject, so we discard them and let the
 * device flow re-establish authentication from scratch.
 */
async function checkLegacyTokensMigration(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(TOKEN_FILE, "utf-8");
  } catch {
    return; // No tokens file at all — not a migration case.
  }

  let parsed: TokenData | null;
  try {
    parsed = JSON.parse(raw) as TokenData;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestDeviceAuthorization(
  metadata: OAuthMetadata,
  client: ClientRegistration,
): Promise<DeviceAuthorizationResponse> {
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

  const data = await res.json() as DeviceAuthorizationResponse;
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
async function pollForDeviceToken(
  metadata: OAuthMetadata,
  client: ClientRegistration,
  deviceAuth: DeviceAuthorizationResponse,
): Promise<TokenPollingResponse> {
  const endpoint = metadata.token_endpoint || `${WORKER_URL}/oauth/token`;
  let interval = Math.max(1, Number(deviceAuth.interval) || 5);
  const deadline = Date.now() + (Number(deviceAuth.expires_in) || 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    let res: Response;
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
      console.error("[oauth] token poll network error:", (err as Error).message || err);
      continue;
    }

    if (res.ok) {
      return await res.json() as TokenPollingResponse;
    }

    let body: TokenPollingResponse | null = null;
    try {
      body = await res.json() as TokenPollingResponse;
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

async function performOAuthFlow(): Promise<TokenData> {
  // Serialize concurrent device-flow starts (e.g. WebSocket boot racing the
  // first tool call). Whichever caller wins runs the flow; others await.
  if (_deviceFlowLock) {
    return await _deviceFlowLock;
  }

  _deviceFlowLock = (async (): Promise<TokenData> => {
    await checkLegacyTokensMigration();

    const metadata = await discoverOAuthMetadata();
    const client = await ensureClientRegistration(metadata);

    const deviceAuth = await requestDeviceAuthorization(metadata, client);

    // stdio MCP clients have no UI surface, so we publish the user_code and
    // verification URI on stderr where Claude Code surfaces the log.
    const complete = deviceAuth.verification_uri_complete;
    const lines: string[] = [
      "",
      "[github-webhook-mcp] OAuth device authorization required.",
      `[github-webhook-mcp] Visit: ${deviceAuth.verification_uri}`,
      `[github-webhook-mcp] Enter code: ${deviceAuth.user_code}`,
    ];
    if (complete && complete !== deviceAuth.verification_uri) {
      lines.push(`[github-webhook-mcp] Or open directly: ${complete}`);
    }
    lines.push(
      `[github-webhook-mcp] Waiting for approval (expires in ${deviceAuth.expires_in ?? "?"}s)...`,
      "",
    );
    process.stderr.write(lines.join("\n"));

    const tokenData = await pollForDeviceToken(metadata, client, deviceAuth);

    if (!tokenData.access_token) {
      throw new Error(
        `Token response missing access_token: ${JSON.stringify(tokenData).slice(0, 200)}`,
      );
    }

    const tokens: TokenData = {
      flow: TOKENS_FLOW_MARKER,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_in
        ? Date.now() + tokenData.expires_in * 1000
        : undefined,
    };

    await saveTokens(tokens);
    process.stderr.write("[github-webhook-mcp] OAuth device authorization complete.\n");
    return tokens;
  })();

  try {
    return await _deviceFlowLock;
  } finally {
    _deviceFlowLock = null;
  }
}

/**
 * Refresh the access token using the refresh token.
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
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

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    const err = new Error(
      `Token refresh returned no access_token: ${JSON.stringify(data).slice(0, 200)}`,
    );
    console.error("[oauth] refresh malformed:", err.message);
    throw err;
  }

  const tokens: TokenData = {
    flow: TOKENS_FLOW_MARKER,
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };

  await saveTokens(tokens);
  console.error("[oauth] token refreshed successfully, expires in %ds", data.expires_in ?? "unknown");
  return tokens;
}

/**
 * Get a valid access token, refreshing or re-authenticating as needed.
 */
async function getAccessToken(): Promise<string> {
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
        console.error("[oauth] refresh failed, falling back to full OAuth flow:", (err as Error).message || err);
      } finally {
        _refreshLock = null;
      }
    } else {
      console.error("[oauth] no refresh_token available, requiring full OAuth flow");
    }
  }

  // No valid tokens, perform full OAuth flow
  _cachedTokens = await performOAuthFlow();
  return _cachedTokens.access_token;
}

/** Build common headers with OAuth Bearer auth */
async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const h: Record<string, string> = { ...extra };
  const token = await getAccessToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// ── Remote MCP Session (lazy, reused) ────────────────────────────────────────

let _sessionId: string | null = null;

async function getSessionId(): Promise<string> {
  if (_sessionId) return _sessionId;

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await authHeaders({
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
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

async function callRemoteTool(name: string, args: Record<string, unknown>, _retried = false): Promise<{ content: Array<{ type: string; text: string }> }> {
  const sessionId = await getSessionId();

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await authHeaders({
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: crypto.randomUUID(),
    }),
  });

  // 401 = token expired or revoked, re-authenticate and retry once
  if (res.status === 401) {
    if (_retried) {
      return { content: [{ type: "text", text: "Authentication failed after retry. Please re-authenticate." }] };
    }
    _cachedTokens = null;
    _sessionId = null;
    return callRemoteTool(name, args, true);
  }

  const text = await res.text();

  // Streamable HTTP may return SSE format
  const dataLine = text.split("\n").find(l => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

  if (json.error) {
    // Session expired — retry once with a fresh session
    if ((json.error.code === -32600 || json.error.code === -32001) && !_retried) {
      _sessionId = null;
      return callRemoteTool(name, args, true);
    }
    return { content: [{ type: "text", text: JSON.stringify(json.error) }] };
  }

  return json.result;
}

// ── MCP Server Setup ─────────────────────────────────────────────────────────

const capabilities: Record<string, unknown> = { tools: {} };
if (CHANNEL_ENABLED) {
  capabilities.experimental = { "claude/channel": {} };
}

const mcp = new Server(
  { name: "github-webhook-mcp", version: "1.0.0" },
  {
    capabilities,
    instructions: CHANNEL_ENABLED
      ? "GitHub webhook events arrive as <channel source=\"github-webhook-mcp\" ...>. They are one-way: read them and act, no reply expected."
      : undefined,
  },
);

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_pending_status",
    description: "Get a lightweight snapshot of pending GitHub webhook events",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_pending_events",
    description: "List lightweight summaries for pending GitHub webhook events",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max events to return (1-100, default 20)" },
      },
    },
  },
  {
    name: "get_event",
    description: "Get the full payload for a single webhook event by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: { type: "string", description: "The event ID to retrieve" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "get_webhook_events",
    description:
      "Get pending (unprocessed) GitHub webhook events with full payloads. Prefer get_pending_status or list_pending_events for polling.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max events to return (1-100, default 20)",
        },
      },
    },
  },
  {
    name: "mark_processed",
    description: "Mark a webhook event as processed",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: { type: "string", description: "The event ID to mark" },
      },
      required: ["event_id"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await callRemoteTool(name, args ?? {});
    // First successful tool call confirms OAuth is working
    markOAuthEstablished();
    return result;
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to reach worker: ${err}` }],
      isError: true,
    };
  }
});

// ── WebSocket Listener → Channel Notifications ──────────────────────────────

/** Track whether OAuth has been established (first successful tool call). */
let _oauthEstablished = false;
let _wsConnected = false;

function markOAuthEstablished(): void {
  if (!_oauthEstablished) {
    _oauthEstablished = true;
    if (CHANNEL_ENABLED && !_wsConnected) {
      process.stderr.write("[github-webhook-mcp] OAuth established, starting WebSocket connection\n");
      connectWebSocket();
    }
  }
}

async function connectWebSocket() {
  const wsUrl = WORKER_URL.replace(/^http/, "ws") + "/events";
  let ws: WebSocket;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  _wsConnected = true;
  let retryCount = 0;
  const MAX_RETRY_DELAY = 60_000; // 60 seconds
  const BASE_RETRY_DELAY = 1_000; // 1 second

  async function connect() {
    let token: string;
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

    const wsOptions = { headers: { "Authorization": `Bearer ${token}` } };
    ws = new WebSocket(wsUrl, wsOptions);

    ws.on("open", () => {
      retryCount = 0; // Reset backoff on successful connection
      process.stderr.write("[github-webhook-mcp] WebSocket: connected\n");
      // Send periodic pings to keep connection alive
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, 25000);
    });

    ws.on("message", (raw: Buffer | string) => {
      try {
        const data = JSON.parse(raw.toString());

        // Skip status, pong, heartbeat messages
        if ("status" in data || "pong" in data || "heartbeat" in data) return;
        if (!data.summary) return;

        const s = data.summary;
        const parts = [s.type];
        if (s.action) parts.push(s.action);
        if (s.repo) parts.push(`in ${s.repo}`);
        if (s.title) parts.push(`"${s.title}"`);
        if (s.sender) parts.push(`by ${s.sender}`);

        void mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: parts.join(" "),
            meta: {
              chat_id: "github",
              message_id: s.id,
              user: s.sender ?? "github",
              ts: s.received_at,
              event_id: s.id,
              type: s.type,
              ...(s.repo ? { repo: s.repo } : {}),
              ...(s.action ? { action: s.action } : {}),
            },
          },
        });
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("close", (code: number) => {
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

    ws.on("error", (err: Error) => {
      process.stderr.write(`[github-webhook-mcp] WebSocket: error: ${err.message}\n`);
      // Will trigger close event, which handles reconnect
    });
  }

  function scheduleRetry(): void {
    const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, retryCount), MAX_RETRY_DELAY);
    retryCount++;
    process.stderr.write(`[github-webhook-mcp] WebSocket: retrying in ${Math.round(delay / 1000)}s (attempt ${retryCount})\n`);
    setTimeout(() => void connect(), delay);
  }

  await connect();
}

// ── Main ─────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());

if (CHANNEL_ENABLED) {
  // Check if tokens already exist from a previous session.
  // If so, start WebSocket immediately. Otherwise, defer until after the first
  // successful tool call establishes OAuth.
  loadTokens().then((tokens) => {
    if (tokens && tokens.access_token) {
      _cachedTokens = tokens;
      markOAuthEstablished();
    }
    // If no tokens, WebSocket will start after first tool call
  }).catch(() => {
    // Token load failed, WebSocket will start after first tool call
  });
}
