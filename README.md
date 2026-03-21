# github-webhook-mcp

GitHub webhook receiver as an MCP server.

Receives GitHub webhook events and enables Lin and Lay to autonomously handle PR reviews and issue management.
It supports two operating styles:

- MCP polling: store webhook events and let an AI poll lightweight summaries.
- Channel push: push new events into a Claude Code session in real-time via `claude/channel`.
- Direct trigger: run a command immediately for each stored event.

Detailed behavior, event metadata, trigger semantics, and file responsibilities live in [docs/0-requirements.md](docs/0-requirements.md).

## Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Start webhook receiver for MCP polling

```bash
WEBHOOK_SECRET=your_secret python main.py webhook --port 8080 --event-profile notifications
```

### 3. Optional: start webhook receiver with direct Codex reactions

Use the bundled Codex wrapper if you want the webhook to launch `codex exec` immediately.
Put `--trigger-command` last when a service manager splits the remaining tokens for you.

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

### 4. Set up Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create github-webhook-mcp
cp cloudflared/config.yml.example ~/.cloudflared/config.yml
# Edit config.yml with your tunnel ID and domain
cloudflared tunnel run
```

### 5. Configure GitHub webhook

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

### 6. Enable channel push notifications (optional)

The Node.js MCP server supports Claude Code's `claude/channel` capability (research preview, v2.1.80+). When enabled, new webhook events are pushed into your session automatically — no polling needed.

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```

Channel notifications are enabled by default. To disable, set `WEBHOOK_CHANNEL=0` in the MCP server env.

### 7. Configure MCP server

#### Option A: Claude Desktop — Desktop Extension (.mcpb)

Download `mcp-server.mcpb` from [Releases](https://github.com/Liplus-Project/github-webhook-mcp/releases), then:

1. Open Claude Desktop → **Settings** → **Extensions** → **Advanced settings** → **Install Extension...**
2. Select the `.mcpb` file
3. Enter the path to your `events.json` when prompted

#### Option B: Claude Desktop / Claude Code — npx

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

#### Option C: Codex — config.toml

```toml
[mcp.github-webhook-mcp]
command = "npx"
args = ["github-webhook-mcp"]

[mcp.github-webhook-mcp.env]
EVENTS_JSON_PATH = "/path/to/events.json"
```

#### Option D: Python (legacy)

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

## Operator Notes

- For the recommended polling flow, MCP tool contracts, event profiles, and trigger metadata, see [docs/0-requirements.md](docs/0-requirements.md).
- For environment variable examples, see [.env.example](.env.example).
- For direct trigger usage, `codex_reaction.py` is the bundled helper.

## Related

- [docs/0-requirements.md](docs/0-requirements.md) — source-of-truth requirements and behavior contracts
- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ language specification
- liplus-language #610
