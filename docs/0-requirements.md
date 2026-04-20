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
                  ├── /mcp (Streamable HTTP)     ├── WebSocket / SSE real-time stream
                  │    WebhookMcpAgent DO        └── REST endpoints
                  │    [per-tenant]                   /pending-status
                  │    └── tools → WebhookStore       /pending-events
                  │                                   /webhook-events
                  ├── /events (WebSocket/SSE)          /event
                  │    └── WebhookStore DO             /mark-processed
                  │
                  ├── /oauth/authorize ──▶ github.com/login/oauth/authorize
                  ├── /oauth/callback  ◀── github.com redirect_uri (Worker-hosted)
                  ├── /oauth/token (web_authorization_poll, refresh_token)
                  │
                  └── /webhooks/github (POST)
                       └── TenantRegistry → WebhookStore DO /ingest

                          ┌─────────────────────────────┐
                          │  Local MCP Bridge (.mcpb)    │
                          │  stdio ← Claude Desktop/CLI  │
                          │  → proxy tool calls to /mcp  │
                          │  → WebSocket listener → channel │
                          │  → browser: /oauth/authorize  │
                          │  → poll:    /oauth/token      │
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

### F7. OAuth 認証（Worker-hosted web OAuth）

Worker は GitHub の web OAuth flow をホストする独自実装を備える（v0.11.0 の device authorization grant は v0.11.1 で撤去。GitHub 標準のログイン + 2FA UX に回帰しつつ、v0.10.x の chronic auth loop 原因である localhost callback 依存と refresh rotation desync を構造的に解消する）。

| ID | 要件 |
|----|------|
| F7.1 | `GET /.well-known/oauth-authorization-server` で RFC 8414 メタデータを返す（`authorization_endpoint` / `token_endpoint` / `grant_types_supported=[urn:ietf:params:oauth:grant-type:web_authorization_poll, refresh_token]`） |
| F7.2 | `POST /oauth/register` で RFC 7591 dynamic client registration を行う（public client、secret 発行なし） |
| F7.3 | `GET /oauth/authorize?client_id=<cid>&state=<state>[&scope=...]` で `web_auth_state:{state}` レコードを `pending` として作成し、`redirect_uri=https://<worker>/oauth/callback` を固定して `https://github.com/login/oauth/authorize` に 302 リダイレクトする |
| F7.4 | `GET /oauth/callback?code=<gh_code>&state=<state>` で GitHub authorization code を confidential client として access token に交換し、`fetchGitHubProps()` で user profile + installations を取得、Worker 独自 bearer token pair を発行して `web_auth_state` を `approved` に遷移させる。ユーザにはタブを閉じるよう案内する HTML を返す |
| F7.5 | `POST /oauth/token` で `grant_type=urn:ietf:params:oauth:grant-type:web_authorization_poll` を処理する。`pending` → `400 authorization_pending`、`approved` → `200` で bearer pair を返し state レコードを消費、`denied` → `400 access_denied`、期限切れ → `400 expired_token`（RFC 8628 §3.5 のエラー形式を再利用） |
| F7.6 | `POST /oauth/token` で `grant_type=refresh_token` を処理し、access token と refresh token を rotate する（ブリッジ側 RC1 修正と組み合わせて desync を解消） |
| F7.7 | 保護対象 API ルート（`/mcp`, `/events`）は `Authorization: Bearer <access_token>` ヘッダによる独自 token 検証 middleware で認可する |
| F7.8 | KV schema は自前設計: `client:{client_id}` / `web_auth_state:{state}` / `token:{access_token}` / `refresh:{refresh_token}` / `grant:{grant_id}`。device flow 時代の `device:` / `user_code:` キーは撤去 |
| F7.9 | ローカルブリッジは authorize URL を platform 既定のブラウザで自動オープンする。Windows は `cmd /c start`、macOS は `open`、Linux は `xdg-open` を使う。オープン失敗は fatal にしない（stderr に警告を残し、URL は応答と stderr で伝える） |
| F7.10 | ローカルブリッジは初回ツール呼び出しで web flow が完了していない場合、polling をバックグラウンドに維持したまま、authorize URL と残り有効秒数を本文に含む `isError: true` の構造化ツール応答を即座に返す。2 回目以降の同一ツール呼び出しは、承認完了なら通常処理、未完了なら同じ auth-required 応答を返す（ポーリングは 1 本に serialize） |
| F7.11 | ローカルブリッジは refresh 時に `invalid_grant` を受けた場合、直ちに全面 re-auth に遷移せず tokens file を再読み込みする。別プロセスが既に rotation を完了していれば、その最新 refresh_token を採用して再試行する（RC1: refresh desync の最小 fix。file lock は導入しない） |

