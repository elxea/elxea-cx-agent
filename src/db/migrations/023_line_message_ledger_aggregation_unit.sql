-- 023: 配信計測の集計単位（aggregation_unit）を通数台帳へ付与 — P0-7a（後付け不可）
--
-- 背景・設計: 統合設計書 §B-5c / §C-5 実装ノート I-3・I-6
--   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
--
-- 役割: LINE の unit 別統計（開封/クリック）は「送信時に customAggregationUnits を付与した場合のみ」
--   後から取得できる（付与しない限り永久に取れない = 後付け不可）。送信のたびに付与した unit 名を
--   line_message_ledger（migration 019）に 1:1 で記録し、後段の統計 fetch（7b=P1）が台帳を起点に
--   unit を引けるようにする。
--
-- スコープの明示（I-3 の分割）:
--   本 migration は 7a =「送信時 unit 付与のための列追加」まで。
--   7b = 集計 fetch 基盤（broadcast_stats テーブル + 24h/72h/7d 自動取得ジョブ）は P1 のため
--   別 migration（将来）で追加する。ここでは broadcast_stats を作らない。
--
-- 冪等性: IF NOT EXISTS で再実行安全。既存があっても無害。
-- 適用: 本番未適用。staging 適用ゲート → Setaka 承認後に本番へ。
--       このファイル作成時点では本番 Supabase へは一切適用しない。

-- 送信時に付与した集計単位名（例: s20260807_all）。
--   NULL 許容: 過去行（unit 付与前）・interactive(push) 等 unit を持たない消費のため。
--   命名規約は src/lib/aggregation-unit.ts（半角英数字・_ のみ / 最大30字 / 1配信=1 unit）。
ALTER TABLE line_message_ledger
  ADD COLUMN IF NOT EXISTS aggregation_unit text;

-- 7b（統計 fetch）が unit を起点に台帳行を引くための索引。NULL は除外（unit 付き行のみ）。
CREATE INDEX IF NOT EXISTS line_message_ledger_unit_idx
  ON line_message_ledger (aggregation_unit)
  WHERE aggregation_unit IS NOT NULL;
