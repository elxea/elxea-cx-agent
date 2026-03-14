# elxea-agent — LINE AI カスタマーエージェント

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

## Devlog ルール

グローバル CLAUDE.md の「記録ルール」に準拠。以下はエージェント固有の補足：

### 必須プロパティ
- **Name**: Type の値と同じ文字列を入れる（例: Type が Devlog なら Name も「Devlog」）。詳細は Note またはページ本文に記載
- **Type**: `Devlog` / `Proposal` / `Research` / `Spec` / `Design` / `Review`（グローバル CLAUDE.md の判定基準に従う）
- **Project**: All Projects DB（`collection://22263392-2e8d-4f63-912b-c74a4299e0be`）で検索して設定
- **Assignee**: elxea-agent（People List ID は Setaka に確認が必要 — 未設定）
- **Date**: `date` コマンドで JST 取得 → UTC 変換（JST-9h）→ `date:Data:start` に ISO-8601 datetime を分単位で設定、`is_datetime: 1`

## Notion DB 操作ルール

Notion DB への記録・更新を行う前に、必ずグローバル CLAUDE.md（`~/.claude/CLAUDE.md`）の「記録ルール」「All Tasks DB 運用ルール」セクションを参照・遵守すること。
