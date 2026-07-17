-- 026: customer_linkages.source — 連携の発生源（provenance）列を追加（売上重大2対応・ブロック4）
--
-- 背景・設計: 統合設計書 §A（連携導線の作り直し）/ 2 視点レビュー 売上重大2
--   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
--
-- 解消する問題（事実）: customer_linkages は「どの経路で連携が作られたか」を持たない。
--   LIFF 連携（identity/link-liff）・テスト連携キット（owner_kit）・follow 経由の email 橋渡し等を
--   後から区別できず、連携ファネルの経路別効果測定（どの入り口が連携に効いたか）ができなかった。
--   → 発生源を text 1 列で記録し、link.* フロー計測（flow_events）と突合できるようにする。
--
-- 値の規約（アプリ側で付与・DB は自由 text）:
--   'liff'       … identity/link-liff（LIFF id_token 検証 → 冪等 upsert）由来
--   'owner_kit'  … scripts/test-linkage-kit.ts の owner/setup 系（staging 検証用の合成連携）
--   'follow_ref' … （将来）follow 経路の email 橋渡しで連携行を作る経路ができたとき
--
-- 冪等性: ADD COLUMN IF NOT EXISTS で再実行安全。既存行の backfill はしない（NULL = 旧データ・意図どおり）。
-- 適用: staging → Setaka 承認後に本番（既存 customer_linkages 行のデータには一切触れない・列追加のみ）。

ALTER TABLE customer_linkages ADD COLUMN IF NOT EXISTS source text;
