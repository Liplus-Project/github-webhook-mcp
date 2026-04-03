# github-webhook-mcp Requirements Specification

## Purpose

GitHub Webhook イベントを Cloudflare Worker で受信・永続化し、MCP プロトコル経由で AI エージェントに提供する。
エージェントが GitHub の状態変化をリアルタイムに検知し、自律的に対応できるようにする。

## Premise

- GitHub Webhook は Cloudflare Worker に直接到達する（ローカルサーバー不要）
- イベントは Durable Object 内の SQLite に永続化される
- AI エージェントは MCP stdio トランスポート（ローカルブリッジ）または Streamable HTTP（リモート）で接続する
- ローカルブリッジは Worker にツール呼び出しをプロキシし、WebSocket でリアルタイム通知を中継する

## Architecture

```
GitHub ──POST──▶ Cloudflare Worker ──▶ TenantRegistry DO
                  │ 署名検証                    │ installation_id → account_id
                  │ UUID 付与                    │
                  │                             ▼
                  │                    WebhookStore DO (SQLite) [per-tenant]
                  │                             │
                  ├── /mcp (Streamable HTTP)     ├── WebSocket real-time stream
                  │    WebhookMcpAgent DO        └── REST endpoints
                  │    [per-tenant]                   /pending-status
                  │    └── tools → WebhookStore       /pending-events
                  │                                   /webhook-events
                  ├── /events (WebSocket/SSE)          /event
                  │    └── WebhookStore DO             /mark-processed
                  │
                  └── /webhooks/github (POST)
                       └── TenantRegistry → WebhookStore DO /ingest

                          ┌─────────────────────────────┐
                          │  Local MCP Bridge (.mcpb)    │
                          │  stdio ← Claude Desktop/CLI  │
                          │  → proxy tool calls to /mcp  │
                          │  → WebSocket listener → channel │
                          └─────────────────────────────┘
```

システムは四つのコンポーネントで構成される:

1. **Cloudflare Worker** — webhook 受信、署名検証、テナントルーティング
2. **TenantRegistry Durable Object** — installation_id → account_id マッピング管理、テナント単位クォータ管理（単一インスタンス）
3. **WebhookStore Durable Object** — SQLite によるイベント永続化、REST/WebSocket/SSE エンドポイント（テナント別インスタンス: `store-{accountId}`）
4. **WebhookMcpAgent Durable Object** — MCP Streamable HTTP サーバー、ツール定義（テナント別インスタンス: `tenant-{accountId}`）

ローカルブリッジ（mcp-server/）は Worker に対するプロキシであり、データを保持しない。

## Functional Requirements

### F1. Webhook 受信

| ID | 要件 |
|----|------|
| F1.1 | `POST /webhooks/github` で GitHub Webhook ペイロードを受信する |
| F1.2 | `X-Hub-Signature-256` ヘッダによる HMAC-SHA256 署名検証を行う |
| F1.3 | 署名不一致時は HTTP 403 を返す |
| F1.4 | シークレット未設定時は署名検証をスキップする |
| F1.5 | テナント単位クォータ超過時は HTTP 429 を返す（installation イベントはクォータチェックをスキップ） |
| F1.6 | 認証チェック順序: IP allowlist → per-IP rate limit → signature → tenant resolution → per-tenant quota → ingest |

### F2. イベント永続化

| ID | 要件 |
|----|------|
| F2.1 | イベントを UUID 付きで WebhookStore DO の SQLite に保存する |
| F2.2 | 各イベントは id, type, payload, received_at, processed フィールドを持つ |
| F2.3 | trigger_status, last_triggered_at フィールドを保持する（将来の trigger 機能用） |

**イベント構造:**

```json
{
  "id": "uuid",
  "type": "issues",
  "payload": {},
  "received_at": "ISO8601",
  "processed": false,
  "trigger_status": null,
  "last_triggered_at": null
}
```

### F3. MCP ツール

WebhookMcpAgent DO が以下のツールセットを提供する。ローカルブリッジはこれをプロキシする。

