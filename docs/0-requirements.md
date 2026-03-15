# github-webhook-mcp Requirements Specification

## Purpose

GitHub Webhook イベントを受信・永続化し、MCP プロトコル経由で AI エージェントに提供する。
エージェントが GitHub の状態変化をリアルタイムに検知し、自律的に対応できるようにする。

## Premise

- GitHub Webhook は外部から HTTPS POST で到達する（Cloudflare Tunnel 経由）
- AI エージェントは MCP stdio トランスポートで接続する
- 単一マシン上でローカル動作する（分散構成は対象外）
- イベント永続化は JSON ファイルベース（DB 不要）

## Architecture

```
GitHub ──POST──> Cloudflare Tunnel ──> FastAPI :8080 ──persist──> events.json
                                                                     ^
                                                                     |
                       ┌─────────────────────────────┴─────────────────────────────┐
                       |                                                           |
                       |                                             trigger-events/<id>.json
                       |                                                           ^
                       |                                                           |
          MCP Server (stdio) ──read/write                               direct trigger queue
           Python or Node.js                                                       |
                 ^                                                                 |
                 |                                                                 |
       AI Agent (Codex / Claude)                                   optional trigger command
```

システムは二つのコンポーネントで構成される:

1. **Webhook 受信サーバー（Python）** — `python main.py webhook`
   - HTTP 受信、イベント永続化、optional な direct trigger queue を担当
   - trigger command が設定されている場合、保存済みイベントごとに直列実行される

2. **MCP ツールサーバー** — 二つの実装が存在する:
   - **Python 実装:** `python main.py mcp`
   - **Node.js 実装:** `mcp-server/` ディレクトリ（`npx github-webhook-mcp` または MCPB 経由）

両 MCP 実装は同一の events.json を読み書きし、同一の5ツールを提供する。
Python 実装は webhook 受信サーバーと同一エントリポイントで起動する。
Node.js 実装は独立パッケージとして配布される（MCPB: Claude Desktop 向け、npx: Codex 向け）。

## Functional Requirements

### F1. Webhook 受信

| ID | 要件 |
|----|------|
| F1.1 | `POST /webhook` で GitHub Webhook ペイロードを受信する |
| F1.2 | `X-Hub-Signature-256` ヘッダによる HMAC-SHA256 署名検証を行う |
| F1.3 | 署名不一致時は HTTP 401 を返す |
| F1.4 | シークレット未設定時は署名検証をスキップする |
| F1.5 | `GET /health` でヘルスチェックを提供する（`{"status": "ok"}`） |

### F2. イベントフィルタリング

| ID | 要件 |
|----|------|
| F2.1 | イベントプロファイルにより保存対象を制御する |
| F2.2 | `all` プロファイル: 全イベントを保存する |
| F2.3 | `notifications` プロファイル: GitHub Notifications 相当のイベントのみ保存する |
| F2.4 | フィルタ対象イベント種別と許可アクション: |

**notifications プロファイル許可リスト:**

| イベント種別 | 許可アクション |
|-------------|---------------|
| issues | assigned, closed, opened, reopened, unassigned |
| issue_comment | created |
| pull_request | assigned, closed, converted_to_draft, opened, ready_for_review, reopened, review_requested, review_request_removed, synchronize, unassigned |
| pull_request_review | dismissed, submitted |
| pull_request_review_comment | created |
| check_run | completed |
| workflow_run | completed |
| discussion | answered, closed, created, reopened |
| discussion_comment | created |

### F3. イベント永続化

| ID | 要件 |
|----|------|
| F3.1 | イベントを UUID 付きで `events.json` に保存する |
| F3.2 | 各イベントは id, type, payload, received_at, processed フィールドを持つ |
| F3.3 | ファイルエンコーディングは UTF-8 で書き込む |
| F3.4 | レガシーエンコーディング（cp932, shift_jis, utf-8-sig）からの自動マイグレーションを行う |
| F3.5 | trigger 実行を行う場合、イベントに `trigger_status`, `trigger_error`, `last_triggered_at` を追記できる |
| F3.6 | trigger 実行用に `trigger-events/<event-id>.json` を保存できる |

**イベント構造:**

```json
{
  "id": "uuid",
  "type": "issues",
  "payload": {},
  "received_at": "ISO8601+timezone",
  "processed": false,
  "trigger_status": "succeeded|failed|skipped|null",
  "trigger_error": "",
  "last_triggered_at": "ISO8601+timezone|null"
}
```

### F4. MCP ツール

Python 実装と Node.js 実装の両方が、以下の同一ツールセットを提供する。

| ID | ツール名 | 引数 | 戻り値 | 要件 |
|----|---------|------|--------|------|
| F4.1 | `get_pending_status` | なし | pending_count, latest_received_at, types | 未処理イベントの軽量スナップショットを返す |
| F4.2 | `list_pending_events` | limit (1-100, default 20) | サマリー配列 | 未処理イベントのメタデータ一覧を返す（ペイロード含まず） |
| F4.3 | `get_event` | event_id | 完全イベント or error | UUID 指定で完全なペイロードを返す |
| F4.4 | `get_webhook_events` | なし | 全未処理イベント | 全未処理イベントをフルペイロード付きで返す |
| F4.5 | `mark_processed` | event_id | success, event_id | イベントを処理済みにマークする |

**イベントサマリー構造:**

```json
{
  "id": "uuid",
  "type": "issues",
  "received_at": "ISO8601",
  "processed": false,
  "trigger_status": "succeeded|failed|skipped|null",
  "last_triggered_at": "ISO8601|null",
  "action": "opened",
  "repo": "owner/repo",
  "sender": "username",
  "number": 123,
  "title": "Issue title",
  "url": "https://github.com/..."
}
```