**GitHub App 前提条件:**

- 使用する upstream endpoint: `https://github.com/login/oauth/authorize`（web）, `POST https://github.com/login/oauth/access_token`
- GitHub App の設定で `redirect_uri = https://<worker>/oauth/callback` を登録する必要がある（smgjp.com プレビュー + self-host 例示）

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
| N2.5 | 認証方式 | Worker 自前認証 | Cloudflare Access は使用しない。Worker が webhook secret + Worker-hosted web OAuth で認証を処理する |
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
| N3.4 | Web OAuth callback 処理時に `GET /user/installations` で取得した accessible_account_ids（ユーザー + org）を GitHubUserProps に保存し、McpAgent が複数 store を並列クエリして結果をマージする。これにより org インストールのイベントもメンバーの MCP セッションから参照できる |
| N3.2 | WebSocket / SSE 接続は DO のメモリ内で管理される（DO eviction 時に切断） |
| N3.3 | ローカルブリッジはツール呼び出しごとに Worker セッションを再利用する（セッション失効時は自動リトライ） |

## Dependencies

### Cloudflare Worker

| パッケージ | 用途 |
|-----------|------|
| agents | Cloudflare Agents SDK (McpAgent) |
| @modelcontextprotocol/sdk | MCP SDK |
| zod | スキーマバリデーション |

OAuth 実装は自前（`worker/src/oauth.ts` + `worker/src/oauth-store.ts`）。`@cloudflare/workers-oauth-provider` は v0.11.0 で撤去済み。v0.11.1 で Worker-hosted web OAuth に切り替え（device authorization grant は撤去）。

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

## Distribution Channels

| チャネル | 用途 | ステータス | 要件 |
|---------|------|-----------|------|
| Anthropic Desktop Extensions Directory | Claude Desktop ローカル mcpb 配布 | 申請済み（2026-04-02） | 公開 GitHub リポジトリ、Node.js、manifest.json、推奨 MIT ライセンス |
| Anthropic Remote MCP Server Directory | リモート MCP サーバー配布 | 未申請 | OAuth 2.0、HTTPS、ツール安全性アノテーション |
| npm レジストリ | CLI / Codex 向け npx 配布 | 稼働中 | npm publish（CD で自動公開） |
| MCP Community Registry (registry.modelcontextprotocol.io) | コミュニティ発見チャネル | 将来 | 未定 |

申請フォーム:
- Desktop Extensions: [MCPB Desktop Extensions Submission Form](https://forms.gle/mcpb-desktop-extensions)
- Remote MCP Server: [Remote MCP Server Submission Form](https://forms.gle/remote-mcp-server)

各チャネルの申請経緯と詳細ステータスは tips issue #175 を参照。

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
| `worker/src/oauth.ts` | Worker-hosted web OAuth 自前実装（metadata / register / authorize / callback / token / 独自 token 検証 middleware） |
| `worker/src/oauth-store.ts` | OAuth KV schema helper（client / web_auth_state / token / refresh / grant レコード操作） |
| `worker/wrangler.toml` | Worker デプロイ設定 |
| `shared/src/types.ts` | 共有型定義 |
| `shared/src/summarize.ts` | イベントサマリー生成 |
| `local-mcp/src/index.ts` | ローカルブリッジ（TypeScript、開発用） |
| `mcp-server/server/index.js` | ローカルブリッジ（JS、.mcpb 配布用） |
| `mcp-server/manifest.json` | MCPB マニフェスト |
| `mcp-server/package.json` | npm パッケージ定義 |
