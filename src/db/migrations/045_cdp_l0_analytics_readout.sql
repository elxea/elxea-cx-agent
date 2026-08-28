-- ===================================================================
-- 045: 解析側が L0 を「取りに来る」ための読み口を 2 つ開ける
--      （CDP 統合 Stage 3 / §6-1 Stage 3 / §5 E8'）
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）
--   §4-5 物理配置（L0 は Supabase 書込 + SQLite 解析の 2 箇所）
--   §5 E8'（L0 二重物理の**日次件数突合**）/ §6-1 Stage 3（解析の正本化）
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ なぜ「取りに来る」形なのか ─
--
-- L0（customer_events）は Supabase にあり、解析（report.mjs / persons / purchases）は
-- ローカルの SQLite にある。Workers からローカルファイルには書けないので、
-- 書込は Supabase が受け、**日次で SQLite が吸い上げる**（設計 §4-5）。
-- 押し込む側を作ると Worker が Mac の状態を知る必要が出るので、取りに来る側に倒す。
--
-- ─ ここで開ける 2 つの口 ─
--
--   cdp_l0_daily_counts     … 日ごとの L0 行数。E8' の「日次件数突合」の Supabase 側。
--                             SQLite 側が同じ日で同じ数を持っていなければ、その日の
--                             吸い上げが落ちている（＝ 2 つの L0 が食い違っている）。
--   cdp_subject_shopify_map … 主体 ↔ Shopify 顧客番号の対応。SQLite の persons に
--                             subject_id を 1:1 で持たせるための唯一の材料。
--
-- ─ なぜ主体の対応に Shopify 顧客番号だけを使うのか（E5 を破らないため）─
--
-- 生の LINE userId は「その人に話しかけられる鍵」であり、置き場は delivery_identity
-- 1 表だけと決めてある（E5 / ratchet raw-identity-key-legacy）。これを解析用に
-- ローカルへ吐き出すと、**置き場が 1 つ増える**。よってこの口は生 LINE userId を
-- 一切返さない。SQLite の persons は Shopify 同期で作られる表なので ec_customer_id
-- で結べば足り、LINE しか持たない人はそもそも persons に行が無い。
--
-- email_hash も返さない。ハッシュの作り方（塩）が 2 つの世界で違うので結べないし、
-- 結べる形にすることは「メールで人を結ぶ」経路を新設することになる（SEC-1）。
--
-- ─ canonical で返す ─
--
-- 返すのは edge がぶら下がっている主体そのものではなく、**連結成分の代表**
-- （cdp_canonical_subject）である。生の主体で返すと、link が足された日に
-- persons.subject_id が別の値に見えて 1:1 が崩れる。判定は 043 の解決関数 1 か所に
-- 置いたままにして、ここで別の解き方を発明しない。
--
-- ⚠ 040 / 041 / 043 が先に当たっていること。
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION のみ。何度当てても同じ。
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.customer_events') IS NULL THEN
    RAISE EXCEPTION '045: customer_events が無い。041 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_canonical_subject') IS NULL THEN
    RAISE EXCEPTION '045: cdp_canonical_subject が無い。043 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. cdp_l0_daily_counts — E8' の Supabase 側の数
