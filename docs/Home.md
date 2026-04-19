# github-webhook-mcp

Cloudflare Worker + Durable Object による、リアルタイム GitHub Webhook 通知を AI エージェントに MCP 経由で提供します。

## アーキテクチャ

```
GitHub --POST--> Cloudflare Worker --> Durable Object (SQLite)
                                           |
                                           +-- MCP tools (Streamable HTTP)
                                           +-- SSE real-time stream
                                           |
                          +----------------+
                          |
     Desktop / Codex: .mcpb local bridge --> polling via MCP tools
     Claude Code CLI: .mcpb local bridge --> SSE -> channel notifications
```

- **Cloudflare Worker** が GitHub Webhook を受信し、署名を検証し、Durable Object の SQLite にイベントを保存します。
- **ローカル MCP ブリッジ** (.mcpb) は Worker へのツール呼び出しをプロキシし、オプションで SSE を使ったリアルタイムチャンネル通知をリッスンします。
- ローカル Webhook レシーバーやトンネルは不要です。

## はじめに

### 1. GitHub App のインストール

**GitHub Webhook MCP** アプリを GitHub Organization またはアカウントにインストール:

1. [GitHub App インストールページ](https://github.com/apps/liplus-webhook-mcp) にアクセス
2. インストール先の Organization またはアカウントを選択
3. アクセスを許可するリポジトリを選択（または全リポジトリ）
4. 要求されたパーミッションを承認

> **注意:** アップデート後にアプリが新しいパーミッションを要求した場合、GitHub 通知またはアプリのインストール設定で承認する必要があります。パーミッションが承認されるまで Webhook は配信されません。

> **重要:** 同じエンドポイントに別途リポジトリ Webhook を作成しないでください。GitHub App がすべての Webhook 配信を処理します。

### 2. MCP クライアントの設定

[[インストールガイド|installation.ja]] に進んで、AI アシスタントを Webhook サービスに接続してください。

## インストール

[[インストールガイド|installation.ja]] で完全なセットアップガイドを参照:

- **クイックスタート** — プレビューインスタンスを使用
- **MCP クライアント設定** — Claude Desktop、Claude Code CLI、Codex 向け
- **セルフホスティングガイド** — Cloudflare Workers デプロイ

## MCP ツール

| ツール | 説明 |
|--------|------|
| `get_pending_status` | 未処理イベント数のタイプ別軽量スナップショット |
| `list_pending_events` | 未処理イベントのサマリー（フルペイロードなし） |
| `get_event` | ID 指定で単一イベントのフルペイロード取得 |
| `get_webhook_events` | 全未処理イベントのフルペイロード取得 |
| `mark_processed` | イベントを処理済みにマーク |

## モノレポ構成

```
worker/       — Cloudflare Worker + Durable Objects
local-mcp/    — ローカル stdio MCP ブリッジ（TypeScript、開発用）
mcp-server/   — Claude Desktop 用 .mcpb パッケージ
shared/       — 共有型・ユーティリティ
```

## プライバシーポリシー

イベントは Cloudflare Durable Object（エッジストレージ）に保存されます。ローカル MCP ブリッジは Worker へのツール呼び出しをプロキシするのみで、イベントデータをローカルに保存しません。

- 拡張機能プライバシーポリシー: https://smgjp.com/privacy-policy-github-webhook-mcp/

## サポート

- GitHub Issues: https://github.com/Liplus-Project/github-webhook-mcp/issues
- [[要件仕様|0-requirements.ja]]

## 関連プロジェクト

- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ 言語仕様

---

## Pages

- Installation: [[EN|installation]] / [[JA|installation.ja]]
- Requirements: [[EN|0-requirements]] / [[JA|0-requirements.ja]]
