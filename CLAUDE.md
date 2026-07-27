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
pnpm deploy           # Cloudflare Workers にデプロイ
pnpm sync-knowledge   # Notion → pgvector 同期
pnpm typecheck        # TypeScript 型チェック
```

## 環境変数

`.dev.vars` (ローカル) または Cloudflare Workers Secrets (本番) に設定。
`.env.example` を参照。

## アーキテクチャ

```
LINE Webhook → Hono → Claude API (tool_use) → LINE Push
                         ↕
                   search_knowledge → pgvector (Notion 由来)
                   escalate_to_human → Slack

Cron (*/15) → delivery-orchestrator → Notion「配信コンテンツ」DB → LINE broadcast/multicast
```

## LINE 配信サブシステム（触る前に必ずドキュメントを読む）

対話とは別に、Notion の「配信コンテンツ」DB を運用者インターフェースとする**一斉配信**の仕組みを持つ。
実装は `src/lib/delivery-*.ts`（orchestrator / repository / approval / audience / channel / runtime / time）、
Cron トリガー `*/15 * * * *` が承認済み行を拾って送信する。

**ドキュメントの正本（この節には詳細を書かない・二重管理を避ける）**:

- 運用者向け手順: `docs/line-delivery-guide.md`（運用者が読む正本は Notion 版
  <https://app.notion.com/p/39970c9d064c81dabf04f65c073d667c>。**配信コードを変えたら両方を同時に直す**）
- エンジニア向けコマンドの正本: `docs/deploy-runbook.md` の「**LINE 配信の運用ゲート**」節
  （送信スイッチ操作 / env 分離 / テスト配信手順）

**環境構成（取り違え = 実顧客への誤配信）**:

| | Worker | LINE OA | 配信 DB |
|---|---|---|---|
| 本番 | `elxea-agent` | `@307tzhkw`（実顧客） | 既定の本番配信 DB |
| 検証 | `elxea-agent-staging` | `@426vlcyb`（テスト専用） | テスト用 DB（`NOTION_DELIVERY_DB_ID` 設定必須） |

**安全弁の現状（弱めない・勝手に変えない）**:

- 本番の実送信スイッチ `DELIVERY_SEND_ENABLED` は **OFF**。承認しても step(g) 前に非破壊 early-return し実送信は起きない
- prod 自己承認（単独運用モード）`DELIVERY_ALLOW_SELF_APPROVAL_PROD` は **有効**。ただし**承認者が空なら常に拒否**
- 配信 DB の env 分離は **fail-closed**（`resolveDeliveryDbId()`）。**本番 Worker に `NOTION_DELIVERY_DB_ID` を設定してはならない**（テスト用 DB の行が実顧客へ飛ぶ経路が生まれる）
- スイッチ ON/OFF・本番配信は **Tier 2（Setaka 承認）**。検証時のコマンドは **`--env staging` 必須**（付け忘れは本番操作）

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
