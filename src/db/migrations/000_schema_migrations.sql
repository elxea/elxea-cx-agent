-- 000: schema_migrations — マイグレーション適用台帳（統合 runner scripts/migrate.ts の前提）
--
-- 背景・設計: これまで各マイグレーションは ad-hoc runner（run-migration-p0.ts /
--   run-migration-account-link-prod.ts 等）で「番号を手で列挙」して適用しており、
--   「どの環境にどの番号まで適用済みか」の単一の真実（SoT）が DB 側に存在しなかった。
--   その結果、番号重複（026 が 2 本）・二重適用・適用漏れを機械で防げなかった。
--
-- 本テーブルの役割:
--   統合 runner（scripts/migrate.ts）が「適用したマイグレーション version」をここに 1 行記録する。
--   次回実行時は記録済み version をスキップし、未適用のみを番号順に冪等適用する。
--
-- 冪等・再実行安全:
--   IF NOT EXISTS で作成する。既に存在すれば no-op。適用記録の行は runner が INSERT する
--   （本 SQL はスキーマのみ）。
--
-- version の規約（runner 側と一致させる）:
--   マイグレーションファイル名から拡張子 .sql を除いた文字列（例 "026_customer_linkage_source"）。
--   数値プレフィックスだけでなくファイル名全体を使うことで、026 のような同番号衝突があっても
--   別 version として一意に扱える（本台帳導入時に 026_marche_activation_log は 029 へリネーム済み）。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