| ID | ツール名 | 引数 | 戻り値 | 要件 |
|----|---------|------|--------|------|
| F3.1 | `get_pending_status` | なし | pending_count, latest_received_at, types | 未処理イベントの軽量スナップショットを返す |
| F3.2 | `list_pending_events` | limit (1-100, default 20) | サマリー配列 | 未処理イベントのメタデータ一覧を返す（ペイロード含まず） |
| F3.3 | `get_event` | event_id | 完全イベント or error | UUID 指定で完全なペイロードを返す |
| F3.4 | `get_webhook_events` | limit (1-100, default 20) | 未処理イベント配列 | 未処理イベントをフルペイロード付きで返す |
| F3.5 | `mark_processed` | event_id | success, event_id | イベントを処理済みにマークする |

**イベントサマリー構造:**

```json
{
  "id": "uuid",
  "type": "issues",
  "received_at": "ISO8601",
  "processed": false,
  "trigger_status": null,
  "last_triggered_at": null,
  "action": "opened",
  "repo": "owner/repo",
  "sender": "username",
  "number": 123,
  "title": "Issue title",
  "url": "https://github.com/..."
}
```

### F4. リアルタイムイベント配信（WebSocket / SSE）

| ID | 要件 |
|----|------|
| F4.1 | `GET /events` で WebSocket および SSE ストリームを提供する（Upgrade ヘッダで切り替え） |
| F4.2 | webhook ingest 時に接続中の全クライアントにイベントサマリーをブロードキャストする |
| F4.3 | 30 秒間隔でハートビート（WebSocket: ping、SSE: heartbeat コメント）を送信する |
| F4.4 | クライアント切断時にクリーンアップする |

### F5. チャンネル通知（ローカルブリッジ）

| ID | 要件 |
|----|------|
| F5.1 | ローカルブリッジが Claude Code の `claude/channel` experimental capability を宣言する |
| F5.2 | Worker の WebSocket エンドポイントに接続し、新規イベント検出時に `notifications/claude/channel` を送信する |
| F5.3 | 通知内容はイベントサマリー（type, repo, action, title, sender）を含む |
| F5.4 | `meta` フィールドに `chat_id`, `message_id`, `user`, `ts` を付与する |
| F5.5 | `WEBHOOK_CHANNEL=0` 環境変数でチャンネル通知を無効化できる（デフォルト: 有効） |
| F5.6 | チャンネル通知は one-way（読み取り専用）で、reply tool は提供しない |

### F6. 推奨ポーリングフロー

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
| N1.1 | Webhook シークレットは Cloudflare Worker の Secret（`GITHUB_WEBHOOK_SECRET`）で管理する |
| N1.2 | HMAC-SHA256 による署名検証でスプーフィングを防止する |
| N1.3 | ローカルブリッジは stdio トランスポートを使用し、ネットワーク露出しない |
| N1.4 | Webhook エンドポイントは多層防御で DDoS/課金攻撃を防止する: IP allowlist → per-IP rate limit → signature → tenant resolution → per-tenant quota |
| N1.5 | GitHub IP allowlist（api.github.com/meta の hooks フィールド）で非 GitHub IP を最外層でブロックする（github-ip.ts） |
| N1.6 | Per-IP rate limit はインメモリ sliding window で Worker isolate 内に実装する（rate-limit.ts） |
| N1.7 | Per-tenant quota は TenantRegistry DO で atomic check-and-increment により管理し、単一テナントの無制限ストレージ消費を防止する |
| N1.8 | Cloudflare WAF カスタムルールによる外部 IP ブロックを推奨する（Worker 到達前にブロックし CPU 課金を削減） |

### N2. 構成

| ID | 項目 | ソース | デフォルト |
|----|------|--------|-----------|
| N2.1 | Worker URL | `WEBHOOK_WORKER_URL` 環境変数 | なし（必須） |
| N2.2 | シークレット | Cloudflare Secret `GITHUB_WEBHOOK_SECRET` | なし（検証スキップ） |
| N2.3 | チャンネル通知の有効/無効 | `WEBHOOK_CHANNEL` | 有効（`0` で無効） |
| N2.4 | カスタムドメイン | `github-webhook.smgjp.com` | Cloudflare Worker のカスタムドメインとして設定済み |
| N2.5 | 認証方式 | Worker 自前認証 | Cloudflare Access は使用しない。Worker が webhook secret + OAuth で認証を処理する |
| N2.6 | プレビューインスタンス | `preview` 環境 | 本番と同一構成の検証用インスタンス |

**GitHub Webhook 購読イベント:**

