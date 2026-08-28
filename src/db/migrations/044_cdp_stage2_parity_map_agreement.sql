-- ===================================================================
-- 044: 「新旧一致」の判定に、★11 の読出が引いている旧台帳を入れ忘れていた
--      （CDP Stage 2 の QA 指摘 MID-1 / 043 の cdp_stage2_parity() の是正）
-- ===================================================================
--
-- 一次入力: CDP 統合 Stage 2 の QA 指摘 MID-1
--   設計の正本: 顧客データ統合 統合設計（最終案）§6-1 Stage 2 の完了条件 /
--   §4 C-1（★11 LINE 会話の断線）
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ 何がおかしかったか ─
--
-- Stage 2 の完了条件は「**新旧**解決の一致率 100% を 5 営業日観測」である。
-- 043 が作った cdp_stage2_parity() は、その「一致した 1 日」を
--
--     linked_without_link = 0 AND delivery_identity_missing = 0
--                             AND multi_line_components = 0
--
-- で判定していた。ここに identity_map_without_link が入っていない。
--
-- ところが ★11（C-1）の断線そのものは **user_identity_map を引く読出** で起きている:
--
--     src/lib/supabase.ts  getCrossChannelMessages   … user_identity_map のみ参照
--     src/lib/identity.ts  resolveUnifiedUserId      … 同上
--
-- つまり user_identity_map は「新旧一致」の **旧** の側に確かに含まれる台帳であり、
-- customer_linkages（もう 1 冊）だけを旧として数えるのは、直そうとしている当の
-- 断線が起きている台帳を判定から外していることになる。
--
-- 数そのものは 043 も返していた（identity_map_without_link）。**返しているのに
-- 判定に使っていなかった** — これは「観測はしているが合否に効かない」形で、
-- 5 営業日の観測が「一致していない日を一致とみなしたまま」埋まりうる。
--
-- ─ どう直すか ─
--
-- in_agreement に identity_map_without_link = 0 を足す。あわせて、
-- どの数が 0 でなかったのかを 1 目で言える in_agreement_by（内訳）を返す。
-- false の日に「何が破れたのか」を探しに行かなくて済む形にするため。
--
-- ─ 043 を書き換えない理由 ─
--
-- 043 は本番に適用済みである（2026-08-28）。適用済み migration の中身を後から
-- 書き換えると、schema_migrations 台帳の「043 は適用済み」という記録と、実際に
-- 当たった SQL の内容が食い違う。よって是正は必ず次の番号として足す。
--
-- ─ 観測中の 5 営業日への影響（重要・運用者向け）─
--
-- 新しい判定は古い判定の **狭め方**（AND 条件を 1 つ足しただけ）である。よって:
--
--   (a) 044 で in_agreement=true になる日は、043 の定義でも必ず true だった。
--       緩める方向の変更ではないので「観測をやり直せば通る」類の抜け道は生まれない。
--   (b) **過去の日も後から判定し直せる**。043 は identity_map_without_link を
--       日次ログ（src/lib/cdp/stage2-parity.ts → runDailySync の 1 行 JSON）に
--       毎日出していたので、既に流れたログを読み直せば新しい定義での合否が出る。
--       観測をゼロからやり直す必要は無い。
--
-- ─ この判定が「永久に false」になりうる場合（意図した挙動）─
--
-- user_identity_map には Stage 2 より前に旧 identity/link 経路で書かれた行が
-- ありうる。それらは subject_links を持たないので identity_map_without_link に
-- 数え上がり、in_agreement は false のままになる。
--
-- **これは誤検知ではない。** その行が指す人は、いまも user_identity_map 経由でしか
-- 横断読み出しに乗っておらず、新台帳（identity_edges / subject_links）から見ると
-- 存在しない。Stage 5 で user_identity_map を落とす（T-6）とき、その人の横断は
-- 黙って消える。だから「落とす前に link を足しておけ」と言うのがこの数の役目で
-- あり、0 になるまで Stage 2 の観測を閉じないのが正しい。
--
-- 本番は連携 0 件（2026-08-25 実測）なので、現時点でこの数は 0 である。
--
-- ⚠ 040 / 041 / 042 / 043 が先に当たっていること。
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION のみ。何度当てても同じ。
--            新しいオブジェクトを作らないので migrate.ts 側の sentinel は持たない
--            （042 と同じ no-sentinel 扱い）。
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認
-- ===================================================================
DO $$
BEGIN
  IF to_regproc('public.cdp_stage2_parity') IS NULL THEN
    RAISE EXCEPTION '044: cdp_stage2_parity が無い。043 を先に当てること。';
  END IF;
  IF to_regclass('public.user_identity_map') IS NULL THEN
    RAISE EXCEPTION '044: user_identity_map が無い。006 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. 突合（読み取り専用）— 判定に旧台帳 2 冊とも入れる
--
--     数えるものは 043 から変えない（列は 1 つも減らさない）。変えたのは
--     in_agreement の式と、内訳 in_agreement_by の追加だけ。
--
--     一致した 1 日 = 次の 4 つがすべて 0:
--       linked_without_link       … customer_linkages で連携済みなのに link が無い
--       identity_map_without_link … user_identity_map で連携済みなのに link が無い
--                                   ← 044 で判定に入れた（MID-1）
--       delivery_identity_missing … 連携済みなのに配信の宛先の派生が無い
--       multi_line_components     … 1 成分に LINE が 2 本以上（J-4 破れ）
--
--     @reader src/lib/cdp/stage2-parity.ts
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_stage2_parity()
RETURNS jsonb AS $$
DECLARE
  v_linked_rows        bigint := 0;
  v_linked_without     bigint := 0;
  v_map_rows           bigint := 0;
  v_map_without        bigint := 0;
  v_delivery_rows      bigint := 0;
  v_delivery_missing   bigint := 0;
  v_links_total        bigint := 0;
  v_by_basis           jsonb  := '{}'::jsonb;
  v_max_component      integer := 0;
  v_multi_line         bigint := 0;
