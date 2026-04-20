# インストール

## クイックスタート

プレビューインスタンスを使えばすぐに試せます:

1. [GitHub Webhook MCP](https://github.com/apps/liplus-webhook-mcp) アプリを GitHub アカウントまたは Organization にインストール
2. MCP クライアントを設定（下記 [MCP クライアント設定](#mcp-クライアント設定) 参照）:
   - Worker URL: `https://github-webhook.smgjp.com`
3. Webhook 通知の受信を開始

> **注意:** `github-webhook.smgjp.com` のプレビューインスタンスは評価目的で提供されています。SLA はなく、予告なく変更・停止される場合があります。本番利用の場合は [セルフホスティングガイド](#セルフホスティングガイド) をご覧ください。

## MCP クライアント設定

> **前提:** Node.js 18+ が必要です（ローカル MCP ブリッジの実行に使用）。

### 初回認証（OAuth Device Flow）

v0.11.0 以降、MCP クライアントは **OAuth 2.1 Device Authorization Grant (RFC 8628)** で認証します。初回接続時に以下のメッセージが Claude Code の stderr ログに出力されます:

```
[github-webhook-mcp] OAuth device authorization required.
[github-webhook-mcp] Visit: https://github.com/login/device
[github-webhook-mcp] Enter code: WDJB-MJHT
[github-webhook-mcp] Or open directly: https://github.com/login/device?user_code=WDJB-MJHT
[github-webhook-mcp] Waiting for approval (expires in 600s)...
```

ブラウザで `https://github.com/login/device` を開き、表示された 8 文字の `user_code` を入力してください。承認後、自動的にトークンが発行され、`~/.github-webhook-mcp/oauth-tokens.json` に保存されます。以降の起動では保存済みトークンが再利用され、期限切れ前に自動でリフレッシュされます。

> **旧バージョンからの移行:** v0.10.x 以前の localhost callback flow を使っていた場合、初回起動時に旧トークンファイルが自動削除され、migration 通知が stderr に出力されます。表示される device code を入力して一度だけ再認証してください。

### Claude Desktop — デスクトップ拡張 (.mcpb)

[Releases](https://github.com/Liplus-Project/github-webhook-mcp/releases) から `mcp-server.mcpb` をダウンロード:

1. Claude Desktop → **設定** → **拡張機能** → **拡張機能をインストール...**
2. `.mcpb` ファイルを選択
3. Worker URL を入力（例: `https://github-webhook-mcp.example.workers.dev`）

### Claude Code CLI — npx

```json
{
  "mcpServers": {
    "github-webhook-mcp": {
      "command": "npx",
      "args": ["github-webhook-mcp"],
      "env": {
        "WEBHOOK_WORKER_URL": "https://github-webhook-mcp.example.workers.dev",
        "WEBHOOK_CHANNEL": "1"
      }
    }
  }
}
```

`WEBHOOK_CHANNEL=1` でリアルタイムチャンネル通知を有効化（Claude Code CLI のみ）。

### Codex — config.toml

```toml
[mcp.github-webhook-mcp]
command = "npx"
args = ["github-webhook-mcp"]

[mcp.github-webhook-mcp.env]
WEBHOOK_WORKER_URL = "https://github-webhook-mcp.example.workers.dev"
WEBHOOK_CHANNEL = "0"
```

## セルフホスティングガイド

独自の Cloudflare Worker インスタンスをデプロイして、Webhook 処理とデータを完全に管理できます。

### 前提条件

| 要件 | 用途 |
|------|------|
| **Cloudflare アカウント** | Worker、Durable Object、KV のホスティング |
| **GitHub アカウント** | リポジトリの Fork と GitHub App の作成 |

### 1. リポジトリの Fork

[github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) リポジトリを自分の GitHub アカウントに Fork してください。

### 2. Cloudflare Workers & Pages でプロジェクト作成

Cloudflare ダッシュボードから Worker を作成し、GitHub リポジトリと接続します:

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にログイン
2. **Workers & Pages** → **Create** → **Import a repository** を選択
3. GitHub アカウントを接続し、Fork したリポジトリを選択
4. ビルド設定を構成:

| 項目 | 値 |
|------|-----|
| **Worker name** | `github-webhook-mcp`（`wrangler.toml` の `name` と一致させること） |
| **Root directory** | `worker`（モノレポのため、Worker ソースのあるディレクトリを指定） |
| **Build command** | `npm install && npx wrangler deploy` |

5. **Save and Deploy** を選択

> **重要:** Worker 名は `wrangler.toml` の `name` フィールドと一致させる必要があります。不一致の場合ビルドが失敗します。

デプロイが成功すると Worker URL が表示されます（例: `https://github-webhook-mcp.example.workers.dev`）。この URL を以降の手順で使用します。

接続後は、リポジトリへの push で自動デプロイが行われます。

デプロイにより以下が自動的に作成されます:
- **WebhookMcpAgent** Durable Object — MCP ツール提供（テナント別）
- **WebhookStore** Durable Object — イベント永続化（テナント別）
- **TenantRegistry** Durable Object — テナント管理（単一インスタンス）
- SQLite マイグレーションが自動適用

### 3. KV Namespace の作成

OAuth トークンの保存に使用する KV Namespace を作成します。
Cloudflare ダッシュボードから作成する方法と、wrangler CLI で作成する方法があります。

**ダッシュボードの場合:**

1. **Workers & Pages** → **KV** → **Create a namespace**
2. Namespace 名に `OAUTH_KV` と入力して作成
3. 作成後に表示される Namespace ID をメモ

**wrangler CLI の場合:**

```bash
cd worker
npx wrangler kv namespace create OAUTH_KV
```

いずれの方法でも、出力される KV Namespace ID を `wrangler.toml` の `PLACEHOLDER_KV_ID` に設定します:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<ここに KV Namespace ID を貼り付け>"
```

変更をコミット・push すると、自動デプロイで KV バインディングが反映されます。

### 4. GitHub App の作成と設定

**GitHub Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App** で新規作成:

#### 基本設定

| 項目 | 値 |
|------|-----|
| **App name** | 任意（例: `My Webhook MCP`） |
| **Homepage URL** | Worker URL または リポジトリ URL |
| **Webhook URL** | `https://<your-worker>/webhooks/github` |
| **Webhook secret** | 強力なランダム文字列（ステップ 5 で同じ値を設定） |
| **Content type** | `application/json`（必須） |

#### OAuth 設定（MCP リモート接続に必要）

v0.11.0 以降、OAuth は **Device Authorization Grant (RFC 8628)** で動作します。ローカル MCP クライアントは localhost callback ポートに依存しません。

1. **Identifying and authorizing users** セクションで **"Enable Device Flow"** チェックボックスを **ON** にする（必須）
   - 未有効の場合、Worker の `/oauth/device_authorization` が `503 device_flow_disabled` を返し、MCP クライアントが認証できません
2. **Callback URL** は **空欄のままで構いません**（device flow では使用されない。旧フローとの後方互換のため任意のダミー URL を入れてもよい）
3. Client ID を生成・メモしてください（ステップ 5 で使用）
4. **Client secret は不要です**（device flow の public client として動作するため）
   - 既存 App で secret を発行済みの場合はそのままでも問題ありません（未使用のまま）

> **重要:** v0.11.0 より前の localhost callback flow から移行するユーザーは、初回接続時に自動的に device flow で再認証が要求されます（`~/.github-webhook-mcp/oauth-tokens.json` の旧ファイルは自動で破棄され、stderr に移行通知が出力されます）。Claude Code のログで `https://github.com/login/device` の案内と `user_code` を確認して入力してください。

#### パーミッション

受信したいイベントに応じて設定:

| カテゴリ | パーミッション | 用途 |
|---------|-------------|------|
| **Issues** | Read | Issue イベント |
| **Pull requests** | Read | PR イベント |
| **Contents** | Read | Push イベント |
| **Checks** | Read | Check run イベント |
| **Actions** | Read | Workflow run イベント |
| **Discussions** | Read | Discussion イベント |

#### イベント購読

監視したいイベントにチェック:
- Issues / Issue comment
- Pull request / Pull request review / Pull request review comment / Pull request review thread
- Push
- Check run / Workflow run
- Discussion / Discussion comment

#### インストール

作成後、アプリをアカウントまたは Organization にインストールし、監視するリポジトリを選択してください。

> **重要:** 同じエンドポイントに別途リポジトリ Webhook を作成しないでください。GitHub App がすべての Webhook 配信を処理します。リポジトリ Webhook を追加すると重複や不正なリクエストが発生します。

### 5. シークレットの設定

必要なシークレットを Cloudflare に登録。ダッシュボードの **Workers & Pages** → Worker → **Settings** → **Variables and Secrets** から設定するか、wrangler CLI で設定します:

```bash
# GitHub App の Webhook secret（必須）
npx wrangler secret put GITHUB_WEBHOOK_SECRET

# GitHub App の Client ID（device flow で必須）
npx wrangler secret put GITHUB_CLIENT_ID

# GitHub App の Client Secret（device flow では未使用だが、upstream API が
# 将来 confidential client に変わった場合に備えて設定を残してあります）
npx wrangler secret put GITHUB_CLIENT_SECRET
```

各コマンドでプロンプトが表示されるので、対応する値を入力してください。

> **注意:** device flow の public client として動作するため `GITHUB_CLIENT_SECRET` は実際の認証には使用されません。未登録でも認証は成立しますが、互換性のためダミー値（例: `unused`）を入れておくことを推奨します。

### 6. カスタムドメイン（オプション）

デフォルトの `*.workers.dev` URL の代わりにカスタムドメインを使用するには:

1. Cloudflare ダッシュボード → **Workers & Pages** → Worker → **Settings** → **Domains & Routes**
2. カスタムドメインを追加（例: `github-webhook.example.com`）
3. GitHub App の Webhook URL をカスタムドメインに更新（device flow は Callback URL 不要）
4. MCP クライアント設定の `WEBHOOK_WORKER_URL` を更新

### 7. WAF ルール（推奨）

Cloudflare WAF でセキュリティルールを設定すると、Worker 到達前に不正リクエストをブロックでき、CPU 課金を削減できます。

#### GitHub IP 制限

Webhook エンドポイントへのアクセスを GitHub の IP 範囲に制限:

- **対象パス:** `/webhooks/github`
- **条件:** `(http.request.uri.path eq "/webhooks/github") and not (ip.src in { 140.82.112.0/20 185.199.108.0/22 192.30.252.0/22 143.55.64.0/20 })`
- **アクション:** Block

> **注意:** GitHub の IP 範囲は変更される場合があります。最新の情報は `https://api.github.com/meta` の `hooks` フィールドで確認してください。

#### レートリミット

- **Webhook:** 300 req/min per IP（`/webhooks/github`）
- **API:** 120 req/min per IP（`/mcp`, `/events`）

### 8. チャンネル通知（オプション）

ローカル MCP ブリッジは Claude Code の `claude/channel` 機能をサポートしています。有効にすると、新しい Webhook イベントが WebSocket 経由でリアルタイムにセッションにプッシュされます。Claude Code CLI でのみ利用可能です。

MCP クライアント設定で `WEBHOOK_CHANNEL=1` を設定し（上記 [Claude Code CLI](#claude-code-cli--npx) 参照）、チャンネルをロード:

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```

### デプロイの確認

デプロイ後、以下で動作確認できます:

1. **Webhook 受信テスト:** GitHub App の設定ページ → **Advanced** → **Recent Deliveries** で配信状況を確認
2. **MCP 接続テスト:** MCP クライアントから `get_pending_status` ツールを呼び出して応答を確認
3. **WebSocket テスト:** `wscat -c wss://<your-worker>/events` でストリーム接続を確認（SSE: `curl -N https://<your-worker>/events`）

### トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| Webhook が 403 を返す | `GITHUB_WEBHOOK_SECRET` が GitHub App の設定と一致していない。両方の値を確認 |
| Webhook が 429 を返す | テナントクォータ（デフォルト 10,000 イベント）を超過。古いイベントを `mark_processed` で処理 |
| `/oauth/device_authorization` が 503 を返す | GitHub App で **"Enable Device Flow"** が有効になっていない。ステップ 4 の OAuth 設定で再確認 |
| `/oauth/authorize` / `/oauth/callback` が 410 Gone を返す | v0.10.x 以前のクライアントが使っていた旧エンドポイント。MCP クライアントを最新版に更新してください（新クライアントは自動的に device flow にフォールバック） |
| Claude Code のログに device code が表示されない | stderr の出力を確認。`[github-webhook-mcp] OAuth device authorization required.` のセクションに `user_code` と `https://github.com/login/device` が出力されているはず |
| `~/.github-webhook-mcp/oauth-tokens.json` が消えた | v0.11.0 移行時に旧フローのトークンが自動削除された正常動作。device flow で再認証してください |
| KV エラーが出る | `wrangler.toml` の KV ID が `wrangler kv namespace create` の出力と一致しているか確認 |
| MCP ツールが応答しない | Worker がデプロイされているか `wrangler tail` でログを確認 |
