# Installation

## Quick Start

The fastest way to try github-webhook-mcp is using the preview instance:

1. Install the [GitHub Webhook MCP](https://github.com/apps/liplus-webhook-mcp) app on your GitHub account or organization
2. Configure your MCP client (see [MCP Client Setup](#mcp-client-setup) below) with:
   - Worker URL: `https://github-webhook.smgjp.com`
3. Start receiving webhook notifications

> **Note:** The preview instance at `github-webhook.smgjp.com` is provided for evaluation purposes. There is no SLA, and the instance may change or stop without notice. For production use, see [Self-Hosting Guide](#self-hosting-guide).

## MCP Client Setup

### Claude Desktop -- Desktop Extension (.mcpb)

Download `mcp-server.mcpb` from [Releases](https://github.com/Liplus-Project/github-webhook-mcp/releases), then:

1. Open Claude Desktop -> **Settings** -> **Extensions** -> **Install Extension...**
2. Select the `.mcpb` file
3. Enter your Worker URL when prompted (e.g. `https://github-webhook-mcp.example.workers.dev`)

### Claude Code CLI -- npx

```json
{
  "mcpServers": {
    "github-webhook-mcp": {
      "command": "npx",
      "args": ["github-webhook-mcp"],
      "env": {
        "WEBHOOK_WORKER_URL": "https://github-webhook-mcp.example.workers.dev",
        "WEBHOOK_CHANNEL": "1"
      }
    }
  }
}
```

Set `WEBHOOK_CHANNEL=1` to enable real-time channel notifications (Claude Code CLI only).

### Codex -- config.toml

```toml
[mcp.github-webhook-mcp]
command = "npx"
args = ["github-webhook-mcp"]

[mcp.github-webhook-mcp.env]
WEBHOOK_WORKER_URL = "https://github-webhook-mcp.example.workers.dev"
WEBHOOK_CHANNEL = "0"
```

## Self-Hosting Guide

Deploy your own Cloudflare Worker instance for full control over webhook processing and data.

### Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Cloudflare account** | Worker and Durable Object hosting |
| **Node.js 18+** | Build and deploy tooling |
| **wrangler CLI** | Cloudflare deployment (`npm install -g wrangler`) |

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler deploy
```

This deploys the Worker and Durable Object to your Cloudflare account. Note the Worker URL from the output (e.g. `https://github-webhook-mcp.example.workers.dev`).

### 2. Set the webhook secret

Generate a strong secret and store it as a Cloudflare secret:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Enter the secret value when prompted. Keep this value -- you will need it when configuring the GitHub App.

### 3. Create and configure a GitHub App

1. Go to **GitHub Settings** -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**
2. Configure the app:
   - **Webhook URL:** `https://github-webhook-mcp.example.workers.dev/webhooks/github`
   - **Webhook secret:** the same value set in step 2
   - **Content type:** `application/json`
3. Set permissions based on the events you want to receive:
   - **Repository permissions:** Issues (Read), Pull requests (Read), Contents (Read), etc.
4. Subscribe to events:
   - Issues, Pull request, Push, Check run, Workflow run, etc.
5. After creation, install the app on your account or organization and select which repositories to monitor

> **Important:** Do not create a separate repository webhook for the same endpoint. The GitHub App handles all webhook delivery -- a repository webhook would cause duplicate or malformed requests.

### 4. OAuth setup (optional)

If your deployment uses OAuth-based authentication:

1. In the GitHub App settings, set the **Callback URL** to:
   `https://github-webhook-mcp.example.workers.dev/auth/callback`
2. Generate a client secret and store it as a Cloudflare secret

### 5. Custom domain (optional)

To use a custom domain instead of the default `*.workers.dev` URL:

1. In the Cloudflare dashboard, go to **Workers & Pages** -> your Worker -> **Settings** -> **Domains & Routes**
2. Add your custom domain (e.g. `github-webhook.example.com`)
3. Update the webhook URL in your GitHub App settings to use the custom domain
4. Update the `WEBHOOK_WORKER_URL` in your MCP client configuration

### 6. Channel notifications (optional)

The local MCP bridge supports Claude Code's `claude/channel` capability. When enabled, new webhook events are pushed into your session via SSE in real-time. This feature is available in Claude Code CLI only.

To enable channel notifications, set `WEBHOOK_CHANNEL=1` in your MCP client configuration (see [Claude Code CLI](#claude-code-cli----npx) above), then load the channel:

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```
