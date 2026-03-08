# github-webhook-mcp

GitHub webhook receiver as an MCP server.

Receives GitHub webhook events and enables Lin and Lay to autonomously handle PR reviews and issue management.

## Architecture

```
GitHub → Cloudflare Tunnel → webhook server (FastAPI :8080)
                                      ↓ events.json
                             MCP server (stdio) ← Claude (Lin/Lay)
```

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Start webhook receiver

```bash
WEBHOOK_SECRET=your_secret python main.py webhook --port 8080
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
- Events: Pull request reviews, Issue comments, Pull requests

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
| `get_webhook_events` | Get pending (unprocessed) webhook events |
| `mark_processed` | Mark an event as processed |

## Related

- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ language specification
- liplus-language #610
