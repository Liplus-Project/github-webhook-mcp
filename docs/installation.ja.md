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

### 初回認証（Web OAuth）

v0.11.1 以降、MCP クライアントは **Worker-hosted web OAuth flow** で認証します。GitHub 標準のログイン + 2FA（Google Authenticator など見慣れた UX）がそのまま使えます。初回のツール呼び出し時に以下が同時に起きます:

1. **ブラウザが自動で開きます**（`https://<worker>/oauth/authorize?client_id=...&state=...` → GitHub のログイン画面に 302 リダイレクト）
2. **ツール呼び出しの応答として authorize URL が即座に返ります**（ポーリングの完了を待たず、すぐ retry できる）

Claude Code / Claude Desktop のチャット上には、おおよそ次のような応答が表示されます:

```
OAuth authorization required.

Open this URL in your browser: https://github-webhook.smgjp.com/oauth/authorize?client_id=abc&state=xyz

This link is valid for about 10 minutes.
A browser window should have opened automatically. Sign in on GitHub, then retry the same tool call — subsequent calls will succeed once authorization completes.
```

ブラウザで GitHub にサインインして承認すると、Worker が `/oauth/callback` を受けて「Authorization complete」ページを返します（タブは閉じて構いません）。ローカルブリッジのバックグラウンドポーリングがトークンを受け取り、`~/.github-webhook-mcp/oauth-tokens.json` に保存します。その後同じツールを呼び直すと通常どおり結果が返ります。以降の起動では保存済みトークンが再利用され、期限切れ前に自動でリフレッシュされます。

並行して、stderr ログにも同じ情報が出力されます（ログを見たい場合のフォールバック）:

```
[github-webhook-mcp] OAuth authorization required.
[github-webhook-mcp] Opening: https://github-webhook.smgjp.com/oauth/authorize?client_id=abc&state=xyz
[github-webhook-mcp] Approve in the browser window; the tab can be closed when done.
[github-webhook-mcp] Waiting for approval (state expires in 600s)...
```

> **ブラウザ自動オープンが失敗した場合:** 応答と stderr ログに URL がそのまま残るので、手動でコピーしてブラウザに貼り付けてください。Windows では `start`、macOS では `open`、Linux では `xdg-open` を使用します。

> **v0.11.2 Windows hotfix:** v0.11.1 の Windows 版はブラウザ自動オープン時に authorize URL を cmd.exe にクォート無しで渡していたため、URL に含まれる `&` が command separator として解釈され、`state` パラメータが欠落して `/oauth/authorize` が 400 を返していました。v0.11.2 では URL を `"..."` で囲んで shell 経由で起動するようにしたので、`&` がリテラル扱いされ state が正しくブラウザに届きます。v0.11.1 で自動オープンが機能しなかった Windows ユーザーは v0.11.2 に更新してください（手動 URL コピーは引き続きフォールバックとして動作します）。

> **旧バージョンからの移行:** v0.11.0 以前（localhost callback flow / device flow どちらも）の `~/.github-webhook-mcp/oauth-tokens.json` は flow marker が一致しないため自動で無視され、初回ツール呼び出し時に新しい web OAuth flow で再認証が走ります。特別な手作業は不要です。

### Claude Desktop — デスクトップ拡張 (.mcpb)

[Releases](https://github.com/Liplus-Project/github-webhook-mcp/releases) から `github-webhook-mcp.mcpb` をダウンロード:

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
      "alwaysLoad": true,
      "env": {
        "WEBHOOK_WORKER_URL": "https://github-webhook-mcp.example.workers.dev",
        "WEBHOOK_CHANNEL": "1"
      }
    }
  }
}
```

`WEBHOOK_CHANNEL=1` でリアルタイムチャンネル通知を有効化（Claude Code CLI のみ）。

`alwaysLoad: true` は Claude Code v2.1.121 以降で利用可能。本サーバーのツールを tool-search の deferral 対象から外し、毎ターン即座に利用可能にします（UserPromptSubmit hook 経由で毎ターン呼ばれるため推奨）。

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

v0.11.1 以降、OAuth は **Worker-hosted web flow** で動作します。ローカル MCP クライアントは localhost callback ポートに依存せず、GitHub の redirect_uri は Worker 自身に固定されます。

1. **Callback URL** に `https://<your-worker>/oauth/callback` を登録してください（必須）
   - 例: `https://github-webhook-mcp.example.workers.dev/oauth/callback`
   - カスタムドメインを使う場合はそのドメインの `/oauth/callback` を登録
   - 複数 URL に対応している GitHub App 設定（Multiple callback URLs 等）を利用する場合は、利用者が実際にアクセスする Worker URL をすべて列挙
