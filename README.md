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

## Getting Started

### 1. Install the GitHub App

Install the **GitHub Webhook MCP** app on your GitHub organization or account:

1. Visit the [GitHub App installation page](https://github.com/apps/liplus-webhook-mcp)
2. Select the organization or account to install on
3. Choose which repositories to grant access to (or all repositories)
4. Approve the requested permissions

> **Note:** When the app requests new permissions after an update, you must approve them in your GitHub notification or the app's installation settings. Webhooks will not be delivered until permissions are accepted.

> **Important:** Do not create a separate repository webhook for the same endpoint. The GitHub App handles all webhook delivery — a repository webhook would cause duplicate or malformed requests.

### 2. Set up the MCP client

Continue to the [Installation guide](docs/installation.md) to connect your AI assistant to the webhook service.

## Installation

See [docs/installation.md](docs/installation.md) for the full setup guide, including:

- **Quick Start** with the preview instance
- **MCP Client Setup** for Claude Desktop, Claude Code CLI, and Codex
- **Self-Hosting Guide** for Cloudflare Workers deployment

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
