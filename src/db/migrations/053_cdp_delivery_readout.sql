-- 053: 送った記録の台帳を「読む口」を 1 本開ける（roji タッチポイント地図 A-0）
--
-- 設計正本: roji体験目的 × タッチポイント全体地図（2026-09-02・Setaka 承認済み）
--   第4章 A-0「送った記録の台帳を『読む口』を作る」/ 優先順位 1 位
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/roji-experience-touchpoint-map-20260902.md
-- 上位の正本: rojiマスタースペック https://app.notion.com/p/3af70c9d064c81a08be5eab8027dc2f4 第4章
-- 併読: 顧客データ統合 統合設計（最終案, 2026-08-28）§4-5 物理配置 / §5 E3・E5
--
-- ===================================================================
-- ─ この migration が答える問い ─
--
--   「この人に、先月どのお茶とどの号を送ったか」を **Web アプリ側から引く経路**が無い。
--
--   台帳への **書き込みは既に動いている**（033 の割当・038 の配送・PR #63 の L0 積み）。
--   足りていないのは読む側だけで、A-1（先月への返事）・A-4（また入れて / もういらない）・
--   A-5（じぶんのページの月別履歴）・A-7（購入履歴からの導線）が 4 つともここに依存している。
--
-- ─ なぜ「台帳」を読むのか（L0 の shipment.sent ではなく）─
--
--   L0 に `shipment.sent` を積む経路は PR #63 で通っている（src/lib/cdp/shipment.ts）。
--   それでも本口が台帳を読むのは、L0 だけでは A-0 の問いに **今は答えられない**ため。
--   理由は 3 つあり、いずれも実装の実測である:
--
--     (1) 手渡し・EC 開店前の実配送は L0 に載っていない。
--         `scripts/record-delivery.ts` は台帳（038）にだけ書き、`shipment.sent` を
--         積まない（同ファイル冒頭に明記。主体の発行が supabase-js 側にしか無いため）。
--         EC は未開店なので、**いま実在する配送はほぼ全部この経路**である。
--         L0 だけを読む口は、いちばん要る時期に空を返す。
--     (2) L0 の payload が持つ銘柄の参照は Shopify の product_id 系
--         （`src/lib/delivery-ledger.ts` の itemRef）で、5 桁の銘柄番号ではない。
--         評価の口（rating.submitted）が要求するのは 5 桁の `product_no` なので、
--         L0 の参照だけでは「どの一杯について聞くか」を組み立てられない。
--     (3) 号（issue_ref）は 033 にしか無い。038 にも L0 の EC 経路にも載らない。
--
--   よって役割はこうなる。**どちらも消さない**:
--     L0 `shipment.sent` … 「その主体の身に送付が 1 回起きた」時系列。
--                          回答率（051 の cdp_l0_rating_response_rate）の分母。
--     本口                … 「その月に何を送ることにして、実際に何が届いたか」の中身。
--
-- ─ 決めたこと（033）と 届いたこと（038）を混ぜない ─
--
--   038 の冒頭が明記しているとおり、両者は別の事実で、ずれることがある
--   （欠品・変更・返品）。よって本口は **1 つの配列に畳まず**、period で並べた上で
--   `assigned`（033・決めた）と `delivered`（038・届いた）を別のキーに置く。
--   畳むと「届いていないものを届いたと言う」経路が生まれる。
--
-- ─ 出所タグ（basis）─
--   `assigned` は 033 の割当そのものなので出所は 1 つ（"assignment"）。
--   `delivered` は行ごとに 038 が持つ `date_basis`（ordered/fulfilled/manual）と
--   `source`（shopify_order/manual/roji_assignment）をそのまま返す。捏造しない。
--
-- ─ 返さないもの（意図的・R8 / E5）─
--   subject_id / 生の LINE userId / Shopify 顧客番号 / 住所・宛名・メール /
--   038 の `note`（手動投入の自由文）/ 033 の `estimate_snapshot`・`monthly_note`・
--   `candidates_not_chosen`・`preview_*`（凍結した推定と運営の判断であって、
--   「何を送ったか」ではない）。要配慮情報に当たる列は 1 つも通さない。
--
-- ─ 誰の記録かをどう解くか ─
--   Web アプリが手元に持つ鍵は Shopify 顧客番号 / LINE Login の sub / 匿名 ID で、
--   **台帳の鍵（Shopify 顧客番号 / LINE Messaging の userId）とは種類が違う**。
--   よって鍵 → 主体 → 連結成分 → その人の全ての鍵、と解いてから台帳を引く。
--   解き方の正本は 043/049 の `cdp_subject_component` 1 本のままで、
--   **ここに 2 本目の解決を作らない**。
--
-- ─ 読むだけ ─ INSERT / UPDATE / DELETE を 1 つも含まない。STABLE。
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION のみ。何度当てても同じ。
-- ─ 破壊性 ─ 追加のみ。既存の表・列・関数・データに一切触れない。
--
-- ─ 適用手順 ─
--   npx tsx scripts/migrate.ts --only 053 --dry-run
--   SUPABASE_DB_PASSWORD=… npx tsx scripts/migrate.ts --only 053 --apply
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認（無い物の上に建てない）
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.roji_delivery_ledger') IS NULL THEN
    RAISE EXCEPTION '053: roji_delivery_ledger が無い。033 を先に当てること。';
  END IF;
  IF to_regclass('public.tea_delivery_ledger') IS NULL THEN
    RAISE EXCEPTION '053: tea_delivery_ledger が無い。038 を先に当てること。';
  END IF;
  IF to_regclass('public.identity_edges_live') IS NULL THEN
    RAISE EXCEPTION '053: identity_edges_live が無い。049 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_subject_component') IS NULL THEN
    RAISE EXCEPTION '053: cdp_subject_component が無い。043 / 049 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. 返す月数の丸め（1〜36）
