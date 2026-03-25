# github-webhook-mcp

Real-time GitHub webhook notifications for Claude via Cloudflare Worker + Durable Object.

## Architecture

```
GitHub ──POST──▶ Cloudflare Worker ──▶ Durable Object (SQLite)
                                           │
                                           ├── MCP tools (Streamable HTTP)
                                           ├── SSE real-time stream
                                           │
                          ┌────────────────┘
                          │
     Desktop / Codex: .mcpb local bridge ──▶ polling via MCP tools
     Claude Code CLI: .mcpb local bridge ──▶ SSE → channel notifications
```

- **Cloudflare Worker** receives GitHub webhooks, verifies signatures, stores events in a Durable Object with SQLite.
- **Local MCP bridge** (.mcpb) proxies tool calls to the Worker and optionally listens to SSE for real-time channel notifications.
- No local webhook receiver or tunnel required.

## Prerequisites

| Component | Required |
|-----------|----------|
| **Node.js 18+** | MCP server |
| **Cloudflare account** | Worker deployment (self-hosting) |

## Installation

### Claude Desktop — Desktop Extension (.mcpb)

Download `mcp-server.mcpb` from [Releases](https://github.com/Liplus-Project/github-webhook-mcp/releases), then:

1. Open Claude Desktop → **Settings** → **Extensions** → **Install Extension...**
2. Select the `.mcpb` file
3. Enter your Worker URL when prompted (e.g. `https://github-webhook-mcp.example.workers.dev`)

### Claude Code CLI — npx

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

### Codex — config.toml

```toml
[mcp.github-webhook-mcp]
command = "npx"
args = ["github-webhook-mcp"]

[mcp.github-webhook-mcp.env]
WEBHOOK_WORKER_URL = "https://github-webhook-mcp.example.workers.dev"
WEBHOOK_CHANNEL = "0"
```

## Self-Hosting the Worker

### 1. Deploy to Cloudflare

```bash
cd worker
npm install
npx wrangler deploy
```

### 2. Set the webhook secret

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 3. Configure the GitHub webhook

- Payload URL: `https://your-worker.workers.dev/webhooks/github`
- Content type: `application/json`
- Secret: same value as the Cloudflare secret
- Events: select the events you want to receive

### 4. Optional: Channel notifications

The local MCP bridge supports Claude Code's `claude/channel` capability. When enabled, new webhook events are pushed into your session via SSE in real-time.

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_pending_status` | Lightweight snapshot of pending event counts by type |
| `list_pending_events` | Summaries of pending events (no full payloads) |
| `get_event` | Full payload for a single event by ID |
| `get_webhook_events` | Full payloads for all pending events |
| `mark_processed` | Mark an event as processed |

## Monorepo Structure

```
worker/       — Cloudflare Worker + Durable Objects
local-mcp/    — Local stdio MCP bridge (TypeScript, dev)
mcp-server/   — .mcpb package for Claude Desktop
shared/       — Shared types and utilities
```

## Privacy Policy

Events are stored in a Cloudflare Durable Object (edge storage). The local MCP bridge proxies tool calls to the Worker and does not store event data locally.

- Extension privacy policy: https://smgjp.com/privacy-policy-github-webhook-mcp/

## Support

- GitHub Issues: https://github.com/Liplus-Project/github-webhook-mcp/issues
- Requirements: [docs/0-requirements.md](docs/0-requirements.md)

## Related

- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ language specification