--
--     ─ なぜ recorded_at で切るのか ─
--       occurred_at（送り手の申告時刻）で切ると、遅れて届いた出来事が「過去の日」に
--       入り、既に突合が緑になった日の数が後から増える。吸い上げは event_seq の順で
--       進むので、**置き場に載った時刻**で切ったほうが「どの日が落ちたか」と対応する。
--
--     ─ なぜ Asia/Tokyo なのか ─
--       吸い上げを回す日次ジョブが JST で動くため。SQLite 側も同じ境界で切る
--       （境界がずれると、ずれた分が毎日「食い違い」に見える）。
--
--     引数: p_from / p_to は JST の日付（両端を含む）。NULL なら直近 30 日。
--     返り: { "from": ..., "to": ..., "total": n, "days": [ { day, events, unknown } ] }
--
--     @reader elxea-cdp/l0-ingest.mjs
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l0_daily_counts(
  p_from date DEFAULT NULL,
  p_to   date DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_to    date := coalesce(p_to,   (now() AT TIME ZONE 'Asia/Tokyo')::date);
  v_from  date := coalesce(p_from, v_to - 29);
  v_days  jsonb := '[]'::jsonb;
  v_total bigint := 0;
BEGIN
  IF v_from > v_to THEN
    RAISE EXCEPTION 'cdp_l0_daily_counts: p_from (%) が p_to (%) より後。', v_from, v_to;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'day',     to_char(d.day, 'YYYY-MM-DD'),
           'events',  d.events,
           'unknown', d.unknown
         ) ORDER BY d.day), '[]'::jsonb),
         coalesce(sum(d.events), 0)
    INTO v_days, v_total
    FROM (
      SELECT (e.recorded_at AT TIME ZONE 'Asia/Tokyo')::date AS day,
             count(*)                                        AS events,
             count(*) FILTER (WHERE e.schema_ok = false)      AS unknown
        FROM customer_events e
       WHERE (e.recorded_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN v_from AND v_to
       GROUP BY 1
    ) d;

  RETURN jsonb_build_object(
    'from',  to_char(v_from, 'YYYY-MM-DD'),
    'to',    to_char(v_to,   'YYYY-MM-DD'),
    'tz',    'Asia/Tokyo',
    'total', v_total,
    'days',  v_days
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l0_daily_counts(date, date) IS
  'E8'' の Supabase 側。L0 の行数を JST の日で数える（recorded_at 基準）。'
  ' SQLite 側（elxea-cdp）が同じ日に同じ数を持っていなければ、その日の吸い上げが'
  ' 落ちている。読み取り専用・PII を返さない（数だけ）。';

-- ===================================================================
-- 2. cdp_subject_shopify_map — persons.subject_id 1:1 の唯一の材料
--
--     「この Shopify 顧客番号の人は、CDP ではこの主体である」を返す。
--     ページングは identity_edges.edge_seq（単調増加）で行う。
--
--     ─ 返さないもの（意図的）─
--       生 LINE userId / LINE Login の sub / email_hash / 会話・出来事の中身。
--       返すのは Shopify 顧客番号（既に SQLite の persons.ec_customer_id にある値）と
--       canonical な主体 ID の 2 列だけ。**新しい PII をローカルに増やさない。**
--
--     ─ 退役した主体は返さない ─
--       GDPR 消去で retired_at が立った主体は edges ごと消えるので自然に落ちるが、
--       edges が残ったまま retire される経路が将来できても漏れないよう明示で外す。
--
--     引数: p_after_edge_seq より大きい edge を、edge_seq 昇順で p_limit 件。
--     返り: { "rows": [ { edge_seq, subject_id, shopify_customer_id } ], "next": seq|null }
--
--     @reader elxea-cdp/l0-ingest.mjs
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_subject_shopify_map(
  p_after_edge_seq bigint  DEFAULT 0,
  p_limit          integer DEFAULT 500
)
RETURNS jsonb AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_rows  jsonb   := '[]'::jsonb;
  v_next  bigint;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'edge_seq',            r.edge_seq,
           'subject_id',          r.canonical_subject_id,
           'shopify_customer_id', r.identifier_value
         ) ORDER BY r.edge_seq), '[]'::jsonb),
         max(r.edge_seq)
    INTO v_rows, v_next
    FROM (
      SELECT e.edge_seq,
             e.identifier_value,
             cdp_canonical_subject(e.subject_id) AS canonical_subject_id
        FROM identity_edges e
        JOIN subjects s ON s.subject_id = e.subject_id
       WHERE e.identifier_kind = 'shopify_customer_id'
         AND e.edge_seq > coalesce(p_after_edge_seq, 0)
         AND s.retired_at IS NULL
       ORDER BY e.edge_seq
       LIMIT v_limit
    ) r;

  RETURN jsonb_build_object(
    'rows', v_rows,
    -- 次に続きがあるときだけ次の起点を返す。無ければ null（＝ここで終わり）。
    'next', CASE WHEN jsonb_array_length(v_rows) = v_limit THEN v_next ELSE NULL END
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_subject_shopify_map(bigint, integer) IS
  'Stage 3。主体（canonical）と Shopify 顧客番号の対応を edge_seq 順に返す。'
  ' SQLite の persons.subject_id を 1:1 で埋める唯一の材料。'
  ' ⚠ 生 LINE userId / email_hash は返さない（E5 / SEC-1）。';
