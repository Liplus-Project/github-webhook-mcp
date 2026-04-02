#!/usr/bin/env node
/**
 * GitHub Webhook MCP — Cloudflare Worker bridge
 *
 * Thin stdio MCP server that proxies tool calls to a remote
 * Cloudflare Worker + Durable Object backend via Streamable HTTP.
 * Optionally listens to SSE for real-time channel notifications.
 * Authenticates via OAuth 2.1 with PKCE (localhost callback).
 *
 * Discord MCP pattern: data lives in the cloud, local MCP is a thin bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { createRequire } from "node:module";

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

async function loadTokens() {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let _cachedTokens = null;

// ── PKCE Utilities ───────────────────────────────────────────────────────────

function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

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

async function ensureClientRegistration(metadata, redirectUris) {
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

// ── OAuth Localhost Callback Flow ────────────────────────────────────────────

// Pending OAuth state: kept alive across tool calls so the callback server
// can receive the authorization code even if the first tool call returns early.
let _pendingOAuth = null;

class OAuthPendingError extends Error {
  constructor(authUrl) {
    super("OAuth authentication required");
    this.authUrl = authUrl;
  }
}

function openBrowser(url) {
  if (process.platform === "win32") {
    // Windows `start` treats the first quoted arg as a window title.
    // Pass an empty title so the URL is opened correctly.
    exec(`start "" "${url}"`);
  } else {
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${openCmd} "${url}"`);
  }
}

async function startOAuthFlow() {
  const metadata = await discoverOAuthMetadata();

  const callbackServer = createServer();
  await new Promise((resolve) => {
    callbackServer.listen(0, "127.0.0.1", () => resolve());
  });
  const port = callbackServer.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const client = await ensureClientRegistration(metadata, [
    redirectUri,
    `http://localhost:${port}/callback`,
  ]);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Promise that resolves when the callback is received
  const tokenPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      callbackServer.close();
      _pendingOAuth = null;
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    callbackServer.on("request", async (req, res) => {
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
        _pendingOAuth = null;
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

      try {
        const tokenRes = await fetch(metadata.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: client.client_id,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          _pendingOAuth = null;
          reject(new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`));
          return;
        }

        const tokenData = await tokenRes.json();
        const tokens = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: tokenData.expires_in
            ? Date.now() + tokenData.expires_in * 1000
            : undefined,
        };

        await saveTokens(tokens);
        _pendingOAuth = null;
        resolve(tokens);
      } catch (err) {
        _pendingOAuth = null;
        reject(err);
      }
    });
  });

  // Try to open the browser
  openBrowser(authUrl.toString());
  process.stderr.write(
    `\n[github-webhook-mcp] Opening browser for authentication...\n`,
  );

  // Store pending state so subsequent tool calls can await or re-surface the URL
  _pendingOAuth = { authUrl: authUrl.toString(), tokenPromise };

  return _pendingOAuth;
}

async function performOAuthFlow() {
  // If an OAuth flow is already in progress, check if it completed
  if (_pendingOAuth) {
    // Race: either the token is ready or we return the URL again
    const result = await Promise.race([
      _pendingOAuth.tokenPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (result && result.access_token) return result;
    throw new OAuthPendingError(_pendingOAuth.authUrl);
  }

  // Start a new OAuth flow
  const pending = await startOAuthFlow();

  // Wait briefly for the browser-opened flow to complete (e.g. auto-open worked)
  const result = await Promise.race([
    pending.tokenPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (result && result.access_token) return result;

  // Browser likely didn't open or user hasn't authenticated yet — surface the URL
  throw new OAuthPendingError(pending.authUrl);
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
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = await res.json();

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };

  await saveTokens(tokens);
  return tokens;
}

async function getAccessToken() {
  if (!_cachedTokens) {
    _cachedTokens = await loadTokens();
  }

  if (_cachedTokens) {
    if (!_cachedTokens.expires_at || _cachedTokens.expires_at > Date.now() + 60_000) {
      return _cachedTokens.access_token;
    }

    if (_cachedTokens.refresh_token) {
      try {
        _cachedTokens = await refreshAccessToken(_cachedTokens.refresh_token);
        return _cachedTokens.access_token;
      } catch {
        // Refresh failed, fall through to full OAuth flow
      }
    }
  }

  _cachedTokens = await performOAuthFlow();
  return _cachedTokens.access_token;
}

/** Build common headers with OAuth Bearer auth */
async function authHeaders(extra) {
  const h = { ...extra };
  const token = await getAccessToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// ── Remote MCP Session (lazy, reused) ────────────────────────────────────────

let _sessionId = null;

async function getSessionId() {
  if (_sessionId) return _sessionId;

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await authHeaders({
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

async function callRemoteTool(name, args) {
  const sessionId = await getSessionId();

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await authHeaders({
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

  // 401 = token expired or revoked, re-authenticate and retry
  if (res.status === 401) {
    _cachedTokens = null;
    _sessionId = null;
    return callRemoteTool(name, args);
  }

  const text = await res.text();

  // Streamable HTTP may return SSE format
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

  if (json.error) {
    // Session expired — retry once with a fresh session
    if (json.error.code === -32600 || json.error.code === -32001) {
      _sessionId = null;
      return callRemoteTool(name, args);
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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callRemoteTool(name, args ?? {});
    // First successful tool call confirms OAuth is working
    markOAuthEstablished();
    return result;
  } catch (err) {
    if (err instanceof OAuthPendingError) {
      return {
        content: [
          {
            type: "text",
            text: `Authentication required. A browser window should have opened for authorization. After authorizing in the browser, retry the tool call.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Failed to reach worker: ${err}` }],
      isError: true,
    };
  }
});

// ── SSE Listener → Channel Notifications ─────────────────────────────────────

/** Track whether OAuth has been established (first successful tool call). */
let _oauthEstablished = false;

function markOAuthEstablished() {
  if (!_oauthEstablished) {
    _oauthEstablished = true;
    if (CHANNEL_ENABLED && !_sseConnected) {
      process.stderr.write("[github-webhook-mcp] OAuth established, starting SSE connection\n");
      connectSSE();
    }
  }
}

let _sseConnected = false;

async function connectSSE() {
  let EventSourceImpl;
  try {
    EventSourceImpl = (await import("eventsource")).default;
  } catch {
    // eventsource not installed — skip SSE
    return;
  }

  _sseConnected = true;
  let retryCount = 0;
  const MAX_RETRY_DELAY = 60_000; // 60 seconds
  const BASE_RETRY_DELAY = 1_000; // 1 second

  async function attemptConnection() {
    let token;
    try {
      token = await getAccessToken();
    } catch (err) {
      process.stderr.write(`[github-webhook-mcp] SSE: failed to get access token: ${err}\n`);
      scheduleRetry();
      return;
    }

    if (!token) {
      process.stderr.write("[github-webhook-mcp] SSE: no access token available, will retry\n");
      scheduleRetry();
      return;
    }

    const sseUrl = `${WORKER_URL}/events`;
    const es = new EventSourceImpl(sseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    es.onopen = () => {
      retryCount = 0; // Reset backoff on successful connection
      process.stderr.write("[github-webhook-mcp] SSE: connected\n");
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if ("heartbeat" in data || "status" in data) return;
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
    };

    es.onerror = (err) => {
      const status = err && err.status;
      if (status === 401) {
        process.stderr.write("[github-webhook-mcp] SSE: 401 unauthorized, closing and retrying with fresh token\n");
        _cachedTokens = null; // Force token refresh on next attempt
      } else {
        process.stderr.write(`[github-webhook-mcp] SSE: connection error${status ? ` (status ${status})` : ""}\n`);
      }
      es.close();
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, retryCount), MAX_RETRY_DELAY);
    retryCount++;
    process.stderr.write(`[github-webhook-mcp] SSE: retrying in ${Math.round(delay / 1000)}s (attempt ${retryCount})\n`);
    setTimeout(() => attemptConnection(), delay);
  }

  attemptConnection();
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

if (CHANNEL_ENABLED) {
  // Check if tokens already exist from a previous session.
  // If so, start SSE immediately. Otherwise, defer until after the first
  // successful tool call establishes OAuth.
  loadTokens().then((tokens) => {
    if (tokens && tokens.access_token) {
      _cachedTokens = tokens;
      markOAuthEstablished();
    }
    // If no tokens, SSE will start after the first successful tool call
  }).catch(() => {
    // Token load failed, SSE will start after first tool call
  });
}
