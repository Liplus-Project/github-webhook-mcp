# github-webhook-mcp Installation Guide

Language: English | [Japanese](installation.ja.md)

## Quick Start

You can try it right away with the preview instance:

1. Install the [GitHub Webhook MCP](https://github.com/apps/liplus-webhook-mcp) app on your GitHub account or organization
2. Configure your MCP client (see [MCP Client Setup](#mcp-client-setup) below):
   - Worker URL: `https://github-webhook.smgjp.com`
3. Start receiving webhook notifications

> **Note:** The preview instance at `github-webhook.smgjp.com` is provided for evaluation. It has no SLA and may change or stop without notice. For production use, see the [Self-Hosting Guide](#self-hosting-guide).

## MCP Client Setup

> **Prerequisite:** Node.js 18+ is required (used to run the local MCP bridge).

### First-time authentication (web OAuth)

Since v0.11.1, MCP clients authenticate through a **Worker-hosted web OAuth flow**. The standard GitHub login + 2FA (the familiar UX, e.g. Google Authenticator) works as is. On the first tool call, two things happen at once:

1. **A browser opens automatically** (`https://<worker>/oauth/authorize?client_id=...&state=...` → 302 redirect to the GitHub login page)
2. **The authorize URL is returned immediately as the tool call response** (it does not wait for polling to finish, so you can retry right away)

In the Claude Code / Claude Desktop chat, you will see a response roughly like this:

```
OAuth authorization required.

Open this URL in your browser: https://github-webhook.smgjp.com/oauth/authorize?client_id=abc&state=xyz

This link is valid for about 10 minutes.
A browser window should have opened automatically. Sign in on GitHub, then retry the same tool call — subsequent calls will succeed once authorization completes.
```

After you sign in to GitHub in the browser and approve, the Worker receives `/oauth/callback` and returns an "Authorization complete" page (you can close the tab). The local bridge's background polling receives the token and saves it to `~/.github-webhook-mcp/oauth-tokens.json`. Calling the same tool again then returns results normally. Later launches reuse the saved token, which is refreshed automatically before it expires.

In parallel, the same information is written to the stderr log (a fallback if you want to look at the logs):

```
[github-webhook-mcp] OAuth authorization required.
[github-webhook-mcp] Opening: https://github-webhook.smgjp.com/oauth/authorize?client_id=abc&state=xyz
[github-webhook-mcp] Approve in the browser window; the tab can be closed when done.
[github-webhook-mcp] Waiting for approval (state expires in 600s)...
```

> **If the browser does not open automatically:** The URL remains in the response and in the stderr log, so copy it and paste it into your browser manually. The bridge uses `start` on Windows, `open` on macOS and `xdg-open` on Linux.

> **v0.11.2 Windows hotfix:** On Windows, v0.11.1 passed the authorize URL to cmd.exe unquoted when auto-opening the browser, so the `&` in the URL was interpreted as a command separator, the `state` parameter was dropped, and `/oauth/authorize` returned 400. v0.11.2 wraps the URL in `"..."` and launches it through the shell, so `&` is treated literally and `state` reaches the browser correctly. Windows users whose auto-open did not work on v0.11.1 should update to v0.11.2 (manual URL copy keeps working as a fallback).

> **Migrating from older versions:** A `~/.github-webhook-mcp/oauth-tokens.json` from v0.11.0 or earlier (either the localhost callback flow or the device flow) has a non-matching flow marker, so it is ignored automatically and the new web OAuth flow re-authenticates on the first tool call. No manual steps are needed.

### Claude Desktop — Desktop Extension (.mcpb)

Download `github-webhook-mcp.mcpb` from [Releases](https://github.com/Liplus-Project/github-webhook-mcp/releases):

1. Claude Desktop → **Settings** → **Extensions** → **Install Extension...**
2. Select the `.mcpb` file
3. Enter the Worker URL (e.g. `https://github-webhook-mcp.example.workers.dev`)

### Claude Code CLI — npx

```json
{
  "mcpServers": {
    "github-webhook-mcp": {
      "command": "npx",
      "args": ["github-webhook-mcp"],
      "alwaysLoad": true,
      "env": {
        "WEBHOOK_WORKER_URL": "https://github-webhook-mcp.example.workers.dev",
        "WEBHOOK_CHANNEL": "1"
      }
    }
  }
}
```

`WEBHOOK_CHANNEL=1` enables real-time channel notifications (Claude Code CLI only).

`alwaysLoad: true` requires Claude Code v2.1.121 or later. It exempts this server's tools from tool-search deferral so they remain immediately callable every turn (recommended because the server is invoked every turn via the UserPromptSubmit hook).

### Codex — config.toml

```toml
[mcp.github-webhook-mcp]
command = "npx"
args = ["github-webhook-mcp"]

[mcp.github-webhook-mcp.env]
WEBHOOK_WORKER_URL = "https://github-webhook-mcp.example.workers.dev"
WEBHOOK_CHANNEL = "0"
```

## Self-Hosting Guide

Deploy your own Cloudflare Worker instance to keep full control over webhook processing and data.

### Prerequisites

| Requirement | Purpose |
|------|------|
| **Cloudflare account** | Hosting the Worker, Durable Objects and KV |
| **GitHub account** | Forking the repository and creating the GitHub App |

### 1. Fork the repository

Fork the [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) repository to your GitHub account.

### 2. Create a project in Cloudflare Workers & Pages

Create a Worker from the Cloudflare dashboard and connect it to your GitHub repository:

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com/)
2. Select **Workers & Pages** → **Create** → **Import a repository**
3. Connect your GitHub account and select your fork
4. Configure the build settings:

| Field | Value |
|------|-----|
| **Worker name** | `github-webhook-mcp` (must match `name` in `wrangler.toml`) |
| **Root directory** | `worker` (this is a monorepo; point at the directory holding the Worker source) |
| **Build command** | `npm install && npx wrangler deploy` |

5. Select **Save and Deploy**

> **Important:** The Worker name must match the `name` field in `wrangler.toml`. The build fails if they differ.

When the deploy succeeds, the Worker URL is shown (e.g. `https://github-webhook-mcp.example.workers.dev`). Use this URL in the following steps.

Once connected, pushes to the repository deploy automatically.

The deploy creates the following automatically:
- **WebhookStore** Durable Object — event persistence (per tenant)
- **TenantRegistry** Durable Object — tenant management (single instance)
- SQLite migrations are applied automatically

MCP tools are served per request, not from a Durable Object (the stateless core of protocol version 2026-07-28). The `WebhookMcpAgent` class remains only because of past migration constraints and receives no traffic.

### 3. Create the KV namespace

Create the KV namespace used to store OAuth tokens.
You can create it from the Cloudflare dashboard or with the wrangler CLI.

**Dashboard:**

1. **Workers & Pages** → **KV** → **Create a namespace**
2. Enter `OAUTH_KV` as the namespace name and create it
3. Note the namespace ID shown after creation

**wrangler CLI:**

```bash
cd worker
npx wrangler kv namespace create OAUTH_KV
```

Either way, set the resulting KV namespace ID in place of `PLACEHOLDER_KV_ID` in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<paste the KV namespace ID here>"
```

Commit and push the change; the automatic deploy picks up the KV binding.

### 4. Create and configure the GitHub App

Create a new app under **GitHub Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**:

#### Basic settings

| Field | Value |
|------|-----|
| **App name** | Anything (e.g. `My Webhook MCP`) |
| **Homepage URL** | The Worker URL or the repository URL |
| **Webhook URL** | `https://<your-worker>/webhooks/github` |
| **Webhook secret** | A strong random string (set the same value in step 5) |
| **Content type** | `application/json` (required) |

#### OAuth settings (required for MCP remote connections)

Since v0.11.1, OAuth runs as a **Worker-hosted web flow**. Local MCP clients do not depend on a localhost callback port, and GitHub's redirect_uri is fixed to the Worker itself.

1. Register `https://<your-worker>/oauth/callback` as the **Callback URL** (required)
   - Example: `https://github-webhook-mcp.example.workers.dev/oauth/callback`
   - If you use a custom domain, register `/oauth/callback` on that domain
   - If you use a GitHub App setting that accepts multiple URLs (e.g. Multiple callback URLs), list every Worker URL your users actually access
2. **"Enable Device Flow"** can **stay OFF** (v0.11.1 does not use it)
3. Generate and note the Client ID and Client Secret (used in step 5)
4. **The client secret is required** (the Worker performs the code→token exchange with GitHub as a confidential client)

> **Important:** Users migrating from v0.10.x or earlier (localhost callback flow) or v0.11.0 (device flow) are asked to re-authenticate through the web flow automatically on first connect (an old `~/.github-webhook-mcp/oauth-tokens.json` is ignored because its flow marker does not match). Open the authorize URL shown in the Claude Code chat response or in stderr and sign in to GitHub.

#### Permissions

Set according to the events you want to receive:

| Category | Permission | Purpose |
|---------|-------------|------|
| **Issues** | Read | Issue events |
| **Pull requests** | Read | PR events |
| **Contents** | Read | Push events |
| **Checks** | Read | Check run events |
| **Actions** | Read | Workflow run events |
| **Discussions** | Read | Discussion events |

#### Event subscriptions

Check the events you want to monitor:
- Issues / Issue comment
- Pull request / Pull request review / Pull request review comment / Pull request review thread
- Push
- Check run / Workflow run
- Discussion / Discussion comment

#### Installation

After creating the app, install it on your account or organization and select the repositories to monitor.

> **Important:** Do not create a separate repository webhook pointing at the same endpoint. The GitHub App handles all webhook deliveries; adding a repository webhook causes duplicates and invalid requests.

### 5. Configure secrets

Register the required secrets with Cloudflare, either from the dashboard (**Workers & Pages** → Worker → **Settings** → **Variables and Secrets**) or with the wrangler CLI:

```bash
# GitHub App webhook secret (required)
npx wrangler secret put GITHUB_WEBHOOK_SECRET

# GitHub App Client ID (required for web OAuth)
npx wrangler secret put GITHUB_CLIENT_ID

# GitHub App Client Secret (required for web OAuth — the Worker performs the code→token exchange as a confidential client)
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Each command prompts for the value; enter the corresponding one.

> **Note:** `GITHUB_CLIENT_SECRET` is used when the Worker's `/oauth/callback` presents the authorization code to GitHub. If it is empty or unset, the callback exchange fails, so always set it.

### 6. Custom domain (optional)

To use a custom domain instead of the default `*.workers.dev` URL:

1. Cloudflare dashboard → **Workers & Pages** → Worker → **Settings** → **Domains & Routes**
2. Add the custom domain (e.g. `github-webhook.example.com`)
3. Update the GitHub App's Webhook URL to the custom domain
4. Update the GitHub App's Callback URL to `/oauth/callback` on the custom domain (e.g. `https://github-webhook.example.com/oauth/callback`)
5. Update `WEBHOOK_WORKER_URL` in your MCP client configuration

### 7. WAF rules (recommended)

Security rules in Cloudflare WAF block invalid requests before they reach the Worker and reduce CPU billing.

#### GitHub IP restriction

Restrict access to the webhook endpoint to GitHub's IP ranges:

- **Target path:** `/webhooks/github`
- **Expression:** `(http.request.uri.path eq "/webhooks/github") and not (ip.src in { 140.82.112.0/20 185.199.108.0/22 192.30.252.0/22 143.55.64.0/20 })`
- **Action:** Block

> **Note:** GitHub's IP ranges may change. Check the `hooks` field of `https://api.github.com/meta` for the current values.

#### Rate limits

- **Webhook:** 300 req/min per IP (`/webhooks/github`)
- **API:** 120 req/min per IP (`/mcp`, `/events`)

### 8. Channel notifications (optional)

The local MCP bridge supports Claude Code's `claude/channel` feature. When enabled, the bridge holds a WebSocket connection to the Worker's `/events` endpoint and pushes new webhook events into the session in real time. Available in the Claude Code CLI only.

The Worker's `/events` endpoint also serves an SSE stream to plain GET requests (used for connectivity checks; the bridge itself uses WebSocket).

Set `WEBHOOK_CHANNEL=1` in your MCP client configuration (see [Claude Code CLI](#claude-code-cli--npx) above) and load the channel:

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```

### Verifying the deployment

After deploying, you can check that it works:

1. **Webhook delivery test:** On the GitHub App settings page → **Advanced** → **Recent Deliveries**, check the delivery status
2. **MCP connection test:** Call the `get_pending_status` tool from your MCP client and check the response
3. **Stream test:** `/events` requires a Bearer token (a request without one returns 401). After authenticating once through the MCP client, use the `access_token` from `~/.github-webhook-mcp/oauth-tokens.json`:
   ```bash
   curl -N -H "Authorization: Bearer <access_token>" https://<your-worker>/events
   ```
   On success the first frame is `data: {"status":"connected", ...}`. To check the WebSocket path the bridge uses: `wscat -c wss://<your-worker>/events -H "Authorization: Bearer <access_token>"`

### Troubleshooting

| Symptom | Cause and fix |
|------|-----------|
| Webhook returns 403 | `GITHUB_WEBHOOK_SECRET` does not match the GitHub App setting. Check both values |
| Webhook returns 429 | Tenant quota (default 10,000 events) exceeded. Process old events with `mark_processed` |
| `/oauth/callback` shows "Authorization failed" | `https://<your-worker>/oauth/callback` is not registered as the GitHub App Callback URL, or `GITHUB_CLIENT_SECRET` is unset / mismatched. Check steps 4 and 5 |
| The GitHub login page does not appear in the browser | Check that the Worker's `/oauth/authorize` is reachable (opening `https://<your-worker>/oauth/authorize?client_id=...&state=...` directly should 302-redirect to `github.com/login/oauth/authorize`) |
| The authorize URL does not appear in the Claude Code log | Check the stderr output. The `[github-webhook-mcp] OAuth authorization required.` section should contain `Opening: https://<worker>/oauth/authorize?...` |
| `~/.github-webhook-mcp/oauth-tokens.json` is ignored | When updating to v0.11.1, an old file whose flow marker is not `web` (localhost flow / device flow) is ignored automatically. Open the authorize URL in a browser and re-authenticate |
| KV errors | Check that the KV ID in `wrangler.toml` matches the output of `wrangler kv namespace create` |
| `/events` returns 401 | No or invalid Bearer token. Use a current `access_token` from `~/.github-webhook-mcp/oauth-tokens.json` (expired tokens are rejected) |
| MCP tools do not respond | Check that the Worker is deployed, and read its logs with `wrangler tail` |
