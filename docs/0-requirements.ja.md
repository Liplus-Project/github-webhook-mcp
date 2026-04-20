# 要件仕様

## 目的

GitHub Webhook イベントを Cloudflare Worker で受信・永続化し、MCP プロトコル経由で AI エージェントに提供する。
エージェントが GitHub の状態変化をリアルタイムに検知し、自律的に対応できるようにする。

## 前提

- GitHub Webhook は Cloudflare Worker に直接到達する（ローカルサーバー不要）
- イベントは Durable Object 内の SQLite に永続化される
- AI エージェントは MCP stdio トランスポート（ローカルブリッジ）または Streamable HTTP（リモート）で接続する
- ローカルブリッジは Worker にツール呼び出しをプロキシし、SSE でリアルタイム通知を中継する

## アーキテクチャ

```
GitHub --POST--> Cloudflare Worker --> TenantRegistry DO
                  | 署名検証                    | installation_id -> account_id
                  | UUID 付与                    |
                  |                             v
                  |                    WebhookStore DO (SQLite) [per-tenant]
                  |                             |
                  +-- /mcp (Streamable HTTP)     +-- SSE real-time stream
                  |    WebhookMcpAgent DO        +-- REST endpoints
                  |    [per-tenant]                   /pending-status
                  |    +-- tools -> WebhookStore       /pending-events
                  |                                    /webhook-events
                  +-- /events (SSE)                    /event
                  |    +-- WebhookStore DO             /mark-processed
                  |
                  +-- /webhooks/github (POST)
                       +-- TenantRegistry -> WebhookStore DO /ingest

                          +-----------------------------+
                          |  Local MCP Bridge (.mcpb)    |
                          |  stdio <- Claude Desktop/CLI |
                          |  -> proxy tool calls to /mcp |
                          |  -> SSE listener -> channel  |
                          +-----------------------------+
```

システムは四つのコンポーネントで構成される:

1. **Cloudflare Worker** — Webhook 受信、署名検証、テナントルーティング
2. **TenantRegistry Durable Object** — installation_id → account_id マッピング管理、テナント単位クォータ管理（単一インスタンス）
3. **WebhookStore Durable Object** — SQLite によるイベント永続化、REST/SSE エンドポイント（テナント別インスタンス: `store-{accountId}`）
4. **WebhookMcpAgent Durable Object** — MCP Streamable HTTP サーバー、ツール定義（テナント別インスタンス: `tenant-{accountId}`）

ローカルブリッジ（mcp-server/）は Worker に対するプロキシであり、データを保持しない。

## 機能要件

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

### F4. SSE リアルタイムイベント配信

| ID | 要件 |
|----|------|
| F4.1 | `GET /events` で SSE ストリームを提供する |
| F4.2 | Webhook ingest 時に接続中の全 SSE クライアントにイベントサマリーをブロードキャストする |
| F4.3 | 30 秒間隔でハートビートを送信する |
| F4.4 | クライアント切断時にクリーンアップする |

### F5. チャンネル通知（ローカルブリッジ）

| ID | 要件 |
|----|------|
| F5.1 | ローカルブリッジが Claude Code の `claude/channel` experimental capability を宣言する |
| F5.2 | Worker の SSE エンドポイントに接続し、新規イベント検出時に `notifications/claude/channel` を送信する |
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

### F7. OAuth 認証（Device Authorization Grant, RFC 8628）

Worker は OAuth 2.1 Device Authorization Grant を自前実装する（`@cloudflare/workers-oauth-provider` は v0.11.0 で撤去）。GitHub App の device flow を upstream として利用し、localhost callback に依存しない。

| ID | 要件 |
|----|------|
| F7.1 | `GET /.well-known/oauth-authorization-server` で RFC 8414 メタデータを返す |
| F7.2 | `POST /oauth/register` で RFC 7591 dynamic client registration を行う（public client、secret 発行なし） |
| F7.3 | `POST /oauth/device_authorization` で GitHub に device code を要求し、RFC 8628 §3.2 形式の JSON（device_code / user_code / verification_uri / verification_uri_complete / expires_in / interval）を返す |
| F7.4 | `POST /oauth/token` で `grant_type=urn:ietf:params:oauth:grant-type:device_code` を処理し、GitHub への polling 結果に応じて `authorization_pending` / `slow_down` / `access_denied` / `expired_token` を RFC 8628 §3.5 準拠で返す |
| F7.5 | `POST /oauth/token` で `grant_type=refresh_token` を処理し、access token と refresh token を rotate する |
| F7.6 | 旧 `GET /oauth/authorize` および `GET /oauth/callback` は **HTTP 410 Gone** を返す（localhost callback flow は v0.11.0 で廃止） |
| F7.7 | 保護対象 API ルート（`/mcp`, `/events`）は `Authorization: Bearer <access_token>` ヘッダによる独自 token 検証 middleware で認可する |
| F7.8 | KV schema は自前設計: `client:{client_id}` / `device:{device_code}` / `user_code:{user_code}` / `token:{access_token}` / `refresh:{refresh_token}` / `grant:{grant_id}` |
| F7.9 | ローカルブリッジは device authorization 応答受信直後に `verification_uri_complete`（なければ `verification_uri`）を platform 既定のブラウザで自動オープンする。Windows は `cmd /c start`、macOS は `open`、Linux は `xdg-open` を使う。オープン失敗は fatal にしない（stderr に警告を残し、URL は応答と stderr で伝える） |
| F7.10 | ローカルブリッジは初回ツール呼び出しで device flow が完了していない場合、polling をバックグラウンドに維持したまま、`user_code` / `verification_uri_complete` / `verification_uri` / 残り有効秒数を本文に含む `isError: true` の構造化ツール応答を即座に返す。2 回目以降の同一ツール呼び出しは、承認完了なら通常処理、未完了なら同じ auth-required 応答を返す（ポーリングは 1 本に serialize） |

