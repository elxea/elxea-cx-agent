-- 022: product_ratings — 商品単位の評価の器（欠落(b)を埋める）— P0-3
--
-- 背景・設計: 統合設計書 §B-5b / §C-5 実装ノート I-6・I-9
--   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
--
-- 設計（判断）: tasting_note_survey の流用はしない（サービス体験サーベイと商品評価は目的が別・
--   product_id 列も無い）。新テーブルで「商品×ユーザー×時点」を持つ。
--   器を先に作らないと開店時にデータ蓄積が始められない（先行実装が正しい順序）。
--
-- product_no 母集団（I-9）: Tea Menu 全 43 件（5桁番号一意・実測確認済み）。
--   一覧公開・楽しみ方対象 30 件 / 農家物語 対応済み 12 件 は部分集合。
--
-- 再評価は上書きせず追記（時点分析のため。有効値は最新）— アプリ側の運用規約。
--
-- 冪等性: IF NOT EXISTS で再実行安全。適用: 本番未適用（staging ゲート → Setaka 承認）。

CREATE TABLE IF NOT EXISTS product_ratings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_ref text NOT NULL,
  channel text NOT NULL DEFAULT 'line' CHECK (channel IN ('line','web')),
  product_no text NOT NULL,                            -- Tea Menu の5桁番号
  rating smallint NOT NULL CHECK (rating IN (1, -1)),  -- 1=おいしかった / -1=好みと違った
  source text NOT NULL CHECK (source IN ('tea_card','post_delivery','broadcast','diagnosis')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_ratings_product ON product_ratings (product_no, created_at);
CREATE INDEX IF NOT EXISTS idx_product_ratings_user ON product_ratings (user_ref, created_at);

-- RLS: 既存テーブルと同一（service role のみ書き込み・ポリシー無しで deny-all）。
ALTER TABLE product_ratings ENABLE ROW LEVEL SECURITY;
