#!/usr/bin/env node
/**
 * Local stdio MCP bridge for github-webhook-mcp
 *
 * - Connects to Cloudflare Worker's /events WebSocket endpoint
 * - Forwards new events as Claude Code channel notifications
 * - Proxies MCP tool calls to the remote Worker (reuses a single session)
 * - Authenticates via OAuth 2.1 with PKCE (localhost callback)
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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKER_URL = process.env.WEBHOOK_WORKER_URL || "https://github-webhook.smgjp.com";
const CHANNEL_ENABLED = process.env.WEBHOOK_CHANNEL !== "0";

// ── OAuth Token Storage ──────────────────────────────────────────────────────

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // Unix timestamp in ms
}

const TOKEN_DIR = join(homedir(), ".github-webhook-mcp");
const TOKEN_FILE = join(TOKEN_DIR, "oauth-tokens.json");

async function loadTokens(): Promise<TokenData | null> {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: TokenData): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let _cachedTokens: TokenData | null = null;

// ── PKCE Utilities ───────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── OAuth Discovery & Registration ───────────────────────────────────────────

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
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
  redirect_uris: string[];
}

const CLIENT_REG_FILE = join(TOKEN_DIR, "oauth-client.json");

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

async function ensureClientRegistration(
  metadata: OAuthMetadata,
  redirectUris: string[],
): Promise<ClientRegistration> {
  const existing = await loadClientRegistration();
  if (existing) return existing;

  if (!metadata.registration_endpoint) {
    throw new Error("OAuth server does not support dynamic client registration");
  }

  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "github-webhook-mcp-cli",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client
    }),
  });

  if (!res.ok) {
    throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  }

  const reg = await res.json() as ClientRegistration;
  await saveClientRegistration(reg);
  return reg;
}

// ── OAuth Localhost Callback Flow ────────────────────────────────────────────

/**
 * Start a temporary localhost HTTP server to receive the OAuth callback.
 * Opens the browser for user authorization, waits for the callback,
 * exchanges the auth code for tokens, and returns them.
 */
async function performOAuthFlow(): Promise<TokenData> {
  const metadata = await discoverOAuthMetadata();

  // Find a free port for the callback server
  const callbackServer = createServer();
  await new Promise<void>((resolve) => {
    callbackServer.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (callbackServer.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Register client with both localhost variants
  const client = await ensureClientRegistration(metadata, [
    redirectUri,
    `http://localhost:${port}/callback`,
  ]);

  // Generate PKCE pair
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  // Build authorization URL
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Wait for the callback with the authorization code
  const authCode = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      callbackServer.close();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    callbackServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization failed</h1><p>You can close this tab.</p></body></html>");
        clearTimeout(timeout);
        callbackServer.close();
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Invalid callback</h1></body></html>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>");
      clearTimeout(timeout);
      callbackServer.close();
      resolve(code);
    });

    // Open the browser
    const openCmd = process.platform === "win32" ? "start" :
                    process.platform === "darwin" ? "open" : "xdg-open";
    import("node:child_process").then(({ exec }) => {
      exec(`${openCmd} "${authUrl.toString()}"`);
    });

    process.stderr.write(
      `\n[github-webhook-mcp] Opening browser for authentication...\n`,
    );
  });

  // Exchange auth code for tokens
  const tokenRes = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const tokens: TokenData = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : undefined,
  };

  await saveTokens(tokens);
  return tokens;
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

    // Try refresh
    if (_cachedTokens.refresh_token) {
      try {
        _cachedTokens = await refreshAccessToken(_cachedTokens.refresh_token);
        return _cachedTokens.access_token;
      } catch (err) {
        console.error("[oauth] refresh failed, falling back to full OAuth flow:", (err as Error).message || err);
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