--
--   上限を置くのは、じぶんのページが「本棚」として増え続ける面だから
--   （roji 正本 3-2⑥）。無制限に引くと、号が溜まるほど 1 回の読みが重くなる。
--   36 は「3 年分」で、これ以上を 1 回で返す使い道が今は無い。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_delivery_months_bound(p_months integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT least(greatest(coalesce(p_months, 12), 1), 36);
$$;

COMMENT ON FUNCTION cdp_delivery_months_bound(integer) IS
  '送付履歴の読み口が 1 回に返す月数の丸め（1〜36・既定 12）。'
  ' 引数を黙って捨てず、範囲外は丸める（読み口が綴りで止まらないようにする）。';

-- ===================================================================
-- 2. 送付履歴の読み口（A-0 の本体）
--
--   入力: 人を指す鍵 1 つ（種類 + 値）。
--   出力: 月ごとの「決めたこと」と「届いたこと」。人を指す値は 1 つも返さない。
--
--   ⚠ p_kind = 'email_hash' は解決に使わない（SEC-1）。042 / 049 の解決関数と
--     同じ枝をここにも置く。ここだけ緩めると、メールが同じなら同じ人という
--     経路が 1 本だけ生える。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_delivery_history_for_identifier(
  p_kind   text,
  p_value  text,
  p_months integer DEFAULT 12
) RETURNS jsonb AS $$
DECLARE
  v_months   integer := cdp_delivery_months_bound(p_months);
  v_seed     text;
  v_all      text[];
  v_members  text[];
  v_shopify  text[] := ARRAY[]::text[];
  v_line     text[] := ARRAY[]::text[];
  v_periods  jsonb  := '[]'::jsonb;
BEGIN
  IF p_kind IS NULL OR p_value IS NULL OR btrim(p_value) = '' THEN
    RETURN jsonb_build_object('found', false, 'reason', 'identifier_empty');
  END IF;
  IF p_kind = 'email_hash' THEN
    RETURN jsonb_build_object('found', false, 'reason', 'identifier_kind_not_resolvable');
  END IF;

  -- (a) 鍵 → 主体。取り消された観測は辿らない（identity_edges_live）。
  SELECT e.subject_id INTO v_seed
    FROM identity_edges_live e
   WHERE e.identifier_kind = p_kind
     AND e.identifier_value = btrim(p_value)
   LIMIT 1;

  IF v_seed IS NULL THEN
    -- まだ主体が発行されていない人（gateway を 1 度も通っていない）。
    -- 「履歴が無い」ではなく「引けなかった」を返す（T-12: 無言で戻らない）。
    RETURN jsonb_build_object('found', false, 'reason', 'subject_not_found');
  END IF;

  -- (b) 主体 → 同じ人の主体すべて。消去済みの主体は外す
  --     （消した人の記録は復活しない。041 のトリガと同じ姿勢を読み側にも置く）。
  v_all := cdp_subject_component(v_seed);
  SELECT coalesce(array_agg(s.subject_id ORDER BY s.subject_id), ARRAY[]::text[])
    INTO v_members
    FROM subjects s
   WHERE s.subject_id = ANY (v_all)
     AND s.retired_at IS NULL;

  IF coalesce(array_length(v_members, 1), 0) = 0 THEN
    RETURN jsonb_build_object('found', false, 'reason', 'subject_retired');
  END IF;

  -- (c) その人の「台帳を引ける鍵」を集める。台帳が持つのはこの 2 種だけ
  --     （038 の shopify_customer_id / line_user_id・033 は shopify_customer_id のみ）。
  --     LINE Login の sub や web の匿名 ID は台帳の鍵ではないので拾わない。
  SELECT coalesce(array_agg(DISTINCT e.identifier_value), ARRAY[]::text[])
    INTO v_shopify
    FROM identity_edges_live e
   WHERE e.subject_id = ANY (v_members)
     AND e.identifier_kind = 'shopify_customer_id';

  SELECT coalesce(array_agg(DISTINCT e.identifier_value), ARRAY[]::text[])
    INTO v_line
    FROM identity_edges_live e
   WHERE e.subject_id = ANY (v_members)
     AND e.identifier_kind = 'line_messaging_uid';

  -- (d) 月ごとに「決めたこと」と「届いたこと」を並べる。
  --
  --     ⚠ 2 つを FULL OUTER JOIN で突き合わせる。片方だけの月（決めたが届いていない /
  --       届いたが割当の行が無い）を落とさないため。落とすと、ずれがいちばん
  --       見たいときに見えない。
  WITH assigned AS (
    -- 1 月 1 行に確定させる。033 は UNIQUE (shopify_customer_id, period) なので
    -- **同じ人が EC の顧客番号を 2 つ持っている**ときだけ同じ月が 2 行になりうる。
    -- それは 1 鍵 1 主体の異常であって、ここで 2 つの割当を合成して良いという
    -- 意味ではない。合成せず、顧客番号の昇順で 1 行に決める（決定的）。
    SELECT DISTINCT ON (r.period)
           r.period,
           r.issue_ref,
           r.teas
      FROM roji_delivery_ledger r
     WHERE r.shopify_customer_id = ANY (v_shopify)
     ORDER BY r.period, r.shopify_customer_id
  ),
  delivered_rows AS (
    SELECT t.period,
           jsonb_build_object(
             'item_ref',     t.item_ref,
             'item_name',    t.item_name,
             'item_kind',    t.item_kind,
             'quantity',     t.quantity,
             'delivered_on', to_char(t.delivered_on, 'YYYY-MM-DD'),
             -- 出所タグ。捏造しない（038 が持っている値をそのまま返す）。
             'date_basis',   t.date_basis,
             'source',       t.source
           ) AS row_json,
           t.delivered_on,
           t.item_ref
      FROM tea_delivery_ledger t
     -- 038 は「EC の顧客番号か LINE の ID の少なくとも一方」で書ける。名寄せが
     -- 通る前に書いた行（LINE だけ）と、通った後の行（顧客番号）が同じ人の
     -- 履歴として並ぶのは、両方を OR で引くこの 1 か所だけである。
     WHERE t.shopify_customer_id = ANY (v_shopify)
        OR t.line_user_id = ANY (v_line)
  ),
  delivered AS (
    SELECT d.period,
           jsonb_agg(d.row_json ORDER BY d.delivered_on, d.item_ref) AS rows_json
      FROM delivered_rows d
     GROUP BY d.period
  ),
  merged AS (
    SELECT coalesce(a.period, d.period) AS period,
           a.issue_ref,
           a.teas,
           (a.period IS NOT NULL) AS has_assignment,
           d.rows_json
      FROM assigned a
      FULL OUTER JOIN delivered d ON d.period = a.period
  ),
  -- 新しい月が先頭。月数の上限はここで掛ける（行数ではなく月数で刻む）。
  windowed AS (
    SELECT * FROM merged
     WHERE period IS NOT NULL
     ORDER BY period DESC
     LIMIT v_months
  )
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'period' DESC), '[]'::jsonb)
    INTO v_periods
    FROM (
      SELECT jsonb_build_object(
        'period', w.period,
        -- 決めたこと（033）。行が無い月は null（空の器を作らない）。
        'assigned',
          CASE WHEN w.has_assignment THEN
            jsonb_build_object(
              'issue_ref', w.issue_ref,
              -- 033 の teas は [{number, name}]。口の語彙は 5 桁番号を指す
              -- 'product_no' に揃える（評価の payload・Tea Menu と同じ言葉）。
              'teas', coalesce((
                SELECT jsonb_agg(
                         jsonb_build_object(
                           'product_no', e ->> 'number',
                           'name',       e ->> 'name'
                         ) ORDER BY e ->> 'number')
                  FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(w.teas) = 'array'
                              THEN w.teas ELSE '[]'::jsonb END) e
                 WHERE nullif(btrim(coalesce(e ->> 'number', '')), '') IS NOT NULL
              ), '[]'::jsonb),
              'basis', 'assignment'
            )
          END,
        -- 届いたこと（038）。行が無い月は空配列。
        'delivered', coalesce(w.rows_json, '[]'::jsonb)
      ) AS x
      FROM windowed w
    ) s;

  RETURN jsonb_build_object(
    'found',   true,
    'months',  v_months,
    -- どの種類の鍵で台帳を引けたか（**件数だけ**。値は返さない）。
    -- 0 件のときに「履歴が無い」のか「鍵が繋がっていない」のかを、
    -- 呼ぶ側が値を見ずに切り分けられるようにする。
    'keys', jsonb_build_object(
      'shopify_customer_id', coalesce(array_length(v_shopify, 1), 0),
      'line_messaging_uid',  coalesce(array_length(v_line, 1), 0)
    ),
    'periods', v_periods
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_delivery_history_for_identifier(text, text, integer) IS
  'A-0 送った記録の台帳の読み口。人を指す鍵 1 つから、月ごとの「決めたこと」(033) と'
  ' 「届いたこと」(038) を返す。**2 つを 1 つの配列に畳まない**（決めた ≠ 届いた）。'
  ' 返り値に subject_id・生の LINE userId・Shopify 顧客番号・住所・自由文を 1 つも載せない。'
  ' email_hash では引かない（SEC-1）。消去済みの主体には found=false を返す。読み取り専用。';