**GitHub App 前提条件:**

- GitHub App の設定で **"Enable Device Flow"** を有効化する必要がある（未有効時は `device_flow_disabled` が返る）
- 使用する upstream endpoint: `POST https://github.com/login/device/code`, `POST https://github.com/login/oauth/access_token`

## 非機能要件

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
| N2.5 | 認証方式 | Worker 自前認証 | Cloudflare Access は使用しない。Worker が webhook secret + OAuth Device Authorization Grant (RFC 8628) で認証を処理する |
| N2.6 | プレビューインスタンス | `preview` 環境 | 本番と同一構成の検証用インスタンス |

### N3. 制約

| ID | 制約 |
|----|------|
| N3.1 | WebhookStore / McpAgent DO はテナント別インスタンス（`idFromName("store-{accountId}")` / `getAgentByName("tenant-{accountId}")`）で動作する。TenantRegistry DO は単一インスタンスで全テナントの installation-account マッピングを管理する |
| N3.2 | SSE 接続は DO のメモリ内で管理される（DO eviction 時に切断） |
| N3.3 | ローカルブリッジはツール呼び出しごとに Worker セッションを再利用する（セッション失効時は自動リトライ） |
| N3.4 | Device flow 完了時に `GET /user/installations` で取得した accessible_account_ids（ユーザー + org）を GitHubUserProps に保存し、McpAgent が複数 store を並列クエリして結果をマージする。これにより org インストールのイベントもメンバーの MCP セッションから参照できる |

## CI/CD

### テスト（CI）

| トリガー | ジョブ | 内容 |
|---------|--------|------|
| PR to main / push to main | test | Node.js syntax check |

### リリース（CD）

| トリガー | ジョブ | 内容 |
|---------|--------|------|
| `v*` タグ push | build-mcpb | `mcpb pack` で .mcpb 生成 |
| `v*` タグ push | release | GitHub Release 作成 + .mcpb 添付 |
| `v*` タグ push | npm-publish | npm レジストリに公開 |

リリースフロー:
1. `v*` タグを push する
2. CD が自動実行: .mcpb 生成 → release 作成 → .mcpb 添付 → npm publish
3. npm publish 時にタグ名から自動でバージョンを同期する（package.json の手動更新不要）
4. プレリリースタグ（`-` を含む）は `next` dist-tag で公開、正式リリースは `latest` で公開

## 依存関係

### Cloudflare Worker

| パッケージ | 用途 |
|-----------|------|
| agents | Cloudflare Agents SDK (McpAgent) |
| @modelcontextprotocol/sdk | MCP SDK |
| zod | スキーマバリデーション |

OAuth 実装は自前（`worker/src/oauth.ts` + `worker/src/oauth-store.ts`）。`@cloudflare/workers-oauth-provider` は v0.11.0 で撤去済み（device flow 非対応のため）。

### ローカルブリッジ (mcp-server/)

| パッケージ | 用途 |
|-----------|------|
| @modelcontextprotocol/sdk | MCP SDK（`Server` クラス直接使用） |
| eventsource | SSE クライアント |

Node.js >= 18.0.0 が必要。

## ファイル構成

| パス | 用途 |
|-----|------|
| `worker/src/index.ts` | Cloudflare Worker エントリポイント |
| `worker/src/agent.ts` | WebhookMcpAgent DO（MCP ツール定義、テナント別インスタンス） |
| `worker/src/store.ts` | WebhookStore DO（SQLite + SSE、テナント別インスタンス） |
| `worker/src/tenant.ts` | TenantRegistry DO（installation-account マッピング、クォータ管理） |
| `worker/src/oauth.ts` | OAuth Device Authorization Grant (RFC 8628) 自前実装（metadata / register / device_authorization / token / 独自 token 検証 middleware） |
| `worker/src/oauth-store.ts` | OAuth KV schema helper（client / device / user_code / token / refresh / grant レコード操作） |
| `worker/wrangler.toml` | Worker デプロイ設定 |
| `shared/src/types.ts` | 共有型定義 |
| `shared/src/summarize.ts` | イベントサマリー生成 |
| `local-mcp/src/index.ts` | ローカルブリッジ（TypeScript、開発用） |
| `mcp-server/server/index.js` | ローカルブリッジ（JS、.mcpb 配布用） |
| `mcp-server/manifest.json` | MCPB マニフェスト |
| `mcp-server/package.json` | npm パッケージ定義 |
