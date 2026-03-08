# github-webhook-mcp

GitHub webhook receiver as an MCP server.

Receives GitHub webhook events and enables Lin and Lay to autonomously handle PR reviews and issue management.

## Architecture

```
GitHub → Cloudflare Tunnel → webhook server (FastAPI :8080)
                                      ↓ events.json
                             MCP server (stdio) ← Claude (Lin/Lay)
```

Recommended polling flow:

1. Poll `get_pending_status` every 60 seconds.
2. If `pending_count > 0`, call `list_pending_events`.
3. Only call `get_event` for the specific event IDs that need full payloads.
4. Call `mark_processed` after handling them.

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Start webhook receiver

```bash
WEBHOOK_SECRET=your_secret python main.py webhook --port 8080 --event-profile notifications
```

### 3. Set up Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create github-webhook-mcp
cp cloudflared/config.yml.example ~/.cloudflared/config.yml
# Edit config.yml with your tunnel ID and domain
cloudflared tunnel run
```

### 4. Configure GitHub webhook

- Payload URL: `https://webhook.yourdomain.com/webhook`
- Content type: `application/json`
- Secret: same value as `WEBHOOK_SECRET`
- Recommended event profile: choose these events to stay close to GitHub Notifications
  - Issues
  - Issue comments
  - Pull requests
  - Pull request reviews
  - Pull request review comments
  - Check runs
  - Workflow runs
  - Discussions
  - Discussion comments

If your webhook is temporarily set to `Send me everything`, start the receiver with `--event-profile notifications` and it will ignore noisy events such as `workflow_job` or `check_suite`.

### 5. Configure MCP server

Add to your Claude MCP config:

```json
{
  "mcpServers": {
    "github-webhook-mcp": {
      "command": "python",
      "args": ["/path/to/github-webhook-mcp/main.py", "mcp"]
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_pending_status` | Lightweight pending count + type summary for polling |
| `list_pending_events` | Lightweight metadata for pending events |
| `get_event` | Full payload for a single event ID |
| `get_webhook_events` | Get pending (unprocessed) webhook events |
| `mark_processed` | Mark an event as processed |

`get_webhook_events` is still available, but it returns raw webhook payloads and is much heavier than the status → summary → detail flow above.

## Event Profiles

The webhook receiver supports two profiles:

- `all`: store every incoming webhook event
- `notifications`: only store events that are close to GitHub Notifications, such as issue / PR activity, review activity, and completed CI results

Use `notifications` for low-noise polling.

## Related

- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ language specification
- liplus-language #610
