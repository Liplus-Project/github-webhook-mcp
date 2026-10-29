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
                  │    createMcpHandler          └── REST endpoints
                  │    [stateless, per-request]       /pending-status
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
4. **ステートレス MCP ハンドラ** — MCP Streamable HTTP サーバー、ツール定義。プロトコル版 2026-07-28 でセッションが消えたため Durable Object ではなく、リクエストごとに `createMcpHandler` が組み立てる（#249）

ローカルブリッジ（mcp-server/）は Worker に対するプロキシであり、データを保持しない。

### プロトコル版と単レーン切替（#249）

Worker は MCP プロトコル版 **2026-07-28（ステートレスコア）のみ**を提供する。`createMcpHandler` に `legacy: "reject"` を渡しており、2025 系のリクエスト（`initialize` を含む）は、この endpoint が提供する唯一の版を名指しした unsupported-protocol-version エラーで返る。

Worker のプロトコル版は、本 repo の 2 成果物（Worker と npx ブリッジ）のあいだの私的な契約である。`mcp-server/server.json` は stdio トランスポートのみを宣言しており、リモートトランスポートの宣言が無いため、第三者クライアントが Worker に直接到達する経路は存在しない。したがって Claude Desktop 側の対応状況は Worker 側移行の条件ではない。ブリッジは二面を持ち、両面は独立している:

| 面 | 実装 | 版 |
|---|---|---|
| Claude Desktop に対してサーバー | SDK v1 stdio（`Server` クラス） | 2025 系 |
| Worker に対してクライアント | SDK v2（`@modelcontextprotocol/client`） | 2026-07-28 に pin |

**互換レーンは実装しない。** 保守されないフォールバック経路は放置されて死にコード化する。畳む条件が観測可能（旧レーンへの到達がゼロになる）であっても、観測できることと観測しに行くことは別であり、運用上その判断は忘れられる。破断の吸収はコードではなく、**minor リリース + README 注意書き**という別チャネルで行う。

非対称の所在: Worker は全員共有の 1 デプロイなので一斉に飛ぶ。ブリッジは利用者ごとで、各自の MCP クライアント再起動で追随する（`@latest` 指定でも起動済みプロセスは古い版を保持する — #247 / #248）。版を固定している外部利用者は再起動しても復旧しない。**この層の切り捨てを受け入れる**というのが本決定である。


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
| F2.4 | `mark_processed` 実行時に、`processed=1` かつ `received_at` が保持期間（`PURGE_AFTER_DAYS` 日、既定 3）より古いイベントを自動削除する。処理済み死蔵行による DO ストレージ肥大を防ぐ（即時性のための補助経路。本質的な保証は F2.5 の Alarm sweep が担う） |
| F2.5 | DO Alarm（`ctx.storage.setAlarm` + `alarm()` ハンドラ）による時間駆動の retention sweep を提供する。sweep は (a) `processed=1` かつ `received_at` が `PURGE_AFTER_DAYS` 日（既定 3）より古い処理済みイベントと、(b) `processed=0` かつ `received_at` が `UNPROCESSED_PURGE_AFTER_DAYS` 日（既定 90）より古い未処理イベントを、まとめて削除する。alarm() は実行後に次回 sweep を再スケジュールし、消費ゼロ（`mark_processed` が一度も呼ばれない放置テナント）でも周期実行（日次）される。未処理保持期間を処理済みより長く取るのは未読データ消失の安全域確保のため（3 日 / 90 日の非対称は意図的）。既知の限界（スコープ外）: 時間窓は「古さ」を縛るが「量」は縛らないため、高頻度 × 無消費テナントは 90 日窓があっても Cloudflare の 1GB/DO 壁に先に到達しうる。量ベース hard cap は別 issue 候補 |

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

ステートレス MCP ハンドラが以下のツールセットを提供する。ローカルブリッジはこれをプロキシする。