BEGIN
  SELECT count(*) INTO v_linked_rows
    FROM customer_linkages
   WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL;

  -- 旧台帳で連携済みなのに、追記型の link が無い人。
  -- 「両方の主体が発行済みで、かつ同じ連結成分に居る」ことを一致とみなす。
  SELECT count(*) INTO v_linked_without
    FROM customer_linkages cl
   WHERE cl.line_user_id IS NOT NULL
     AND cl.shopify_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM identity_edges le
         JOIN identity_edges se
           ON se.identifier_kind = 'shopify_customer_id'
          AND se.identifier_value = cl.shopify_customer_id
        WHERE le.identifier_kind = 'line_messaging_uid'
          AND le.identifier_value = cl.line_user_id
          AND se.subject_id = ANY (cdp_subject_component(le.subject_id))
     );

  SELECT count(*) INTO v_map_rows
    FROM user_identity_map
   WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL;

  SELECT count(*) INTO v_map_without
    FROM user_identity_map m
   WHERE m.line_user_id IS NOT NULL
     AND m.shopify_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM identity_edges le
         JOIN identity_edges se
           ON se.identifier_kind = 'shopify_customer_id'
          AND se.identifier_value = m.shopify_customer_id
        WHERE le.identifier_kind = 'line_messaging_uid'
          AND le.identifier_value = m.line_user_id
          AND se.subject_id = ANY (cdp_subject_component(le.subject_id))
     );

  SELECT count(*) INTO v_delivery_rows FROM delivery_identity;

  SELECT count(*) INTO v_delivery_missing
    FROM customer_linkages cl
   WHERE cl.line_user_id IS NOT NULL
     AND cl.shopify_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM delivery_identity di WHERE di.line_user_id = cl.line_user_id
     );

  SELECT count(*) INTO v_links_total FROM subject_links;

  SELECT coalesce(jsonb_object_agg(basis, n), '{}'::jsonb) INTO v_by_basis
    FROM (SELECT basis, count(*) AS n FROM subject_links GROUP BY basis) q;

  -- 連結成分の大きさ。link を持つ主体だけを見れば足りる（持たない人は必ず 1）。
  SELECT coalesce(max(sz), 0) INTO v_max_component FROM (
    SELECT coalesce(array_length(cdp_subject_component(s), 1), 1) AS sz
      FROM (SELECT DISTINCT subject_a AS s FROM subject_links
             UNION SELECT DISTINCT subject_b FROM subject_links) m
  ) q;

  -- J-4 の破れ（常に 0 であるべき。トリガが効いていれば入らない）。
  SELECT count(*) INTO v_multi_line FROM (
    SELECT m.s
      FROM (SELECT DISTINCT subject_a AS s FROM subject_links
             UNION SELECT DISTINCT subject_b FROM subject_links) m
     WHERE (SELECT count(DISTINCT e.identifier_value)
              FROM identity_edges e
             WHERE e.subject_id = ANY (cdp_subject_component(m.s))
               AND e.identifier_kind = 'line_messaging_uid') > 1
  ) q;

  RETURN jsonb_build_object(
    'linked_ledger_rows',        v_linked_rows,
    'linked_without_link',       v_linked_without,
    'identity_map_linked_rows',  v_map_rows,
    'identity_map_without_link', v_map_without,
    'delivery_identity_rows',    v_delivery_rows,
    'delivery_identity_missing', v_delivery_missing,
    'links_total',               v_links_total,
    'links_by_basis',            v_by_basis,
    'max_component_size',        v_max_component,
    'multi_line_components',     v_multi_line,
    -- 一致しているか（この 4 つが 0 の日が「一致 100%」の 1 日）。
    -- ⚠ 044 で identity_map_without_link を足した（MID-1）。旧台帳は 2 冊あり、
    --   ★11 の読出が引いているのは足したほうである。
    'in_agreement',              (v_linked_without = 0
                                  AND v_map_without = 0
                                  AND v_delivery_missing = 0
                                  AND v_multi_line = 0),
    -- false の日に「どれが破れたのか」を探しに行かなくて済むようにする内訳。
    -- 判定条件はここと in_agreement の 2 か所に書かれるが、同じ変数を見ている
    -- ので食い違いようがない（式を 2 度書いているのではなく、AND を分解している）。
    'in_agreement_by', jsonb_build_object(
      'linked_without_link',       v_linked_without = 0,
      'identity_map_without_link', v_map_without = 0,
      'delivery_identity_missing', v_delivery_missing = 0,
      'multi_line_components',     v_multi_line = 0
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_stage2_parity() IS
  'Stage 2 の並走突合（読み取り専用）。旧台帳と追記型 link の解決が食い違っていないかを'
  ' 1 回の呼び出しで数える。日次 tick から呼ばれ、1 行の JSON ログとして残る。'
  ' 一致した 1 日 = linked_without_link / identity_map_without_link /'
  ' delivery_identity_missing / multi_line_components がすべて 0（044 / MID-1:'
  ' ★11 の読出が引く user_identity_map を判定に含める）。';
