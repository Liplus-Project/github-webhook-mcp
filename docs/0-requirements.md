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
                                            MCP Server (stdio) ──read/write
                                                  ^
                                                  |
                                            AI Agent (Claude)
```

二つのプロセスモードを持つ単一エントリポイント:
- `python main.py webhook` — HTTP 受信サーバー
- `python main.py mcp` — MCP ツールサーバー

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

**イベント構造:**

```json
{
  "id": "uuid",
  "type": "issues",
  "payload": {},
  "received_at": "ISO8601+timezone",
  "processed": false
}
```

### F4. MCP ツール

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
  "action": "opened",
  "repo": "owner/repo",
  "sender": "username",
  "number": 123,
  "title": "Issue title",
  "url": "https://github.com/..."
}
```

### F5. 推奨ポーリングフロー

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

優先順位: CLI 引数 > 環境変数 > デフォルト

### N3. 制約

| ID | 制約 |
|----|------|
| N3.1 | イベントはファイル全体をメモリにロードする（大量イベントには不向き） |
| N3.2 | イベント検索は線形探索（インデックスなし） |
| N3.3 | 単一プロセス想定（webhook と mcp は別プロセスで起動） |

## Dependencies

| パッケージ | バージョン | 用途 |
|-----------|-----------|------|
| fastapi | >=0.110.0 | HTTP サーバーフレームワーク |
| uvicorn | >=0.29.0 | ASGI アプリケーションサーバー |
| mcp | >=1.0.0 | Model Context Protocol SDK |
| python-dotenv | >=1.0.0 | 環境変数ロード |

## Infrastructure

| コンポーネント | 用途 |
|---------------|------|
| Cloudflare Tunnel | GitHub からのインバウンド HTTPS を localhost に転送 |
| GitHub Webhook | イベント送信元 |
