-- 027: customer_linkages のカーディナリティを N:1 に緩める（世帯共有/付け替え対応・QA M-1）
--
-- 背景・設計: 3 レンズ・クロスレビュー QA M-1（世帯共有/付け替えで 500）
--   migration 002 は `shopify_customer_id text unique` を張っていた（1 Shopify 顧客 : 1 LINE）。
--   だが upsert は onConflict=line_user_id のみを吸収するため、
--   「複数の LINE → 同一 Shopify 顧客」（世帯で 1 アカウントを共有する等・お茶では普通）を作ろうとすると
--   shopify_customer_id の UNIQUE 制約に衝突し、ハンドラが 500 を返していた。
--   → 正しいカーディナリティは N:1（複数 LINE : 1 Shopify）。UNIQUE を外して N:1 を許可する。
--
-- 何を変えるか（列・データには一切触れない・制約だけ外す）:
--   - shopify_customer_id の単一列 UNIQUE 制約を DROP する（制約名は環境差を吸収して動的に特定）。
--   - line_user_id の UNIQUE（連携の主キー相当）は維持する（1 LINE : 高々 1 Shopify のまま）。
--   - 検索用の非 UNIQUE インデックス customer_linkages_shopify_idx（002 で別途作成）は残る
--     （UNIQUE 制約の裏 index だけが DROP され、この明示 index は影響を受けない）。
--
-- 冪等性: 対象 UNIQUE 制約が既に無ければ何もしない（IF EXISTS 相当の動的 DROP）。再実行安全。
-- 適用順序: staging に先行適用（run-migration-staging.ts・dual-guard）。
--           本番は Setaka 承認後に同一 SQL を適用（本ファイルが prod 用 SQL も兼ねる）。既存行は不変。

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'customer_linkages'
    AND con.contype = 'u'                     -- UNIQUE 制約のみ
    AND att.attname = 'shopify_customer_id'   -- shopify_customer_id 列
    AND array_length(con.conkey, 1) = 1       -- 単一列制約のみ（複合 UNIQUE は対象外）
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.customer_linkages DROP CONSTRAINT %I', cname);
    RAISE NOTICE '027: dropped UNIQUE constraint % on customer_linkages.shopify_customer_id (N:1 allowed)', cname;
  ELSE
    RAISE NOTICE '027: no single-column UNIQUE on shopify_customer_id (already N:1 / idempotent no-op)';
  END IF;
END $$;