2. **"Enable Device Flow"** は **OFF のままで構いません**（v0.11.1 では使用しません）
3. Client ID と Client Secret を生成・メモしてください（ステップ 5 で使用）
4. **Client secret は必須です**（Worker が confidential client として GitHub に code→token 交換を行うため）

> **重要:** v0.10.x 以前（localhost callback flow）や v0.11.0（device flow）から移行するユーザーは、初回接続時に自動的に web flow で再認証が要求されます（`~/.github-webhook-mcp/oauth-tokens.json` の旧ファイルは flow marker が一致しないため無視されます）。Claude Code のチャット応答または stderr に表示される authorize URL を開いて GitHub にサインインしてください。

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

# GitHub App の Client ID（web OAuth で必須）
npx wrangler secret put GITHUB_CLIENT_ID

# GitHub App の Client Secret（web OAuth で必須 — Worker が confidential client として code→token 交換を行う）
npx wrangler secret put GITHUB_CLIENT_SECRET
```

各コマンドでプロンプトが表示されるので、対応する値を入力してください。

> **注意:** `GITHUB_CLIENT_SECRET` は Worker の `/oauth/callback` が GitHub に authorization code を提示する際に使用されます。空欄・未登録だと callback 交換が失敗するので必ず設定してください。

### 6. カスタムドメイン（オプション）

デフォルトの `*.workers.dev` URL の代わりにカスタムドメインを使用するには:

1. Cloudflare ダッシュボード → **Workers & Pages** → Worker → **Settings** → **Domains & Routes**
2. カスタムドメインを追加（例: `github-webhook.example.com`）
3. GitHub App の Webhook URL をカスタムドメインに更新
4. GitHub App の Callback URL をカスタムドメインの `/oauth/callback` に更新（例: `https://github-webhook.example.com/oauth/callback`）
5. MCP クライアント設定の `WEBHOOK_WORKER_URL` を更新

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

ローカル MCP ブリッジは Claude Code の `claude/channel` 機能をサポートしています。有効にすると、新しい Webhook イベントが SSE 経由でリアルタイムにセッションにプッシュされます。Claude Code CLI でのみ利用可能です。

MCP クライアント設定で `WEBHOOK_CHANNEL=1` を設定し（上記 [Claude Code CLI](#claude-code-cli--npx) 参照）、チャンネルをロード:

```bash
claude --dangerously-load-development-channels server:github-webhook-mcp
```

### デプロイの確認

デプロイ後、以下で動作確認できます:

1. **Webhook 受信テスト:** GitHub App の設定ページ → **Advanced** → **Recent Deliveries** で配信状況を確認
2. **MCP 接続テスト:** MCP クライアントから `get_pending_status` ツールを呼び出して応答を確認
3. **SSE テスト:** `curl -N https://<your-worker>/events` でストリーム接続を確認

### トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| Webhook が 403 を返す | `GITHUB_WEBHOOK_SECRET` が GitHub App の設定と一致していない。両方の値を確認 |
| Webhook が 429 を返す | テナントクォータ（デフォルト 10,000 イベント）を超過。古いイベントを `mark_processed` で処理 |
| `/oauth/callback` で「Authorization failed」が出る | GitHub App の Callback URL に `https://<your-worker>/oauth/callback` が登録されていない、または `GITHUB_CLIENT_SECRET` が未設定 / 不一致。ステップ 4 と 5 を確認 |
| ブラウザで GitHub のログイン画面が表示されない | Worker の `/oauth/authorize` にアクセスできているか確認（`https://<your-worker>/oauth/authorize?client_id=...&state=...` を直接開くと 302 redirect で `github.com/login/oauth/authorize` に飛ぶはず） |
| Claude Code のログに authorize URL が表示されない | stderr の出力を確認。`[github-webhook-mcp] OAuth authorization required.` のセクションに `Opening: https://<worker>/oauth/authorize?...` が出力されているはず |
| `~/.github-webhook-mcp/oauth-tokens.json` が無視される | v0.11.1 に更新した際、flow marker が `web` でない旧ファイル（localhost flow / device flow）は自動で無視されます。ブラウザで authorize URL を開いて再認証してください |
| KV エラーが出る | `wrangler.toml` の KV ID が `wrangler kv namespace create` の出力と一致しているか確認 |
| MCP ツールが応答しない | Worker がデプロイされているか `wrangler tail` でログを確認 |
