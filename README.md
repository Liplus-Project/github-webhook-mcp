# github-webhook-mcp

GitHub webhook receiver as an MCP server.

Receives GitHub webhook events and enables Lin and Lay to autonomously handle PR reviews and issue management.
It can either expose events to MCP for polling or trigger Codex immediately when a webhook arrives.

## Architecture

```
GitHub → Cloudflare Tunnel → webhook server (FastAPI :8080)
                                      ↓ events.json
                       ┌──────────────┴──────────────┐
                       ↓                             ↓
              MCP server (stdio)               direct trigger queue
                       ↓                             ↓
               Codex / Claude                codex exec (one-by-one)
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

### 2b. Start webhook receiver with direct Codex reactions

`main.py webhook` accepts `--trigger-command`, which runs once per stored event.
When a service manager already splits arguments for you, put `--trigger-command` last and pass the command tokens after it without wrapping the whole trigger in quotes.
The command receives the full event JSON on stdin and also gets these environment variables:

- `GITHUB_WEBHOOK_EVENT_ID`
- `GITHUB_WEBHOOK_EVENT_TYPE`
- `GITHUB_WEBHOOK_EVENT_ACTION`
- `GITHUB_WEBHOOK_EVENT_REPO`
- `GITHUB_WEBHOOK_EVENT_SENDER`
- `GITHUB_WEBHOOK_EVENT_NUMBER`
- `GITHUB_WEBHOOK_EVENT_TITLE`
- `GITHUB_WEBHOOK_EVENT_URL`
- `GITHUB_WEBHOOK_EVENT_PATH`
- `GITHUB_WEBHOOK_RECEIVED_AT`

The webhook server serializes trigger execution, so only one direct reaction runs at a time.
Successful runs are marked processed automatically. Failed runs stay pending.
If the trigger command intentionally defers handling, it can exit with code `86`.
That is recorded as `trigger_status=skipped` and the event stays pending for foreground polling.

Use the bundled Codex wrapper if you want the webhook to launch `codex exec` immediately:

```bash
python main.py webhook \
  --port 8080 \
  --event-profile notifications \
  --trigger-command "python codex_reaction.py --workspace /path/to/workspace --output-dir /path/to/github-webhook-mcp/codex-runs"
```

Service-manager style is also supported:

```text
python main.py webhook --port 8080 --event-profile notifications --trigger-command python codex_reaction.py --workspace /path/to/workspace --output-dir /path/to/github-webhook-mcp/codex-runs
```

On Windows PowerShell the same idea looks like this:

```powershell
py -3 .\main.py webhook `
  --port 8080 `
  --event-profile notifications `
  --trigger-command "py -3 C:\path\to\github-webhook-mcp\codex_reaction.py --workspace C:\path\to\workspace --output-dir C:\path\to\github-webhook-mcp\codex-runs"
```

`codex_reaction.py` builds a short prompt, points Codex at the saved event JSON file, and runs:

```text
codex -a never -s workspace-write exec -C <workspace> ...
```

If you want the result to appear in an existing Codex app thread instead of a markdown file, switch the wrapper to resume mode:

```text
python codex_reaction.py --workspace /path/to/workspace --resume-session <thread-or-session-id>
```

If you want webhook delivery to stay notification-only for a workspace, create a `.codex-webhook-notify-only`
file in that workspace. The bundled wrapper will skip direct Codex execution and leave the event pending.

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
When direct trigger mode is enabled, the saved event metadata also records `trigger_status` and `last_triggered_at`.
Possible statuses are `succeeded`, `failed`, and `skipped`.

## Event Profiles

The webhook receiver supports two profiles:

- `all`: store every incoming webhook event
- `notifications`: only store events that are close to GitHub Notifications, such as issue / PR activity, review activity, and completed CI results

Use `notifications` for low-noise polling.

## Files

- `main.py`: webhook receiver + MCP server + direct trigger queue
- `codex_reaction.py`: helper wrapper that launches `codex exec` per event
- `trigger-events/<event-id>.json`: saved payload passed to direct trigger commands

## Related

- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ language specification
- liplus-language #610
