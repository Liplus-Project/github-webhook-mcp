# github-webhook-mcp

Stdio MCP proxy that bridges local MCP clients (Claude Desktop, Claude Code, Codex, etc.) to a remote [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) Cloudflare Worker. The Worker receives GitHub webhook deliveries, persists them in a per-tenant Durable Object (SQLite), and exposes them through MCP tools and a real-time WebSocket stream.

This package is the **client-side proxy only**. Webhook ingestion, tenant routing, persistence, and the MCP server itself run on the Worker. See the [main repository](https://github.com/Liplus-Project/github-webhook-mcp) for architecture and self-hosting instructions.

## What this proxy does

- Speaks stdio MCP locally to your client.
- Forwards `tools/call` to the Worker's Streamable HTTP MCP endpoint (`/mcp`).
- Optionally maintains a WebSocket connection to the Worker's `/events` endpoint and re-emits incoming webhook events as Claude Code `claude/channel` notifications (real-time push, no polling).
- Handles OAuth 2.1 **Device Authorization Grant (RFC 8628)** against the Worker and Dynamic Client Registration (RFC 7591). No localhost callback port is used, so the flow works reliably across process restarts and concurrent client instances.
- Caches access and refresh tokens under `~/.github-webhook-mcp/` (mode `0600`) and refreshes them silently before expiry.

## Requirements

- Node.js >= 18
- A reachable github-webhook-mcp Worker (the public preview default is `https://github-webhook.smgjp.com`; you can also point at your own deployment)
- A web browser (used once to approve the device code at `https://github.com/login/device` — can be on a different machine from where the MCP client runs)
- A GitHub App installed on the accounts/organizations whose events you want to receive (the Worker resolves your accessible installations automatically after OAuth)

## Install / Run

The proxy is published to npm and exposes a `github-webhook-mcp` binary.

Run directly with `npx` (no global install required):

```bash
npx github-webhook-mcp
```

Or install globally:

```bash
npm install -g github-webhook-mcp
github-webhook-mcp
```

On first run the proxy prints a GitHub device code and verification URL to stderr:

```
[github-webhook-mcp] OAuth device authorization required.
[github-webhook-mcp] Visit: https://github.com/login/device
[github-webhook-mcp] Enter code: WDJB-MJHT
[github-webhook-mcp] Or open directly: https://github.com/login/device?user_code=WDJB-MJHT
[github-webhook-mcp] Waiting for approval (expires in 600s)...
```

Open the verification URL in any browser, enter the 8-character code, and authorize the GitHub App. Tokens are stored under `~/.github-webhook-mcp/` and refreshed automatically before expiry.

> **Migrating from v0.10.x or earlier.** The previous versions used a browser-based localhost callback flow. On first run with v0.11.0+, the proxy detects the legacy tokens file, removes it, prints a migration notice to stderr, and starts the device flow. One-time re-authentication is required.

> **Enable Device Flow on self-hosted GitHub Apps.** If you self-host the Worker with your own GitHub App, toggle **"Enable Device Flow"** in the App settings (under *Identifying and authorizing users*). Without it the Worker returns `503 device_flow_disabled`. See the [self-hosting guide](https://github.com/Liplus-Project/github-webhook-mcp/blob/main/docs/installation.md#4-github-app-の作成と設定) for step-by-step instructions.

## Client configuration

### Claude Desktop / Claude Code

Add the server to your MCP client configuration. Example for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github-webhook": {
      "command": "npx",
      "args": ["-y", "github-webhook-mcp"]
    }
  }
}
```

To target a self-hosted Worker, set the `WEBHOOK_WORKER_URL` environment variable:

```json
{
  "mcpServers": {
    "github-webhook": {
      "command": "npx",
      "args": ["-y", "github-webhook-mcp"],
      "env": {
        "WEBHOOK_WORKER_URL": "https://your-worker.example.workers.dev"
      }
    }
  }
}
```

### Codex (`config.toml`)

```toml
[mcp.github-webhook-mcp]
command = "npx"
args = ["-y", "github-webhook-mcp"]

[mcp.github-webhook-mcp.env]
WEBHOOK_WORKER_URL = "https://your-worker.example.workers.dev"
WEBHOOK_CHANNEL = "0"
```

`WEBHOOK_CHANNEL=0` disables the WebSocket real-time channel. Set it to `0` for clients that do not support `claude/channel` notifications (Claude Desktop, Codex). Leave it at the default to enable real-time push for Claude Code.

### Real-time channel notifications (Claude Code only)

When `WEBHOOK_CHANNEL` is enabled (the default), the proxy declares the `claude/channel` experimental capability and re-emits new webhook events as channel notifications. To make them visible in a Claude Code session, load the channel:

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```

Notifications are one-way: they include event type, repo, action, title, sender, and URL. There is no reply tool.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEBHOOK_WORKER_URL` | No | `https://github-webhook.smgjp.com` | Base URL of the Cloudflare Worker that exposes the MCP endpoint, the WebSocket stream, and OAuth metadata. |
| `WEBHOOK_CHANNEL` | No | `1` (enabled) | Set to `0` to disable the WebSocket connection and `claude/channel` notifications. |

OAuth client registration and tokens are stored in:

- `~/.github-webhook-mcp/oauth-client.json` (dynamic client registration)
- `~/.github-webhook-mcp/oauth-tokens.json` (access + refresh tokens)

Delete these files to force a fresh authorization flow.