| イベント | 状態 |
|---------|------|
| Discussion | 有効 |
| Discussion comment | 有効 |
| Issue comment | 有効 |
| Pull request review | 有効 |
| Pull request review comment | 有効 |
| Pull request review thread | 有効 |
| Workflow run | 有効 |
| Issues | 削除済み（未購読） |
| Pull request | 削除済み（未購読） |
| Sub issues | 削除済み（未購読） |

### N3. 制約

| ID | 制約 |
|----|------|
| N3.1 | WebhookStore / McpAgent DO はテナント別インスタンス（`idFromName("store-{accountId}")` / `getAgentByName("tenant-{accountId}")`）で動作する。TenantRegistry DO は単一インスタンスで全テナントの installation-account マッピングを管理する |
| N3.4 | OAuth コールバック時に `GET /user/installations` で取得した accessible_account_ids（ユーザー + org）を GitHubUserProps に保存し、McpAgent が複数 store を並列クエリして結果をマージする。これにより org インストールのイベントもメンバーの MCP セッションから参照できる |
| N3.2 | WebSocket / SSE 接続は DO のメモリ内で管理される（DO eviction 時に切断） |
| N3.3 | ローカルブリッジはツール呼び出しごとに Worker セッションを再利用する（セッション失効時は自動リトライ） |

## Dependencies

### Cloudflare Worker

| パッケージ | 用途 |
|-----------|------|
| agents | Cloudflare Agents SDK (McpAgent) |
| @modelcontextprotocol/sdk | MCP SDK |
| zod | スキーマバリデーション |

### ローカルブリッジ (mcp-server/)

| パッケージ | 用途 |
|-----------|------|
| @modelcontextprotocol/sdk | MCP SDK（`Server` クラス直接使用） |

Node.js >= 18.0.0 が必要。

## CI/CD

### テスト（CI）

| トリガー | ジョブ | 内容 |
|---------|--------|------|
| PR to main / push to main | test | Node.js syntax check |

### デプロイ（CD）

| トリガー | ジョブ | 内容 |
|---------|--------|------|
| release published | build-mcpb | `mcpb pack` で .mcpb 生成 |
| release published | attach-mcpb | `gh release upload` で .mcpb をリリースに添付（build-mcpb 後） |
| release published | npm-publish | npm レジストリに公開 |

リリースフロー:
1. AI が `gh release create` でリリースを作成する（PAT 経由で release イベントが発火する）
2. Release published イベントで CD ワークフローが発火: .mcpb 生成 → .mcpb リリース添付 → npm publish
3. npm publish 時にリリースタグ名から自動でバージョンを同期する（package.json の手動更新不要）
4. プレリリースタグ（`-` を含む）は `next` dist-tag で公開、正式リリースは `latest` で公開

注意: GITHUB_TOKEN で作成されたリリースは release イベントを発火しない（GitHub Actions の制限）。
そのため AI が PAT 認証済み gh CLI でリリースを作成する運用とする。

manifest.json のバージョンも一致させる。

## Infrastructure

| コンポーネント | 用途 |
|---------------|------|
| Cloudflare Worker | webhook 受信 + MCP サーバー |
| Cloudflare Durable Objects | イベント永続化 (SQLite) + WebSocket/SSE |
| GitHub Webhook | イベント送信元 |
| MCPB | Claude Desktop 向けローカルブリッジ配布 |
| npx | CLI/Codex 向けローカルブリッジ配布 |

## Files

| パス | 用途 |
|-----|------|
| `worker/src/index.ts` | Cloudflare Worker エントリポイント |
| `worker/src/agent.ts` | WebhookMcpAgent DO（MCP ツール定義、テナント別インスタンス） |
| `worker/src/store.ts` | WebhookStore DO（SQLite + SSE、テナント別インスタンス） |
| `worker/src/tenant.ts` | TenantRegistry DO（installation-account マッピング、クォータ管理） |
| `worker/wrangler.toml` | Worker デプロイ設定 |
| `shared/src/types.ts` | 共有型定義 |
| `shared/src/summarize.ts` | イベントサマリー生成 |
| `local-mcp/src/index.ts` | ローカルブリッジ（TypeScript、開発用） |
| `mcp-server/server/index.js` | ローカルブリッジ（JS、.mcpb 配布用） |
| `mcp-server/manifest.json` | MCPB マニフェスト |
| `mcp-server/package.json` | npm パッケージ定義 |
