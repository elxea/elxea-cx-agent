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
```

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