> **Note on the default Worker URL.** `https://github-webhook.smgjp.com` is a preview instance offered for evaluation. It has no SLA and may change or stop without notice. For production use, deploy your own Worker (see the main repository's [installation guide](https://github.com/Liplus-Project/github-webhook-mcp/blob/main/docs/installation.md)) and set `WEBHOOK_WORKER_URL` accordingly.

## Tools exposed

All tools are read-only except `mark_processed`.

| Tool | Description |
|---|---|
| `get_pending_status` | Lightweight snapshot of pending (unprocessed) webhook events: pending count, latest received timestamp, and event types. Use this for periodic polling before requesting details. |
| `list_pending_events` | Summary list of pending events (`limit`: 1-100, default 20). Returns metadata only — `id`, `type`, `action`, `repo`, `sender`, `number`, `title`, `url`, `received_at` — without the full payload. |
| `get_event` | Full payload for a single webhook event by `event_id`. |
| `get_webhook_events` | Pending events with full payloads. Prefer `get_pending_status` or `list_pending_events` for polling and only fall back to this when you really need everything. |
| `mark_processed` | Mark an event as processed by `event_id` so it will no longer appear in pending queries. Required to keep the pending queue from growing unbounded. |

### Recommended polling flow

1. Poll `get_pending_status()` periodically (e.g. every 60 seconds).
2. If `pending_count > 0`, call `list_pending_events()` for summaries.
3. Call `get_event(event_id)` only for events that need the full payload.
4. Call `mark_processed(event_id)` after handling each event.

If real-time channel notifications are enabled (Claude Code), step 1 can be skipped — the proxy will push event summaries as soon as the Worker receives them. You still need to call `mark_processed` to clear the queue.

## Authentication flow

1. On first tool call (or on startup if cached tokens exist), the proxy discovers OAuth metadata at `${WEBHOOK_WORKER_URL}/.well-known/oauth-authorization-server`.
2. It performs Dynamic Client Registration (RFC 7591) if no client is cached, declaring support for the `urn:ietf:params:oauth:grant-type:device_code` and `refresh_token` grant types (public client, no secret).
3. It requests a device code from the Worker's `/oauth/device_authorization` endpoint. The Worker proxies that request to GitHub's `POST https://github.com/login/device/code` and returns an RFC 8628 §3.2 response.
4. The proxy prints the `user_code` and `verification_uri` to stderr. You open the URL in any browser and enter the code.
5. The proxy polls `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` at the interval the server specifies. `authorization_pending` and `slow_down` responses are handled per RFC 8628 §3.5.
6. When you approve, the Worker exchanges the GitHub device code for a GitHub access token, fetches your GitHub profile + installations, and issues its own opaque access/refresh token pair bound to that grant.
7. The Worker resolves your accessible GitHub installations (your user account plus any organizations where the GitHub App is installed) and binds them to the OAuth session, so events from any of those tenants surface through the same MCP session.
8. Subsequent calls reuse the access token and silently refresh it five minutes before expiry. On `401` from the Worker, the proxy invalidates its cached tokens and re-authenticates automatically (falling back to the device flow if the refresh token is also rejected).

No localhost port is listened on at any point. The flow works the same way on headless hosts and across concurrent MCP client instances.

## Troubleshooting

- **Device code never appears in the log.** Check the stderr stream of the MCP process (Claude Code surfaces it as the server's log). Look for the `[github-webhook-mcp] OAuth device authorization required.` block.
- **`OAuth device code expired before approval. Re-run the client to retry.`** The code expires after ~10 minutes. Trigger any tool call again to restart the flow.
- **`/oauth/device_authorization` returns 503.** The upstream GitHub App does not have **Enable Device Flow** turned on. Self-hosters must enable it in the GitHub App settings.
- **`Failed to reach worker`.** Check that `WEBHOOK_WORKER_URL` is correct and reachable from your machine.
- **`Authentication failed after retry`.** Cached tokens were rejected and re-authentication did not succeed. Remove `~/.github-webhook-mcp/oauth-tokens.json` and retry.
- **Legacy tokens migration.** If you see `Detected legacy OAuth tokens from pre-v0.11.0`, this is normal on the first run after upgrading. The old file has been removed and a device-code prompt follows. Complete it once.
- **No events arriving.** Confirm that the GitHub App is installed on the target account/organization and that webhook deliveries are succeeding on the GitHub App's *Advanced* → *Recent Deliveries* page. The Worker only sees events for installations linked to your authenticated account.
- **`429` from the Worker.** The per-tenant event quota (default 10,000) has been exceeded. Process the backlog with `mark_processed` to free space.
- **Real-time notifications not showing in Claude Code.** Make sure `WEBHOOK_CHANNEL` is not set to `0` and that Claude Code was launched with `--dangerously-load-development-channels server:github-webhook-mcp`.
- **Stale credentials.** Remove `~/.github-webhook-mcp/oauth-tokens.json` (and optionally `oauth-client.json`) and retry.

## Links

- Source and architecture: <https://github.com/Liplus-Project/github-webhook-mcp>
- Self-hosting the Worker: [docs/installation.md](https://github.com/Liplus-Project/github-webhook-mcp/blob/main/docs/installation.md)
- Requirements spec: [docs/0-requirements.md](https://github.com/Liplus-Project/github-webhook-mcp/blob/main/docs/0-requirements.md)
- Issue tracker: <https://github.com/Liplus-Project/github-webhook-mcp/issues>

## License

Apache-2.0. See the [LICENSE](https://github.com/Liplus-Project/github-webhook-mcp/blob/main/LICENSE) and [NOTICE](https://github.com/Liplus-Project/github-webhook-mcp/blob/main/NOTICE) files in the main repository.
