-- 024: 配信計測の集計値テーブル（broadcast_stats）— P0-7b（後付け不可の計測基盤・I-3 で P1 に分割された 7b）
--
-- 背景・設計: 統合設計書 §B-5c / §C-5 実装ノート I-3
--   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
--
-- 役割: LINE の unit 別統計（開封 uniqueImpression / クリック uniqueClick）は「送信時に
--   customAggregationUnits を付与した場合のみ・照会は当月＋前月のみ」取得できる（後付け不可）。
--   migration 023 で line_message_ledger に付与した aggregation_unit を起点に、配信後
--   24h / 72h / 7d のスナップショットを LINE Insight API から取得し、本テーブルへ蓄積する。
--   蓄積目的は「エージェント参照用のデータ蓄積」に限定（決定5: 人間向け定期レポートは廃止）。
--
-- スコープ（I-3 の分割を完結させる）:
--   023 = 7a（送信時 unit 付与）… 適用済み設計。
--   024 = 7b（集計 fetch 基盤の受け皿テーブル）… 本 migration。
--   fetch ジョブ本体は src/lib/broadcast-stats.ts、cron 配線は cron-routing.ts / index.ts。
--
-- ⚠ LINE 仕様（コード側 broadcast-stats.ts / line-insight.ts にも明記）:
--   (1) 照会は「当月＋前月」のみ（それ以前は取得不能・後付け不可）。
--   (2) ユニーク 20 人未満は uniqueImpression / uniqueClick が null で返る（プライバシー保護）。
--       現状 友だち約48人・multicast 宛先は更に少数のため、当面 null が「正常挙動」。
--
-- Spec DDL からの相違（報告に明記・追加のみで Spec 列は不変更）:
--   Spec §B-5c の DDL は append-only（一意制約なし）だが、fetch ジョブの再実行/手動トリガを
--   冪等（upsert）にするため snapshot_window 列 + UNIQUE(aggregation_unit, snapshot_window) を
--   追加する。Spec の全列（aggregation_unit / notion_page_id / fetched_at / delivered /
--   unique_impression / unique_click / unfollow_within_72h）は削除・改名せず維持する。
--
-- 冪等性: IF NOT EXISTS で再実行安全。適用: 本番未適用。staging 適用ゲート → Setaka 承認後に本番へ。
--         このファイル作成時点では本番 Supabase へは一切適用しない。

CREATE TABLE IF NOT EXISTS broadcast_stats (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 配信 1 本の集計単位名（line_message_ledger.aggregation_unit と 1:1。例: s20260807_ser）。
  aggregation_unit TEXT NOT NULL,
  -- 配信元 Notion ページ ID（台帳 notion_page_id を引き写す・任意）。
  notion_page_id TEXT,
  -- スナップショットの計測時点（24h / 72h / 7d）。Spec 追加列（冪等 upsert 用）。
  snapshot_window TEXT NOT NULL DEFAULT '24h'
    CHECK (snapshot_window IN ('24h', '72h', '7d')),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 配信通数（自前の台帳 SUM(recipients) 由来。LINE Insight ではなく台帳が権威）。
  delivered INT,
  -- 開封ユニーク数 / クリックユニーク数（LINE Insight overview 由来）。20人未満は NULL（LINE 仕様）。
  unique_impression INT,
  unique_click INT,
  -- 配信時刻〜72h の unfollow 件数（customer_linkages.unfollowed_at から自前算出・H7 検証データ）。
  --   72h/7d スナップショットの値が確定値（24h 時点は経過途中のため過小になり得る）。
  unfollow_within_72h INT,
  -- 冪等 upsert キー: 同一 unit × 同一スナップショット時点は 1 行に集約（再実行は更新）。
  CONSTRAINT broadcast_stats_unit_window_uniq UNIQUE (aggregation_unit, snapshot_window)
);

-- unit を起点にスナップショットを引く索引（Spec §B-5c の idx_broadcast_stats_unit）。
CREATE INDEX IF NOT EXISTS idx_broadcast_stats_unit
  ON broadcast_stats (aggregation_unit, fetched_at);

-- ===================================================================
-- RLS（migration 017 / 018 / 019 と同じセキュリティ姿勢）
--   アプリは service_role_key で接続し RLS をバイパスする。
--   ポリシー無し = 非 service_role 接続に対し deny-all。
--   ENABLE ROW LEVEL SECURITY は再実行しても無害（冪等）。
-- ===================================================================
ALTER TABLE broadcast_stats ENABLE ROW LEVEL SECURITY;
