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

## Devlog ルール

notion-record スキルに準拠。