### F5. Direct Trigger Execution

| ID | 要件 |
|----|------|
| F5.1 | webhook モードは optional な trigger command を受け付ける |
| F5.2 | trigger command は保存対象イベントごとに 1 件ずつ直列実行する |
| F5.3 | trigger command にはイベント JSON 全体を stdin で渡す |
| F5.4 | trigger command には `GITHUB_WEBHOOK_*` 環境変数でイベント要約を渡す |
| F5.5 | trigger command 成功時はデフォルトでイベントを `processed=true` にする |
| F5.6 | `keep_pending_on_trigger_success` 指定時は成功しても pending のまま残す |
| F5.7 | trigger command 失敗時はイベントを pending のまま残し、`trigger_status=failed` を記録する |
| F5.8 | trigger command が notify-only fallback を選んだ場合は `trigger_status=skipped` を記録し、pending のまま残す |

**trigger command へ渡す環境変数:**

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

### F6. Bundled Codex Wrapper

| ID | 要件 |
|----|------|
| F6.1 | `codex_reaction.py` を bundled helper として提供する |
| F6.2 | helper は `codex exec -C <workspace>` による direct execution を行える |
| F6.3 | helper は `codex exec resume <thread-or-session-id>` による resume mode を行える |
| F6.4 | helper は event JSON path を prompt に含め、workspace の `AGENTS.md` を読む前提で起動する |
| F6.5 | workspace に `.codex-webhook-notify-only` がある場合、helper は direct execution を行わず notify-only fallback を返す |

### F7. 推奨ポーリングフロー

| ステップ | 操作 |
|---------|------|
| 1 | `get_pending_status()` を 60 秒間隔でポーリング |
| 2 | `pending_count > 0` なら `list_pending_events()` でサマリー取得 |
| 3 | フルペイロードが必要なイベントのみ `get_event(event_id)` で取得 |
| 4 | 処理完了後 `mark_processed(event_id)` でマーク |

## Non-Functional Requirements

### N1. セキュリティ

| ID | 要件 |
|----|------|
| N1.1 | Webhook シークレットは環境変数 `WEBHOOK_SECRET` で管理する |
| N1.2 | HMAC-SHA256 による署名検証でスプーフィングを防止する |
| N1.3 | MCP は stdio トランスポートを使用し、ネットワーク露出しない |

### N2. 構成

| ID | 項目 | ソース | デフォルト |
|----|------|--------|-----------|
| N2.1 | ポート | `--port` / 環境変数 | 8080 |
| N2.2 | シークレット | `--secret` / `WEBHOOK_SECRET` | なし（検証スキップ） |
| N2.3 | イベントプロファイル | `--event-profile` / `WEBHOOK_EVENT_PROFILE` | all |
| N2.4 | trigger command | `--trigger-command` / `WEBHOOK_TRIGGER_COMMAND` | なし |
| N2.5 | trigger working directory | `--trigger-cwd` / `WEBHOOK_TRIGGER_CWD` | なし |
| N2.6 | success 時に pending を維持するか | `--keep-pending-on-trigger-success` | false |
| N2.7 | events.json パス（Node.js MCP） | `EVENTS_JSON_PATH` | `mcp-server/../events.json` |

優先順位: CLI 引数 > 環境変数 > デフォルト
Node.js MCP サーバーは環境変数のみで構成する（CLI 引数なし）。

### N3. 制約

| ID | 制約 |
|----|------|
| N3.1 | イベントはファイル全体をメモリにロードする（大量イベントには不向き） |
| N3.2 | イベント検索は線形探索（インデックスなし） |
| N3.3 | 単一プロセス想定（webhook と mcp は別プロセスで起動） |
| N3.4 | direct trigger は単一 worker による直列実行であり、同時実行はしない |

## Dependencies

### Python（webhook 受信 + MCP サーバー）

| パッケージ | バージョン | 用途 |
|-----------|-----------|------|
| fastapi | >=0.110.0 | HTTP サーバーフレームワーク |
| uvicorn | >=0.29.0 | ASGI アプリケーションサーバー |
| mcp | >=1.0.0 | Model Context Protocol SDK |
| python-dotenv | >=1.0.0 | 環境変数ロード |

### Node.js（MCP サーバー）

| パッケージ | バージョン | 用途 |
|-----------|-----------|------|
| @modelcontextprotocol/sdk | ^1.0.0 | MCP SDK |
| iconv-lite | ^0.6.3 | レガシーエンコーディング対応 |
| zod | ^3.22.0 | スキーマバリデーション |

Node.js >= 18.0.0 が必要。

## Infrastructure

| コンポーネント | 用途 |
|---------------|------|
| Cloudflare Tunnel | GitHub からのインバウンド HTTPS を localhost に転送 |
| GitHub Webhook | イベント送信元 |
| optional trigger command | 保存済みイベントごとの direct reaction |
| MCPB | Claude Desktop 向け Node.js MCP サーバー配布 |
| npx | Codex 向け Node.js MCP サーバー配布 |

## Files

| パス | 用途 |
|-----|------|
| `events.json` | 永続化された webhook イベント本体 |
| `trigger-events/<event-id>.json` | trigger command に渡す保存済みイベント JSON |
| `main.py` | webhook receiver / Python MCP server / direct trigger queue |
| `codex_reaction.py` | Codex direct execution / resume / notify-only fallback helper |
| `mcp-server/server/index.js` | Node.js MCP サーバー エントリポイント |
| `mcp-server/server/event-store.js` | Node.js イベントストア（events.json 読み書き） |
| `mcp-server/package.json` | Node.js パッケージ定義（npx 配布用） |
| `mcp-server/manifest.json` | MCPB マニフェスト（Claude Desktop 配布用） |