| ID | ツール名 | 引数 | 戻り値 | 要件 |
|----|---------|------|--------|------|
| F3.1 | `get_pending_status` | include_intermediate (boolean, default false) | pending_count, latest_received_at, types | 未処理イベントの軽量スナップショットを返す |
| F3.2 | `list_pending_events` | limit (1-100, default 20), include_intermediate (boolean, default false) | サマリー配列 | 未処理イベントのメタデータ一覧を返す（ペイロード含まず） |
| F3.3 | `get_event` | event_id | 完全イベント or error | UUID 指定で完全なペイロードを返す |
| F3.4 | `get_webhook_events` | limit (1-100, default 20) | 未処理イベント配列 | 未処理イベントをフルペイロード付きで返す |
| F3.5 | `mark_processed` | event_id **または** event_ids (1-100) | 単数形: success, event_id, purged／バッチ形: success, marked, failed, results (id 単位の判定), purged | イベントを処理済みにマークし、保持期間超過の処理済みイベントを自動削除する。`purged` は今回削除された件数 |

**Foreground pending filter (#256):** `get_pending_status` と `list_pending_events` は optional boolean `include_intermediate`（既定 `false`）を受け取る。省略/false は `workflow_run` の action が `requested` / `in_progress` と完全一致するイベントだけを除外し、true は従来の全 pending を返す。count・types・latest_received_at・一覧は同じ母集合を使い、各 store で LIMIT より前に絞る。missing/unknown action、completed、check_run、他 type は維持する。保存、ID/raw 取得、mark_processed、WebSocket/SSE 配送、retention は変更しない。通常 hook 整形と observer JSON shape も維持する。

**F3.1 Local bridge shaping:** In normal mode, the local bridge wraps `get_pending_status` results into the Claude Code UserPromptSubmit hook decision JSON shape (`hookSpecificOutput.hookEventName="UserPromptSubmit"` plus a natural-language summary of pending_count / types / latest_received_at in `additionalContext`). This is required so values returned via `type: "mcp_tool"` UserPromptSubmit hooks reach the AI prompt context; manual tool calls receive the same shape. The remote (Worker + DO) return contract is unchanged.

**F3.1 Empty silent (#221):** When `pending_count == 0`, the local bridge returns the remote payload untouched (no wrap). Claude Code silently discards JSON that does not match a decision schema, so hook callers receive nothing in `additionalContext` — eliminating the per-turn empty-reminder noise. Manual tool callers see the raw payload (`{pending_count: 0, types: {}, latest_received_at: null}`) and can interpret it directly.

**F3.1 Observer mode (#260):** `WEBHOOK_OBSERVER=1` を明示したプロセスは、`get_pending_status` の戻り値を hook decision JSON に変換せず、Worker の raw MCP result（text JSON と存在する structuredContent、`pending_count` / `types` / `latest_received_at`）をそのまま返す。`latest_received_at` は未処理イベント内の最新受信時刻であり、全履歴の最終受信時刻ではない。`tools/list` の当該 tool のみ `_meta: {"io.github.Liplus-Project/github-webhook-mcp/pending-status-observer": 1}` を公開する。通常 mode はこの保証を広告せず、既存の hook 整形と empty-silent を維持する。

Observer mode は既存の有効な保存 access token のみ使用する。token が欠落・不正・期限切れ・HTTP 401 または WebSocket 認証拒否なら、UI/登録/refresh/browser/OAuth polling を開始せず `isError: true` と `auth_required` を返す。tool error の text JSON と structuredContent は `{error: "auth_required", message: "Observer mode requires an existing valid token. Authenticate using a separate CLI process, then retry."}` を持つ。各 token 取得で保存ファイルを一度だけ再読し、外部 CLI の login 後に次の呼出しから回復できる。保存期限が省略された既存 token は拒否されるまで利用可能と扱う。認証拒否された同一 token は再利用しない。背景 WebSocket も同じ token gate を通り、認証失敗時は再接続を停止し、次の成功 tool 呼出しで再開する。通知と `get_event` は維持する。status 呼出しは消費/mark_processed を実行せず、認証・通信失敗をゼロ件に変換しない。token はログやエラーへ出さない。Worker API/DB は変更しない。

**F3.5 Batch form (#245):** `mark_processed` accepted exactly one event per call, so consuming the 6-10 self-operation acknowledgement events a single PR generates cost one round trip each. `event_ids: string[]` is added so the round trips collapse while the caller still enumerates ids explicitly (filter-based bulk consumption is deliberately not offered: it can silently consume external events).

- **Backward compatibility:** the existing singular `event_id` call is unchanged, response shape included. It still answers `success: true` for an id that was never ingested.
- **Per-id verdict:** the batch form returns `{event_id, success, error?}` per id. `not found` (no store held that id) is the only value `error` takes at the tool surface — an empty id is rejected by the tool schema before it reaches a store, so it never turns into a misleading `not found`.
- **Partial failure:** one failing id does not fail the call. Marks for the successful ids are already committed, so the caller retries only the failed ids. Partial failure is reported in the body, not as a tool error.
- **Multi-account:** an event lives in exactly one store, so the same batch goes to every accessible store and an id marked by **any** store counts as marked. Only an id missed by every store failed.
- **Purge cadence:** the retention purge runs once per batch call, not once per id.
- **MCP proxy:** the static schemas (`mcp-server/server/index.js` / `local-mcp/src/index.ts`) must be updated. A new param is not picked up by reconnecting; the npm package has to be republished.

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
| 4 | 処理完了後 `mark_processed` でマーク。複数件をまとめて処理した場合は `event_ids` で 1 呼び出しに畳む |

### F7. OAuth 認証（Worker-hosted web OAuth）

Worker は GitHub の web OAuth flow をホストする独自実装を備える（v0.11.0 の device authorization grant は v0.11.1 で撤去。GitHub 標準のログイン + 2FA UX に回帰しつつ、v0.10.x の chronic auth loop 原因である localhost callback 依存と refresh rotation desync を構造的に解消する）。

| ID | 要件 |
|----|------|
| F7.1 | `GET /.well-known/oauth-authorization-server` で RFC 8414 メタデータを返す（`issuer` / `authorization_endpoint` / `token_endpoint` / `registration_endpoint` / `client_id_metadata_document_supported=true` / `grant_types_supported=[urn:ietf:params:oauth:grant-type:web_authorization_poll, refresh_token]`） |
| F7.2 | `POST /oauth/register` で RFC 7591 dynamic client registration を行う（public client、secret 発行なし）。MCP 2026-07-28 では deprecated だが、CIMD 非対応のクライアントと既存の登録済み client のために残す（#254）。発行する client_id は base64url で `:` を含まないため、URL 形式の client_id と衝突しない |
| F7.3 | `GET /oauth/authorize?client_id=<cid>&state=<state>[&scope=...]` で `web_auth_state:{state}` レコードを `pending` として作成し、`redirect_uri=https://<worker>/oauth/callback` を固定して `https://github.com/login/oauth/authorize` に 302 リダイレクトする |
| F7.4 | `GET /oauth/callback?code=<gh_code>&state=<state>` で GitHub authorization code を confidential client として access token に交換し、`fetchGitHubProps()` で user profile + installations を取得、Worker 独自 bearer token pair を発行して `web_auth_state` を `approved` に遷移させる。ユーザにはタブを閉じるよう案内する HTML を返す |
| F7.5 | `POST /oauth/token` で `grant_type=urn:ietf:params:oauth:grant-type:web_authorization_poll` を処理する。`pending` → `400 authorization_pending`、`approved` → `200` で bearer pair を返し state レコードを消費、`denied` → `400 access_denied`、期限切れ → `400 expired_token`（RFC 8628 §3.5 のエラー形式を再利用） |
| F7.6 | `POST /oauth/token` で `grant_type=refresh_token` を処理し、access token と refresh token を rotate する（ブリッジ側 RC1 修正と組み合わせて desync を解消） |
| F7.7 | 保護対象 API ルート（`/mcp`, `/events`）は `Authorization: Bearer <access_token>` ヘッダによる独自 token 検証 middleware で認可する |
| F7.8 | KV schema は自前設計: `client:{client_id}` / `web_auth_state:{state}` / `token:{access_token}` / `refresh:{refresh_token}` / `grant:{grant_id}` / `cimd:{sha256(client_id URL)}`（検証済み Client ID Metadata Document の cache、F7.14）。device flow 時代の `device:` / `user_code:` キーは撤去 |
| F7.9 | ローカルブリッジは authorize URL を platform 既定のブラウザで自動オープンする。Windows は `cmd /c start`、macOS は `open`、Linux は `xdg-open` を使う。オープン失敗は fatal にしない（stderr に警告を残し、URL は応答と stderr で伝える） |
| F7.10 | ローカルブリッジは初回ツール呼び出しで web flow が完了していない場合、polling をバックグラウンドに維持したまま、authorize URL と残り有効秒数を本文に含む `isError: true` の構造化ツール応答を即座に返す。2 回目以降の同一ツール呼び出しは、承認完了なら通常処理、未完了なら同じ auth-required 応答を返す（ポーリングは 1 本に serialize） |
| F7.11 | ローカルブリッジは refresh の `invalid_grant` 後、共有 tokens file を直ちに再読込し、最大 1 秒の待機予算内で 50 ms 間隔に再読込する。この予算はファイル更新待ちの期限であり、既存の refresh 通信の所要時間上限は変更しない。新しい refresh_token の世代を見つけたら、有効な access token（期限なし、または期限まで 5 分超）があれば採用し、それ以外は refresh を最大 2 回試す。同じ世代は再試行しない。最初の refresh と回復処理は両 access-token 取得経路で単一のプロセス内 promise を共有し、成功・失敗の双方で解放する。更新なし・欠損・不正なファイル・本物の失効は有界に既存の全面認証／背景認証へ戻り、別種の refresh エラーでは再読込待機をしない。正常 refresh と有効なキャッシュには待機を追加しない。refresh のプロセス間 file lock は対象外（#258。#242 の過去原因の確定を意味しない）。web flow の共有は F7.12 に従う |
| F7.12 | 同一 OS ユーザー・正規化した Worker URL・実体の認証保存ディレクトリを scope として、web flow はプロセス間で単一 owner が実行する。owner のみ discovery/client 選択（CIMD または DCR、F7.15）/state/browser/poll/token 保存を行い、waiter は同じ pending URL/期限を返し、scope と owner 世代が一致する新しい保存結果だけを完了として再読する。tool の phase 1 は最大 15 秒、承認窓は 600 秒を維持する。observer と refresh/recovery はこの調停を開始しない。調停 record は既存ユーザー認証領域内で制限した権限とし、OAuth token/client secret を複製しない。排他所有権は 127.0.0.1 の scope hash 由来の単一 port を OS が保持し、全 IPC を record 内のランダム capability で認証する。IPC は資格情報を返さず、未認証要求には URL/state/所有情報を返さない。owner 終了で OS が排他を解放し、期限切れは owner の中断と書込権の失効を伴う。破損 record は健全な owner が再発行し、owner 不在なら次 owner が置換する。古い owner は後続世代を削除・上書きしない。port 衝突/不明 listener/認証不能は有界に fail closed し、別 port で二重起動しない。loopback listen 禁止や hash-port 衝突では再試行可能な認証エラーとなる。既存の global token/client cache に issuer 分離を追加する契約ではなく、別接続先の既存 cache 問題・DCR 撤去・refresh 障害の原因は対象外（#257） |
| F7.13 | Worker は `client_id` を 2 種類受け付ける。`:` を含まない値は F7.2 で発行した KV の client record で解決し、従来どおり grant の種類は検査しない。URL 形式（スキーム `:` で始まる）の値は Client ID Metadata Document（CIMD）として解決し、`/oauth/authorize`・web-auth poll・refresh の各入口で検査する。文書が対象の grant（authorize と poll は `urn:ietf:params:oauth:grant-type:web_authorization_poll`、refresh は `refresh_token`）を `grant_types` に宣言していなければ `400 unauthorized_client` を返す。`grant_types` が無い文書は RFC 7591 の既定 `authorization_code` とみなすので拒否される。解決・検証に失敗したら `401 invalid_client` を返し、`error_description` に理由を書く。いずれの失敗でも state record は作らない |
| F7.14 | URL 形式 client_id の取得と検証（draft-ietf-oauth-client-id-metadata-document-02、MCP 2026-07-28 client-registration）: client_id URL は https のみ、userinfo・fragment・dot segment・空白/制御文字/バックスラッシュを含まず、path を持ち、2048 文字以下。host は DNS 名に限り、IP literal・単一ラベル・特殊用途名（`localhost` / `local` / `internal` / `home.arpa` / `invalid` / `test` / `example` / `onion` / `alt`）は拒否する。取得前に DNS-over-HTTPS（`cloudflare-dns.com`）で A/AAAA を引き、1 件でも特殊用途アドレス（RFC 6890 系の IPv4 範囲、IPv6 は 2000::/3 の global unicast 以外と、その中の特殊用途ブロック）なら取得しない。取得は redirect を追わない（3xx も含め 200 以外はエラー）、DNS 照会から本文の読み取りまで 5 秒で打ち切る、本文は 5120 バイトまで（Content-Length 宣言でも、実際の読み取り量でも超過を拒否）、Content-Type は `application/json` か `application/*+json`、UTF-8 の JSON object であること。文書の `client_id` は URL と単純な文字列比較で一致し、`client_name`（空でない文字列）と `redirect_uris`（文字列配列）を持つこと。`client_secret` / `client_secret_expires_at` は禁止、`token_endpoint_auth_method` は省略か `none` のみ（共有秘密方式も `private_key_jwt` も拒否）、`jwks` は公開鍵のみ。文書内の URL（`logo_uri` 等）は取得しない。検証済みの文書だけを KV に cache し、寿命は `Cache-Control` の `max-age` を 60〜3600 秒に丸めて使う（指定なしは 300 秒、`no-store` / `no-cache` は下限の 60 秒）。エラーと不正な文書は cache しない。残るリスク: DNS 確認と取得のあいだの再解決（DNS rebinding）は Workers からは塞げない。`/oauth/*` に rate limit は無く、取得の失敗は cache されないので、同じ不正 URL での繰り返し要求は毎回 DNS 照会と取得を起こす |
| F7.15 | ローカルブリッジ（mcp-server / local-mcp、共通処理は `mcp-server/server/oauth-client.js`）は、メタデータが `client_id_metadata_document_supported: true` を示し、かつ `issuer` が https のとき、`<issuer の origin>/oauth/client-metadata.json` を client_id として使い、DCR を呼ばない。それ以外（広告なし、または `wrangler dev` などの http issuer）は従来どおり DCR に戻り、`oauth-client.json` を再利用・保存する。web flow で得た tokens には発行先の `client_id` を保存し、refresh はその client_id を送る。`client_id` を持たない #254 以前の tokens file は `oauth-client.json` の DCR client_id で refresh する（既存の grant は DCR client に紐づくため）。CIMD を使った場合も `oauth-client.json` は書き換えない。Worker を CIMD 非対応版へ戻すと CIMD client の refresh は `invalid_client` になり、既存の経路どおり web flow（DCR）へ戻る |
| F7.16 | ブリッジ用の Client ID Metadata Document は Worker 自身が `GET /oauth/client-metadata.json` で配信する（`client_id` = その URL、`client_name`、`redirect_uris=[]`、`grant_types=[web_authorization_poll, refresh_token]`、`response_types=[]`、`token_endpoint_auth_method=none`、`Cache-Control: public, max-age=3600`）。Worker は自分の origin と一致するこの client_id を、ネットワーク取得せずにローカルで解決し、F7.14 と同じ検証関数を通す（draft §5 が認める「取得以外の手段による関連付け」） |

**Dynamic Client Registration の位置づけ（#249 で確認、#254 で CIMD を追加）:**

MCP 2026-07-28 の deprecated レジストリ 6 件のうち本 repo に該当するのは Dynamic Client Registration（F7.2）のみ。移行先は Client ID Metadata Documents。最短撤去は 2027-07-28 以降の最初のリビジョンであり、しかも「最短撤去」は撤去が可能になる時点にすぎず、実際の撤去は Core Maintainer 判断でそれ以降にずれうる。仕様からの撤去は SDK に削除義務を課さない。

#249 では撤去しなかった。理由は相乗りの前提が成立しないこと — 同移行は OAuth の実装に一切触れておらず（ブリッジ側は transport の `authProvider` に繋ぎ直しただけ）、DCR 撤去は両面の認証設計変更になる。プロトコル切替と同一リリースに載せると、利用者が再起動して降りてくる先で破断面が二つ同時に開く。

#254 では **DCR を残したまま CIMD を足した**（F7.13〜F7.16）。根拠: MCP 2026-07-28 client-registration は CIMD を SHOULD、DCR を後方互換の MAY とし、クライアントの選択順を「事前登録 → `client_id_metadata_document_supported` が示されれば CIMD → `registration_endpoint` があれば DCR」と定める。TypeScript SDK v1.27.1 の `src/client/auth.ts` も、広告があり URL が https なら CIMD、なければ DCR に戻る。DCR を撤去するかどうかは、クライアント側の移行を確認したあとで別に判断する。

ブリッジ用文書の置き場所は Worker 自身にした（F7.16）。比較した案と判断:

- Worker が配信する（採用）: 追加の配信基盤もデプロイ手順も要らない。self-host の Worker でも origin から client_id が決まるので、そのまま動く。Worker は自分の文書をローカルで解決するので、ログインのたびに外部ホストや自分自身へ取得しに行かない（自己取得のループも、外部ホストの障害でログインが止まることもない）。文書の内容は Worker のコードと同じ版で更新される。欠点は client_id が Worker ごとに変わり、認可サーバをまたいで持ち運べないこと。ただしブリッジは `WEBHOOK_WORKER_URL` の 1 台にしか接続しないので、この欠点は実害にならない。
- リポジトリ / GitHub Pages で配信する（不採用）: client_id を全 Worker で共通にできるが、Pages の有効化という人手の外部設定が要る。self-host の Worker も含め、すべてのログインが Pages の可用性に依存する。`raw.githubusercontent.com` は `text/plain` で返るため、F7.14 の Content-Type 検査を通らない。

範囲外（#254）: 標準の OAuth クライアント向け authorization_code / PKCE。CIMD を足しても、この Worker の認可エンドポイントが扱うのは web-auth poll grant だけで、`authorization_code` しか宣言しない CIMD クライアントは F7.13 で拒否される。したがって標準クライアントへの対応は済んでいない。Worker は GitHub の画面へ直接 redirect し、自前の同意画面を持たないので、draft §8.5 の「client_id の host 名を利用者に表示する」も満たしていない。DCR で誰でも client を登録できる現状と比べて、新しいリスクは増えない。

該当しないもの: Roots / Sampling / Logging / `includeContext`（未使用）、HTTP+SSE トランスポート（Streamable HTTP のみを提供しているため未露出）。

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
| N2.7 | 処理済みイベント保持期間 | `PURGE_AFTER_DAYS` 環境変数（wrangler.toml `[vars]`） | `3`（日）。`mark_processed` 時および DO Alarm sweep 時に保持期間超過の処理済みイベントを削除。`0` で処理済みを即削除 |
| N2.8 | 未処理イベント保持期間 | `UNPROCESSED_PURGE_AFTER_DAYS` 環境変数（wrangler.toml `[vars]`） | `90`（日）。DO Alarm sweep 時に保持期間超過の未処理イベントを削除。`0` で未処理を即削除。処理済み（3 日）より長いのは未読データ消失の安全域（非対称は意図的） |

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
| N3.1 | WebhookStore DO はテナント別インスタンス（`idFromName("store-{accountId}")`）で動作する。MCP 側にテナント別インスタンスは無い（2026-07-28 でセッションが消え、リクエストごとの props から store 名を解決する）。TenantRegistry DO は単一インスタンスで全テナントの installation-account マッピングを管理する |
| N3.4 | Web OAuth callback 処理時に `GET /user/installations` で取得した accessible_account_ids（ユーザー + org）を GitHubUserProps に保存し、MCP ツールが複数 store を並列クエリして結果をマージする。これにより org インストールのイベントもメンバーからも参照できる。accessible_account_ids はリクエストごとの props から読む |
| N3.2 | WebSocket / SSE 接続は DO のメモリ内で管理される（DO eviction 時に切断） |
| N3.3 | Worker とブリッジのあいだにセッションは無い（2026-07-28 ステートレスコア、#249）。ブリッジが再利用するのは MCP クライアントとその transport であり、切断のコストは再接続一回に閉じる |
| N3.5 | Worker は 2026-07-28 のみを提供し、2025 系リクエスト（`initialize` を含む）を `legacy: "reject"` で拒否する。互換レーンは持たない（#249 決定 1）。ブリッジのクライアント面も同じ版に pin する |

## Dependencies

### Cloudflare Worker

| パッケージ | 用途 |
|-----------|------|
| agents | Cloudflare Agents SDK (`createMcpHandler` — Worker 向けステートレス MCP ハンドラ) |
| @modelcontextprotocol/server | MCP SDK v2 サーバー（プロトコル版 2026-07-28。`agents` が非 optional peer として exact 2.0.0 を要求するため exact 固定） |
| zod | スキーマバリデーション |

OAuth 実装は自前（`worker/src/oauth.ts` + `worker/src/oauth-store.ts`）。`@cloudflare/workers-oauth-provider` は v0.11.0 で撤去済み。v0.11.1 で Worker-hosted web OAuth に切り替え（device authorization grant は撤去）。

### ローカルブリッジ (mcp-server/)

| パッケージ | 用途 |
|-----------|------|
| @modelcontextprotocol/sdk | MCP SDK v1（Claude Desktop に対するサーバー面。`Server` クラス直接使用） |
| @modelcontextprotocol/client | MCP SDK v2 クライアント（Worker に対するクライアント面。版 2026-07-28 に pin） |

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

### 配送鎖と完了条件

```
merge → gh release create → CD (npm-publish) → registry の latest 更新
      → 利用側 MCP クライアントの再起動 → npx が新版を解決 → 利用側に到達
```

後半 2 段は CD の外側にあり、リポジトリ側からは実行できない。npx がパッケージのバージョンを解決するの
はプロセス起動時の一度きりであり（クライアント設定で `@latest` を指定していても同じ）、すでに起動して
いるプロセスは registry がどう変わっても起動時のバージョンを保持し続ける（v0.11.9 のリリース直後に実
測: registry が 0.11.9 を返している間、稼働中のクライアントは 0.11.8 のままだった。0.11.9 に移ったの
は Claude Desktop を再起動した時点である）。

したがって **「registry が新版を返す」はリリース完了の判定基準にならない**。特にプロキシの静的ツール
スキーマを変更したリリースは、利用側プロセスが再起動して初めて成果が現れる。リリース完了報告を
registry の確認で締めると、届いていない状態を届いたと報告することになる。

registry の確認には `--prefer-online` を付ける。npm CLI は registry のメタデータをキャッシュするため、
publish 直後の `npm view github-webhook-mcp version` は旧版を返しうる（同じく v0.11.9 で実測）。

```bash
npm view github-webhook-mcp version --prefer-online
```

npx のキャッシュ解決挙動そのものは本リポジトリの管理外であり、規定できるのは
「再起動が要る」という事実と上記の確認手段までとする。

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
| `worker/src/mcp.ts` | MCP サーバー factory（ツール定義。リクエストごとに生成、テナントは props から解決） |
| `worker/src/retired-do.ts` | 退役した WebhookMcpAgent クラス（過去 migration 制約のためだけに残す） |
| `worker/src/store.ts` | WebhookStore DO（SQLite + SSE、テナント別インスタンス） |
| `worker/src/tenant.ts` | TenantRegistry DO（installation-account マッピング、クォータ管理） |
| `worker/src/oauth.ts` | Worker-hosted web OAuth 自前実装（metadata / client-metadata 文書 / register / authorize / callback / token / 独自 token 検証 middleware） |
| `worker/src/client-metadata.ts` | Client ID Metadata Document の URL 検証・SSRF 対策付き取得・文書検証・ブリッジ用文書（F7.13〜F7.16） |
| `worker/src/oauth-store.ts` | OAuth KV schema helper（client / web_auth_state / token / refresh / grant / cimd cache レコード操作） |
| `worker/wrangler.toml` | Worker デプロイ設定 |
| `shared/src/types.ts` | 共有型定義 |
| `shared/src/summarize.ts` | イベントサマリー生成 |
| `local-mcp/src/index.ts` | ローカルブリッジ（TypeScript、開発用） |
| `mcp-server/server/index.js` | ローカルブリッジ（JS、.mcpb 配布用） |
| `mcp-server/server/oauth-client.js` | ブリッジの OAuth client 選択（CIMD 優先・DCR fallback・refresh 用 client_id、両ブリッジ共通） |
| `mcp-server/manifest.json` | MCPB マニフェスト |
| `mcp-server/package.json` | npm パッケージ定義 |
