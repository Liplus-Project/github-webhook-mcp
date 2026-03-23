# github-webhook-mcp

GitHub webhook receiver and local MCP extension for GitHub notification workflows.

## Description

`github-webhook-mcp` receives GitHub webhook events, persists them to a local `events.json`, and exposes them to AI agents through MCP tools.
It is designed for notification-style workflows where an AI can poll lightweight summaries, inspect a single event in detail, and mark handled events as processed.

Detailed behavior, event metadata, trigger semantics, and file responsibilities live in [docs/0-requirements.md](docs/0-requirements.md).

## Features

- Receives GitHub webhook events over HTTPS and persists them locally.
- Exposes pending events to MCP clients through lightweight polling tools.
- Supports real-time `claude/channel` notifications in Claude Code.
- Supports direct trigger mode for immediate Codex reactions per event.
- Ships as a Node-based `.mcpb` desktop extension and as an `npx` MCP server.

## Installation

### Claude Desktop — Desktop Extension (.mcpb)

Download `mcp-server.mcpb` from [Releases](https://github.com/Liplus-Project/github-webhook-mcp/releases), then:

1. Open Claude Desktop → **Settings** → **Extensions** → **Advanced settings** → **Install Extension...**
2. Select the `.mcpb` file
3. Enter the path to your `events.json` when prompted

### Claude Desktop / Claude Code — npx

Add to your Claude MCP config (`claude_desktop_config.json` or project settings):

```json
{
  "mcpServers": {
    "github-webhook-mcp": {
      "command": "npx",
      "args": ["github-webhook-mcp"],
      "env": {
        "EVENTS_JSON_PATH": "/path/to/events.json"
      }
    }
  }
}
```

### Codex — config.toml

```toml
[mcp.github-webhook-mcp]
command = "npx"
args = ["github-webhook-mcp"]

[mcp.github-webhook-mcp.env]
EVENTS_JSON_PATH = "/path/to/events.json"
```

### Python (legacy)

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

## Configuration

### 1. Install receiver dependencies

```bash
pip install -r requirements.txt
```

### 2. Start the webhook receiver

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

### 4. Configure the GitHub webhook

- Payload URL: `https://webhook.yourdomain.com/webhook`
- Content type: `application/json`
- Secret: same value as `WEBHOOK_SECRET`
- Recommended event profile:
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

### 5. Optional direct trigger mode

Use the bundled Codex wrapper if you want the webhook to launch `codex exec` immediately.

```bash
python main.py webhook \
  --port 8080 \
  --event-profile notifications \
  --trigger-command "python codex_reaction.py --workspace /path/to/workspace --output-dir /path/to/github-webhook-mcp/codex-runs"
```

If you want Codex to resume an existing app thread instead of writing markdown output:

```text
python codex_reaction.py --workspace /path/to/workspace --resume-session <thread-or-session-id>
```

If you want webhook delivery to stay notification-only for a workspace, create a `.codex-webhook-notify-only`
file in that workspace. The bundled wrapper will skip direct Codex execution and leave the event pending.

### 6. Optional channel push notifications

The Node.js MCP server supports Claude Code's `claude/channel` capability (research preview, v2.1.80+). When enabled, new webhook events are pushed into your session automatically.

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```

Channel notifications are enabled by default. To disable, set `WEBHOOK_CHANNEL=0` in the MCP server environment.

## Examples

### Example 1: Check whether any GitHub notifications are pending

**User prompt:** "Do I have any pending GitHub webhook notifications right now?"

**Expected behavior:**

- Calls `get_pending_status`
- Returns pending count, latest event time, and event types
- Uses that summary to decide whether more detail is needed

### Example 2: Review the latest pending PR-related event

**User prompt:** "Show me the latest pending pull request event and explain what changed."

**Expected behavior:**

- Calls `list_pending_events` to find the newest relevant event
- Calls `get_event` only for the selected event
- Summarizes the PR metadata and payload without dumping every event

### Example 3: Mark an event as handled after triage

**User prompt:** "I already handled event `EVENT_ID`. Mark it processed so it stops appearing."

**Expected behavior:**

- Calls `mark_processed` with the event ID
- Marks the event as processed in the local event store
- Confirms success and, if applicable, reports how many processed events were purged

## Privacy Policy

This extension works with GitHub webhook event payloads that you choose to persist locally in `events.json`.
It may include issue titles, pull request metadata, discussion text, sender identities, and repository URLs inside that local event store.

### Data Collection

- Reads the local `events.json` file configured by the user
- Surfaces webhook metadata and payloads to the connected MCP client
- Can mark events as processed in the same local event store
- Does not send event contents to third-party services by itself beyond the webhook receiver and infrastructure you configure

### Submission Note

The current policy text is mirrored in this README so the packaged extension can point to a public HTTPS URL immediately.
If Anthropic review requires an extension-specific policy on your own domain, publish the same policy text there and update `mcp-server/manifest.json` before final submission.

## Support

- GitHub Issues: https://github.com/Liplus-Project/github-webhook-mcp/issues
- Requirements/specification: [docs/0-requirements.md](docs/0-requirements.md)
- Environment variable examples: [.env.example](.env.example)

## Related

- [docs/0-requirements.md](docs/0-requirements.md) — source-of-truth requirements and behavior contracts
- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ language specification
- liplus-language #610
