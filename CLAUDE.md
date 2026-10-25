# elxea-agent — LINE AI カスタマーエージェント

## Git ルール（厳守）
- 開発作業は developer ブランチで行う
- master への直接 push は禁止
- developer → master のマージは CI 全 PASS 後のみ
- コミットメッセージは conventional commits に従う（feat:, fix:, ci:, test:, docs:, chore:）

## 概要

LINE 公式アカウントで動作する AI カスタマーエージェント。
Notion をナレッジベースとし、そこに書かれた情報のみで回答する（Notion-Grounded AI）。

## 技術スタック

- Runtime: Hono on Cloudflare Workers
- AI: Claude API (tool_use)
- Knowledge: Notion API → Supabase pgvector (RAG)
- DB: Supabase (PostgreSQL + pgvector)
- LINE: LINE Messaging API
- Embedding: OpenAI text-embedding-3-small

## コマンド

```bash
pnpm dev              # ローカル開発サーバー (wrangler dev)
pnpm deploy           # Cloudflare Workersにデプロイ（前段でscripts/deploy-preflight.shが
                      #   working tree clean + HEAD == origin/masterを検証。外れたら中止）
pnpm sync-knowledge   # Notion → pgvector 同期
pnpm typecheck        # TypeScript 型チェック
```

## 環境変数

`.dev.vars` (ローカル) またはCloudflare Workers Secrets (本番) に設定。
`.env.example` を参照。

ローカル検証の前に、`.dev.vars` の値が本番と乖離していないかを確認する。
特に `SYNC_API_SECRET` は2026-08-22に本番をローテートしたため、
手元の値が古いと同期系APIが401で落ちる。取得元は `.env.example` の同項目のコメントを参照 (値はここに書かない)。

## アーキテクチャ

```
LINE Webhook → Hono → Claude API (tool_use) → LINE Push
                         ↕
                   search_knowledge → pgvector (Notion 由来)
                   escalate_to_human → Slack

Cron (*/15) → delivery-orchestrator → Notion「配信コンテンツ」DB → LINE broadcast/multicast
```

**CDP（データ基盤）と CX（顧客体験）の境界の正本は、自動生成の [`docs/layer-map.md`](docs/layer-map.md)**（`npx tsx scripts/layer-map.ts --out docs/layer-map.md` で再生成。手で編集しない）。

## LINE 配信サブシステム（触る前に必ずドキュメントを読む）

対話とは別に、Notionの「配信コンテンツ」DBを運用者インターフェースとする**一斉配信**の配信本体を持つ。
実装は `src/lib/delivery-*.ts`。送るのは1件だけ送る口（`POST /api/delivery/send-one`）だけで、それを起こすのはMacの配信の流れ（下の正本）。
配信のCronは持たない（`tests/unit/cron-routing.test.ts` が `wrangler.toml` のcronsを見る）。

**正本と案内（この節には詳細も現在値も書かない・二重管理を避ける。分け方の正本はエージェント側の入口 `line-delivery-ops` skill = `~/github/elxea/agents/_shared/skills/line-delivery-ops/SKILL.md` の「正本と案内」）**:
- 動き・止める条件の正本: コードと設定（このリポの `src/lib/delivery-*.ts` と、Macの配信の流れ `~/.config/admin-pipeline/pipelines.json` の `elxea-line-*-delivery-*`・`scripts/line_delivery_*.py`）
- 使い方の案内: Notion版の運用者ガイド <https://app.notion.com/p/39970c9d064c81dabf04f65c073d667c>（リポジトリ側の写し `docs/line-delivery-guide.md` との関係は、ガイドの「参照元」が持つ。**配信コードを変えたら両方を同時に直す**）
- Worker側の設定の説明: `docs/deploy-runbook.md`「LINE配信の運用（送信条件 / env分離 / テスト配信）」節（secret・配信DBのenv分離・検証環境の設定）。止める・再開するは、この節ではなく運用者ガイドと実物で引く

**env 取り違え = 実顧客への誤配信。** 本番と検証は Worker / LINE OA / 配信 DB がすべて別。検証時のコマンドは **`--env staging` 必須**（付け忘れは本番操作）。**本番 Worker に `NOTION_DELIVERY_DB_ID` を設定してはならない**（テスト用 DB の行が実顧客へ飛ぶ経路が生まれる。env 分離は `resolveDeliveryDbId()` で fail-closed）。安全弁は勝手に弱めない。LINE配信を止める・再開する（緊急停止のファイルを置く・外す。ファイルの場所は `~/.config/admin-pipeline/pipelines.json` のLINE送信の段の `kill_switch_path`、判定は `~/.config/admin-pipeline/scripts/line_delivery_lib.py` の `gate_status`）と本番配信の可否は **Tier 2（Setaka承認）**。

## 制約

- 本番デプロイは全件 Setaka 承認
- `--force` や `--no-verify` は原則禁止
- AI は Notion ナレッジにある情報のみで回答する（一般知識での補完禁止）

## ユーザー向けブランド文言のルール（必須）

ユーザーに表示されるブランド文言（読み仮名・ブランドステートメント・タグライン・会社情報・
産地/事業領域の説明 等）を**新規作成・変更するときは、必ず正本に突合してから書く**。
Spec や設計書の「文面案」からの再創作は禁止（文面案は正本ではない）。

- 正本: `elxea-brand-context` skill（`/Users/setaka/github/elxea/agents/_shared/skills/elxea-brand-context/SKILL.md`）
  と About elxea（https://www.notion.so/154f0d9de112457c83c62fb5b56b1788 ）、
  会社基本情報は Corporate Info DB（https://www.notion.so/fc8c353f9650453c9707ae0a806ae484 ）。
- ユーザー向けブランド文言は `src/lib/brand-copy.ts` に集約する（各定数に出典 URL コメント必須）。
  メッセージビルダーは brand-copy の定数を参照し、ブランド事実をベタ書きしない。
- 禁止語リグレッションテスト（`tests/unit/brand-copy.test.ts`）が「エルシア／鹿児島を中心／
  スキンケア／合同会社／静かな豊かさ」等の非正本文言の再混入を機械的に検出する。追加の禁止語が
  判明したら同テストに追記する。

## Devlog ルール

notion-record スキルに準拠。
