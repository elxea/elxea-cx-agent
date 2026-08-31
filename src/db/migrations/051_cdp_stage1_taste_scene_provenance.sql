-- 051: 顧客プロファイル 第1段 —「材料を取り始める」ための器
--
-- 設計正本: elxea顧客プロファイル設計 rev.3.2（2026-09-01 択一 11 件 確定版）
--   §6「段階実装案」第1段 ① 届いた後の評価 / ③ 出所タグと取得日時 / ⑤ 誰のために / ⑦ 回答率の計測
--   §7 択一 #3 = (c) 既存 2 軸 + 渋みの 3 軸 / #4 = (c) 5 段階（内部利用のみ・星も数値も見せない）
-- 併読: 顧客データ統合 統合設計（最終案, 2026-08-28）§3-2 L0/L1 / §5 E1・E4・E8'
--
-- ─ この migration が答える問い ─
--
--   「届いた一杯にどう感じたか」「誰のために買ったか」を **どこに積むか**。
--   いまはどちらにも置き場が無い（rating は product_ratings と L0 に積まれるが
--   L1 に畳まれず、贈答かどうかはどこにも無い）。
--
-- ─ 第1段の範囲（意図的に狭い）─
--
--   設計 §6 の第1段は「材料を取り始める」段である。よってここでやるのは
--   **事実を積み、出所を付けて L1 に置く**ところまで。
--   軸の位置の推論（減衰・窓・重み・「まだ分からない」の閾値）は **第3段 ⑯** であり、
--   ここには書かない。書くと、材料が数か月ぶん貯まる前に検証できない計算式が固定される。
--
-- ─ なぜ第1段で出所タグ（③）を入れるのか ─
--
--   後から足せないため。設計 §6 が「出所タグを最初に入れないと、後で
--   『どれを本人に直させてよいか』が判定できなくなる」と明記している。
--   採用順は declared > observed > inferred（設計 §4 R3）。
--
-- ─ 畳み方の正本の移動（重要）─
--
--   046 が置いた cdp_l1_build_profile / cdp_l1_recompute_subject / cdp_l1_recompute_parity を
--   **CREATE OR REPLACE で差し替える**。畳み方の定義は引き続き 1 か所（この 051 の
--   cdp_l1_build_profile）だけで、046 の本体は履歴として残るだけになる
--   （036 → 037 が roji_erase_person を差し替えたのと同じ作法）。
--
-- ─ 冪等性 ─ ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE FUNCTION のみ。何度当てても同じ。
-- ─ 破壊性 ─ 追加のみ。列の削除・型変更・データ書き換えを一切行わない。
-- ─ 消せる ─ subject_profile は 037 の列挙で既に消去対象に入っている（列を足しても変わらない）。

-- ===================================================================
-- 0. 前提の確認（無い物の上に建てない）
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.subject_profile') IS NULL THEN
    RAISE EXCEPTION '051: subject_profile が無い。046 を先に当てること。';
  END IF;
  IF to_regclass('public.customer_events') IS NULL THEN
    RAISE EXCEPTION '051: customer_events が無い。041 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_subject_component') IS NULL THEN
    RAISE EXCEPTION '051: cdp_subject_component が無い。043 を先に当てること。';
  END IF;
  -- 回答率（第1段 ⑦）は分子も分母も customer_events（L0）から採るので、
  -- 上の customer_events の確認で足りる。配送台帳（038）は直接引かない
  -- （理由は §6 の「分母を L0 の shipment.sent から採る理由」）。
END;
$$;

-- ===================================================================
-- 1. 語彙（TypeScript 側 src/lib/cdp/taste-axes.ts と 1 対 1）
--
--   ⚠ 2 か所にあるのは Stage 4 の persona 軸と同じ事情（畳み手が SQL、口が TS）。
--     せめて「どちらも同じ語彙である」ことをテストで留める
--     （tests/unit/cdp-taste-axes.test.ts / tests/db/cdp-stage1-taste.db.test.ts）。
-- ===================================================================

/** 味の軸の並び。TS 側 TASTE_AXES と同一・同順。 */
CREATE OR REPLACE FUNCTION cdp_taste_axes() RETURNS text[] AS $$
  SELECT ARRAY['astringency', 'body', 'aroma']::text[];
$$ LANGUAGE sql IMMUTABLE;

/** 軸ごとの極。TS 側 TASTE_AXIS_POLES と同一。 */
CREATE OR REPLACE FUNCTION cdp_taste_poles(p_axis text) RETURNS text[] AS $$
  SELECT CASE p_axis
    WHEN 'astringency' THEN ARRAY['soft', 'firm']
    WHEN 'body'        THEN ARRAY['light', 'full']
    WHEN 'aroma'       THEN ARRAY['dry', 'rich']
    ELSE ARRAY[]::text[]
  END;
$$ LANGUAGE sql IMMUTABLE;

/** 出所の強さ。TS 側 PROVENANCE_RANK と同一（設計 §4 R3 の採用順）。 */
CREATE OR REPLACE FUNCTION cdp_provenance_rank(p_kind text) RETURNS int AS $$
  SELECT CASE p_kind
    WHEN 'declared' THEN 3
    WHEN 'observed' THEN 2
    WHEN 'inferred' THEN 1
    ELSE 0
  END;
$$ LANGUAGE sql IMMUTABLE;

/**
 * 出所タグを 1 件足す（強いほうが勝つ。同じ強さなら新しいほう）。
 * TS 側 preferProvenance と同じ決め方。
 *
 * p_bag  … field -> {kind, at} の入れ物
 * p_field… どの項目についての出所か
 *
 * ⚠ IMMUTABLE ではなく STABLE で宣言する。本体が to_char(timestamp, text) を呼ぶが、
 *   これはロケール依存があるため PostgreSQL 側で STABLE として定義されている。
 *   plpgsql の volatility 宣言は作成時に検査されない（宣言をそのまま信じる）ので、
 *   IMMUTABLE と偽ると index や CHECK から使われたときだけ静かに壊れる。
 *   この関数は cdp_l1_build_profile（STABLE）の中からしか呼ばないので STABLE で足りる。
 */
CREATE OR REPLACE FUNCTION cdp_provenance_put(
  p_bag jsonb, p_field text, p_kind text, p_at timestamptz
) RETURNS jsonb AS $$
DECLARE
  v_cur  jsonb;
  v_at   text := to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_new  jsonb := jsonb_build_object('kind', p_kind, 'at', v_at);
BEGIN
  IF p_field IS NULL OR p_field = '' OR cdp_provenance_rank(p_kind) = 0 THEN
    RETURN p_bag;
  END IF;

  v_cur := p_bag -> p_field;
  IF coalesce(jsonb_typeof(v_cur), 'null') <> 'object' THEN
    RETURN jsonb_set(p_bag, ARRAY[p_field], v_new, true);
  END IF;

  -- 強いほうが勝つ。同じ強さなら新しいほう（減衰の思想と整合）。
  IF cdp_provenance_rank(v_cur ->> 'kind') > cdp_provenance_rank(p_kind) THEN
    RETURN p_bag;
  END IF;
  IF cdp_provenance_rank(v_cur ->> 'kind') = cdp_provenance_rank(p_kind)
     AND (v_cur ->> 'at') > v_at THEN
    RETURN p_bag;
  END IF;
  RETURN jsonb_set(p_bag, ARRAY[p_field], v_new, true);
END;
$$ LANGUAGE plpgsql STABLE;

-- ===================================================================
-- 2. L1 に 3 列足す
--
--   ⚠ PII を入れない（subject_profile の既定どおり）。銘柄番号は商品の識別子であって
--     人の識別子ではないので入れてよい。会話の本文・住所・氏名は入れない。
-- ===================================================================

ALTER TABLE subject_profile
  ADD COLUMN IF NOT EXISTS taste      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS scene      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN subject_profile.taste IS
  '味について分かっていること（第1段は**材料のみ**・推論しない）。'
  ' declared … 本人が言った軸の極（taste.declared）。'
  ' evidence … 届いた後の評価の集計。by_product（銘柄ごと）/ by_month（暦の月ごと）/ totals。'
  ' ⚠ score は内部利用のみ。星も数値もお客さんに見せない（設計 §7 #4 の確定条件）。'
  ' ⚠ 月のキーは JST の暦月。now 相対の窓にしないのは、保存値と再計算値が時間の経過だけで'
  ' 食い違わないようにするため（046 の persona_windows と同じ理由）。';

COMMENT ON COLUMN subject_profile.scene IS
  '「誰のために買ったか」（設計 §6 第1段 ⑤ / §3「自分用と贈答は別モデル」）。'
  ' counts … self / gift の件数。primary … 多いほう（同数は null = まだ言えない）。'
  ' 自分用と贈答は構造が違うので、後から 1 本のベクトルに畳まない。';

COMMENT ON COLUMN subject_profile.provenance IS
  '項目ごとの出所タグと取得日時（設計 §6 第1段 ③）。field -> {kind, at}。'
  ' kind は declared（本人が言った）/ observed（見て分かった）/ inferred（推定した）。'
  ' 採用順は declared > observed > inferred（設計 §4 R3）。同じ強さなら新しいほう。'
  ' ⚠ これが無いと「どの行を本人に直させてよいか」が後から判定できない。';

-- ===================================================================
-- 3. 畳み方（046 の cdp_l1_build_profile を差し替え）
--
--    046 からの差分は 3 点だけ:
--      (a) taste / scene / provenance を導出値に足した
--      (b) rating.submitted / taste.declared / purchase.recipient_declared を畳むようにした
--      (c) 既存の枝すべてに出所タグを付けた
--    persona・exclusions・overrides・notify の畳み方は **1 文字も変えていない**
--    （変えると E8' の一致判定で「ずれた」のか「直した」のか区別できなくなる）。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_build_profile(p_subject_id text)
RETURNS jsonb AS $$
DECLARE
  v_canonical  text;
  v_members    text[];
  v_scores     jsonb := cdp_persona_zero();
  v_sources    jsonb := '{}'::jsonb;
  v_windows    jsonb := '{}'::jsonb;
  v_tea        text[] := ARRAY[]::text[];
  v_safety     text[] := ARRAY[]::text[];
  v_suppress   boolean := false;
  v_overrides  jsonb := '{}'::jsonb;
  v_notify     jsonb := '{}'::jsonb;
  v_primary    text := NULL;
  v_total      bigint := 0;
  v_folded     bigint := 0;
  v_last_seq   bigint := 0;
  v_last_at    timestamptz;
  r            record;
  v_axis       text;
  v_delta      numeric;
  v_before     numeric;
  v_after      numeric;
  v_eff        numeric;
  v_src        text;
  v_month      text;
  v_ref        text;
  v_tag        text;
  v_key        text;
  -- 051 で足したもの
  v_declared   jsonb := '{}'::jsonb;   -- 本人が言った軸の極
  v_by_product jsonb := '{}'::jsonb;   -- 銘柄ごとの評価
  v_by_month   jsonb := '{}'::jsonb;   -- 暦の月ごとの評価
  v_r_n        bigint := 0;            -- 評価の総件数
  v_r_score_n  bigint := 0;            -- うち 5 段階で答えられた件数
  v_r_legacy_n bigint := 0;            -- うち旧来の ±1 の件数
  v_scene_self bigint := 0;
  v_scene_gift bigint := 0;
  v_scene_pri  text := NULL;
  v_prov       jsonb := '{}'::jsonb;   -- 項目 -> {kind, at}
  v_pno        text;
  v_score      numeric;
  v_bucket     jsonb;
BEGIN
  IF p_subject_id IS NULL OR p_subject_id = '' THEN
    RAISE EXCEPTION 'cdp_l1_build_profile: subject_id が空';
  END IF;

  v_canonical := cdp_canonical_subject(p_subject_id);
  IF v_canonical IS NULL THEN
    RETURN NULL;  -- 主体が居ない（発行前・消去済み）。呼び出し側が何も書かない印。
  END IF;
  v_members := cdp_subject_component(v_canonical);

  SELECT count(*), coalesce(max(e.event_seq), 0), max(e.occurred_at)
    INTO v_total, v_last_seq, v_last_at
    FROM customer_events e
   WHERE e.subject_id = ANY (v_members);

  FOR r IN
    SELECT e.event_seq, e.event_type, e.occurred_at, e.payload
      FROM customer_events e
     WHERE e.subject_id = ANY (v_members)
       AND e.schema_ok = true
     ORDER BY e.event_seq
  LOOP
    v_folded := v_folded + 1;
    v_month := to_char(r.occurred_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM');

    CASE r.event_type

      -- ---- 046 から変更なし（出所タグの付与のみ追加）--------------------
      WHEN 'persona.baseline_imported' THEN
        v_scores  := cdp_persona_normalize(r.payload -> 'scores');
        v_sources := coalesce(
          CASE WHEN jsonb_typeof(r.payload -> 'sources') = 'object'
               THEN r.payload -> 'sources' ELSE NULL END,
          '{}'::jsonb);
        -- 点は推論である（本人が「私は serenity です」と言ったのではない）。
        v_prov := cdp_provenance_put(v_prov, 'persona_primary', 'inferred', r.occurred_at);

      WHEN 'persona.signal_applied' THEN
        v_src := coalesce(nullif(r.payload ->> 'source', ''), 'unknown');
        FOREACH v_axis IN ARRAY cdp_persona_axes() LOOP
          v_delta := cdp_persona_num(r.payload -> 'delta', v_axis);
          CONTINUE WHEN v_delta = 0;

          v_before := cdp_persona_num(v_scores, v_axis);
          v_after  := greatest(0, v_before + v_delta);
          v_eff := v_after - v_before;
          CONTINUE WHEN v_eff = 0;

          v_scores := jsonb_set(v_scores, ARRAY[v_axis], to_jsonb(v_after));

          IF coalesce(jsonb_typeof(v_sources -> v_src), 'null') <> 'object' THEN
            v_sources := jsonb_set(v_sources, ARRAY[v_src], cdp_persona_zero(), true);
          END IF;
          v_sources := jsonb_set(
            v_sources, ARRAY[v_src, v_axis],
            to_jsonb(greatest(0, cdp_persona_num(v_sources -> v_src, v_axis) + v_eff)));

          IF coalesce(jsonb_typeof(v_windows -> v_month), 'null') <> 'object' THEN
            v_windows := jsonb_set(v_windows, ARRAY[v_month], cdp_persona_zero(), true);
          END IF;
          v_windows := jsonb_set(
            v_windows, ARRAY[v_month, v_axis],
            to_jsonb(greatest(0, cdp_persona_num(v_windows -> v_month, v_axis) + v_eff)));
        END LOOP;
        v_prov := cdp_provenance_put(v_prov, 'persona_primary', 'inferred', r.occurred_at);

      WHEN 'exclusion.set' THEN
        v_ref := nullif(btrim(coalesce(r.payload ->> 'ref', '')), '');
        IF v_ref IS NOT NULL AND NOT (v_ref = ANY (v_tea)) THEN
          v_tea := v_tea || v_ref;
        END IF;
        v_prov := cdp_provenance_put(v_prov, 'exclusions.tea_refs', 'declared', r.occurred_at);

      WHEN 'exclusion.cleared' THEN
        v_ref := nullif(btrim(coalesce(r.payload ->> 'ref', '')), '');
        IF v_ref IS NOT NULL THEN
          SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO v_tea
            FROM unnest(v_tea) x WHERE x <> v_ref;
        END IF;
        v_prov := cdp_provenance_put(v_prov, 'exclusions.tea_refs', 'declared', r.occurred_at);

      WHEN 'safety.declared' THEN
        FOR v_tag IN
          SELECT t FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(r.payload -> 'tags') = 'array'
                 THEN r.payload -> 'tags' ELSE '[]'::jsonb END) t
        LOOP
          v_tag := btrim(v_tag);
          CONTINUE WHEN v_tag = '' OR v_tag = 'none';
          IF NOT (v_tag = ANY (v_safety)) THEN
            v_safety := v_safety || v_tag;
          END IF;
        END LOOP;
        v_prov := cdp_provenance_put(v_prov, 'exclusions.safety_tags', 'declared', r.occurred_at);

      WHEN 'notify.preference_set' THEN
        v_key := nullif(btrim(coalesce(r.payload ->> 'key', '')), '');
        IF v_key IS NOT NULL THEN
          v_notify := jsonb_set(v_notify, ARRAY[v_key],
                                coalesce(r.payload -> 'value', 'null'::jsonb), true);
        END IF;
        v_prov := cdp_provenance_put(v_prov, 'notify', 'declared', r.occurred_at);

      WHEN 'notify.suppressed' THEN
        v_suppress := true;
        v_notify := jsonb_set(v_notify, ARRAY['suppressed_reason'],
                              to_jsonb(coalesce(r.payload ->> 'reason', 'unspecified')), true);
        v_prov := cdp_provenance_put(v_prov, 'notify', 'declared', r.occurred_at);

      WHEN 'notify.resumed' THEN
        v_suppress := false;
        v_notify := v_notify - 'suppressed_reason';
        v_prov := cdp_provenance_put(v_prov, 'notify', 'declared', r.occurred_at);

      WHEN 'profile.override' THEN
        v_key := nullif(btrim(coalesce(r.payload ->> 'field', '')), '');
        IF v_key IS NOT NULL THEN
          v_overrides := jsonb_set(v_overrides, ARRAY[v_key],
                                   coalesce(r.payload -> 'value', 'null'::jsonb), true);
          -- 訂正された項目そのものの出所が「本人が言った」に上がる（設計 §4 R3）。
          v_prov := cdp_provenance_put(v_prov, v_key, 'declared', r.occurred_at);
        END IF;
        v_prov := cdp_provenance_put(v_prov, 'overrides', 'declared', r.occurred_at);

      -- ---- 051 で足したもの ---------------------------------------------

      /**
       * 届いた後の評価（第1段 ①）。
       *
       * ここでやるのは **数えることだけ**。銘柄ごと・暦の月ごとに集計して置く。
       * 「この人は渋みがやわらかめ」という位置の推論は第3段 ⑯ で、ここには書かない。
       *
       * 5 段階（score 1-5・択一 #4 の確定）と旧来の ±1（お茶カードのタップ）を
       * **別々に数える**。混ぜると、後で「どちらの解像度の材料が何件あったか」が
       * 言えなくなり、第3段で重みを決める材料が消える。
       *
       * ⚠ score は内部利用のみ。星も数値もお客さんに見せない（#4 の確定条件）。
       */
      WHEN 'rating.submitted' THEN
        v_pno := nullif(btrim(coalesce(r.payload ->> 'product_no', '')), '');
        IF v_pno IS NOT NULL THEN
          v_r_n := v_r_n + 1;

          v_score := NULL;
          IF jsonb_typeof(r.payload -> 'score') = 'number' THEN
            v_score := (r.payload ->> 'score')::numeric;
            v_r_score_n := v_r_score_n + 1;
          ELSIF jsonb_typeof(r.payload -> 'rating') = 'number' THEN
            v_r_legacy_n := v_r_legacy_n + 1;
          END IF;

          -- 銘柄ごと: 件数と、5 段階で答えられた分の合計・件数・直近の値と月。
          v_bucket := coalesce(
            CASE WHEN jsonb_typeof(v_by_product -> v_pno) = 'object'
                 THEN v_by_product -> v_pno ELSE NULL END,
            jsonb_build_object('n', 0, 'score_sum', 0, 'score_n', 0,
                               'last_score', NULL, 'last_month', NULL));
          v_bucket := jsonb_set(v_bucket, ARRAY['n'],
                                to_jsonb(coalesce((v_bucket ->> 'n')::numeric, 0) + 1));
          IF v_score IS NOT NULL THEN
            v_bucket := jsonb_set(v_bucket, ARRAY['score_sum'],
                                  to_jsonb(coalesce((v_bucket ->> 'score_sum')::numeric, 0) + v_score));
            v_bucket := jsonb_set(v_bucket, ARRAY['score_n'],
                                  to_jsonb(coalesce((v_bucket ->> 'score_n')::numeric, 0) + 1));
            -- event_seq 昇順で回しているので、最後に書いたものが直近になる。
            v_bucket := jsonb_set(v_bucket, ARRAY['last_score'], to_jsonb(v_score));
            v_bucket := jsonb_set(v_bucket, ARRAY['last_month'], to_jsonb(v_month));
          END IF;
          v_by_product := jsonb_set(v_by_product, ARRAY[v_pno], v_bucket, true);

          -- 暦の月ごと（now 相対にしない理由は persona_windows と同じ）。
          v_bucket := coalesce(
            CASE WHEN jsonb_typeof(v_by_month -> v_month) = 'object'
                 THEN v_by_month -> v_month ELSE NULL END,
            jsonb_build_object('n', 0, 'score_sum', 0, 'score_n', 0));
          v_bucket := jsonb_set(v_bucket, ARRAY['n'],
                                to_jsonb(coalesce((v_bucket ->> 'n')::numeric, 0) + 1));
          IF v_score IS NOT NULL THEN
            v_bucket := jsonb_set(v_bucket, ARRAY['score_sum'],
                                  to_jsonb(coalesce((v_bucket ->> 'score_sum')::numeric, 0) + v_score));
            v_bucket := jsonb_set(v_bucket, ARRAY['score_n'],
                                  to_jsonb(coalesce((v_bucket ->> 'score_n')::numeric, 0) + 1));
          END IF;
          v_by_month := jsonb_set(v_by_month, ARRAY[v_month], v_bucket, true);

          -- 届いたものへの反応は「見て分かったこと」。本人が好みを述べたのではない。
          v_prov := cdp_provenance_put(v_prov, 'taste', 'observed', r.occurred_at);
        END IF;

      /**
       * 本人が味の軸について言ったこと（会話 / じぶんのページ）。
       * 最後に言ったことが勝つ（設計 §3「本人の訂正は最新が勝つ」）。
       */
      WHEN 'taste.declared' THEN
        v_axis := nullif(btrim(coalesce(r.payload ->> 'axis', '')), '');
        v_key  := nullif(btrim(coalesce(r.payload ->> 'pole', '')), '');
        IF v_axis IS NOT NULL AND v_key IS NOT NULL
           AND v_axis = ANY (cdp_taste_axes())
           AND v_key = ANY (cdp_taste_poles(v_axis)) THEN
          v_declared := jsonb_set(v_declared, ARRAY[v_axis], to_jsonb(v_key), true);
          v_prov := cdp_provenance_put(v_prov, 'taste', 'declared', r.occurred_at);
        END IF;

      /**
       * 誰のために買ったか（第1段 ⑤）。
       *
       * 同数のときに primary を片方へ倒さない。「まだ言えない」を言えないと、
       * 1 件目の購入だけで贈答の人だと決めつけることになる（設計 §3「まだ分からない」）。
       */
      WHEN 'purchase.recipient_declared' THEN
        v_key := nullif(btrim(coalesce(r.payload ->> 'scene', '')), '');
        IF v_key = 'self' THEN
          v_scene_self := v_scene_self + 1;
        ELSIF v_key = 'gift' THEN
          v_scene_gift := v_scene_gift + 1;
        END IF;
        IF v_key IN ('self', 'gift') THEN
          v_prov := cdp_provenance_put(v_prov, 'scene', 'declared', r.occurred_at);
        END IF;

      ELSE
        -- 解釈に使わない出来事（行動ログ・フロー・購入そのもの）。畳んだ数には入る。
        NULL;
    END CASE;
  END LOOP;

  v_sources := cdp_persona_sources_trim(v_scores, v_sources);
  v_primary := cdp_persona_primary(v_scores, NULL);

  IF v_overrides ? 'persona_primary' THEN
    v_key := v_overrides ->> 'persona_primary';
    IF v_key = ANY (cdp_persona_axes()) THEN
      v_primary := v_key;
    ELSIF v_key IS NULL OR v_key = '' THEN
      v_primary := NULL;
    END IF;
  END IF;

  -- 場面の代表値。同数は NULL（「まだ言えない」）。
  IF v_scene_self > v_scene_gift THEN
    v_scene_pri := 'self';
  ELSIF v_scene_gift > v_scene_self THEN
    v_scene_pri := 'gift';
  END IF;

  RETURN jsonb_build_object(
    'subject_id',      v_canonical,
    'persona_primary', v_primary,
    'persona_scores',  v_scores,
    'persona_sources', v_sources,
    'persona_windows', v_windows,
    'exclusions', jsonb_build_object(
      'tea_refs',             to_jsonb(coalesce((SELECT array_agg(x ORDER BY x) FROM unnest(v_tea) x), ARRAY[]::text[])),
      'safety_tags',          to_jsonb(coalesce((SELECT array_agg(x ORDER BY x) FROM unnest(v_safety) x), ARRAY[]::text[])),
      'broadcast_suppressed', v_suppress
    ),
    'overrides',      v_overrides,
    'notify',         v_notify,
    -- 051: 味の材料（推論はしない）
    'taste', jsonb_build_object(
      'declared', v_declared,
      'evidence', jsonb_build_object(
        'by_product', v_by_product,
        'by_month',   v_by_month,
        'totals', jsonb_build_object(
          'n',        v_r_n,
          'score_n',  v_r_score_n,
          'legacy_n', v_r_legacy_n
        )
      )
    ),
    -- 051: 場面（自分用 / 贈りもの）
    'scene', jsonb_build_object(
      'counts', jsonb_build_object('self', v_scene_self, 'gift', v_scene_gift),
      'primary', v_scene_pri
    ),
    -- 051: 出所タグと取得日時
    'provenance',     v_prov,
    'event_count',    v_total,
    'folded_count',   v_folded,
    'last_event_seq', v_last_seq,
    'last_event_at',  v_last_at
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l1_build_profile(text) IS
  'L1 の畳み方の**唯一の定義**（046 を 051 が差し替えた版）。L0 だけを読み、導出値だけを'
  ' 返す（時刻は返さない）。書く側（cdp_l1_recompute_subject）と検算する側'
  ' （cdp_l1_recompute_parity）が同じこれを呼ぶ。'
  ' 第1段では味・場面は **材料を数えるだけ**で、軸の位置は推論しない（設計 §6 第3段 ⑯）。';

-- ===================================================================
-- 4. 書く（046 の cdp_l1_recompute_subject を差し替え）
--    差分は INSERT / UPDATE の列が 3 つ増えただけ。セグメントの決め方は変えていない。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_recompute_subject(p_subject_id text)
RETURNS jsonb AS $$
DECLARE
  v_p         jsonb;
  v_canonical text;
  v_members   text[];
  v_axis      text;
  v_seg       text;
  v_in        boolean;
  v_reason    text;
BEGIN
  v_p := cdp_l1_build_profile(p_subject_id);
  IF v_p IS NULL THEN
    RETURN jsonb_build_object('written', false, 'reason', 'subject_not_found');
  END IF;

  v_canonical := v_p ->> 'subject_id';
  v_members   := cdp_subject_component(v_canonical);

  DELETE FROM subject_profile
   WHERE subject_id = ANY (v_members) AND subject_id <> v_canonical;
  DELETE FROM subject_segment_state
   WHERE subject_id = ANY (v_members) AND subject_id <> v_canonical;

  INSERT INTO subject_profile (
    subject_id, persona_primary, persona_scores, persona_sources, persona_windows,
    exclusions, overrides, notify, taste, scene, provenance,
    event_count, folded_count, last_event_seq, last_event_at, recomputed_at
  ) VALUES (
    v_canonical,
    v_p ->> 'persona_primary',
    v_p -> 'persona_scores',
    v_p -> 'persona_sources',
    v_p -> 'persona_windows',
    v_p -> 'exclusions',
    v_p -> 'overrides',
    v_p -> 'notify',
    v_p -> 'taste',
    v_p -> 'scene',
    v_p -> 'provenance',
    (v_p ->> 'event_count')::bigint,
    (v_p ->> 'folded_count')::bigint,
    (v_p ->> 'last_event_seq')::bigint,
    nullif(v_p ->> 'last_event_at', '')::timestamptz,
    now()
  )
  ON CONFLICT (subject_id) DO UPDATE SET
    persona_primary = EXCLUDED.persona_primary,
    persona_scores  = EXCLUDED.persona_scores,
    persona_sources = EXCLUDED.persona_sources,
    persona_windows = EXCLUDED.persona_windows,
    exclusions      = EXCLUDED.exclusions,
    overrides       = EXCLUDED.overrides,
    notify          = EXCLUDED.notify,
    taste           = EXCLUDED.taste,
    scene           = EXCLUDED.scene,
    provenance      = EXCLUDED.provenance,
    event_count     = EXCLUDED.event_count,
    folded_count    = EXCLUDED.folded_count,
    last_event_seq  = EXCLUDED.last_event_seq,
    last_event_at   = EXCLUDED.last_event_at,
    recomputed_at   = now();

  FOREACH v_axis IN ARRAY cdp_persona_axes() LOOP
    v_seg := 'persona:' || v_axis;
    IF (v_p ->> 'persona_primary') IS NULL THEN
      v_in := false; v_reason := 'no_persona';
    ELSIF (v_p ->> 'persona_primary') <> v_axis THEN
      v_in := false; v_reason := 'other_persona';
    ELSIF coalesce((v_p -> 'exclusions' ->> 'broadcast_suppressed')::boolean, false) THEN
      v_in := false; v_reason := 'broadcast_suppressed';
    ELSE
      v_in := true; v_reason := NULL;
    END IF;

    INSERT INTO subject_segment_state (subject_id, segment_key, in_segment, reason, computed_at)
    VALUES (v_canonical, v_seg, v_in, v_reason, now())
    ON CONFLICT (subject_id, segment_key) DO UPDATE SET
      in_segment  = EXCLUDED.in_segment,
      reason      = EXCLUDED.reason,
      computed_at = now();
  END LOOP;

  RETURN jsonb_build_object('written', true, 'profile', v_p);
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 5. 検算（046 の cdp_l1_recompute_parity を差し替え）
--    比べる項目に taste / scene / provenance を足す。足さないと、新しい 3 列だけが
--    **黙って検算の外に出る**（ずれても誰も気づかない列ができる）。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_recompute_parity(p_limit integer DEFAULT 200)
RETURNS jsonb AS $$
DECLARE
  v_limit     integer := least(greatest(coalesce(p_limit, 200), 1), 5000);
  v_checked   integer := 0;
  v_mismatch  integer := 0;
  v_fields    jsonb := '{}'::jsonb;
  v_pending   bigint := 0;
  r           record;
  v_fresh     jsonb;
  v_stored    jsonb;
  v_field     text;
BEGIN
  FOR r IN
    SELECT p.* FROM subject_profile p
     ORDER BY p.recomputed_at
     LIMIT v_limit
  LOOP
    v_fresh := cdp_l1_build_profile(r.subject_id);
    CONTINUE WHEN v_fresh IS NULL;

    v_stored := jsonb_build_object(
      'subject_id',      r.subject_id,
      'persona_primary', r.persona_primary,
      'persona_scores',  r.persona_scores,
      'persona_sources', r.persona_sources,
      'persona_windows', r.persona_windows,
      'exclusions',      r.exclusions,
      'overrides',       r.overrides,
      'notify',          r.notify,
      'taste',           r.taste,
      'scene',           r.scene,
      'provenance',      r.provenance,
      'event_count',     r.event_count,
      'folded_count',    r.folded_count,
      'last_event_seq',  r.last_event_seq,
      'last_event_at',   r.last_event_at
    );

    v_checked := v_checked + 1;
    IF v_stored <> v_fresh THEN
      v_mismatch := v_mismatch + 1;
      FOR v_field IN SELECT k FROM jsonb_object_keys(v_fresh) k LOOP
        IF (v_stored -> v_field) IS DISTINCT FROM (v_fresh -> v_field) THEN
          v_fields := jsonb_set(v_fields, ARRAY[v_field],
                                to_jsonb(coalesce((v_fields ->> v_field)::int, 0) + 1), true);
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_pending FROM subject_profile;

  RETURN jsonb_build_object(
    'checked',          v_checked,
    'mismatched',       v_mismatch,
    'mismatch_fields',  v_fields,
    'profiles_total',   v_pending,
    'in_agreement',     (v_checked > 0 AND v_mismatch = 0)
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l1_recompute_parity(integer) IS
  'E8'' の L1 側（046 を 051 が差し替えた版）。保存してある解釈と、いま L0 から畳み直した'
  ' 解釈を比べる。051 で足した taste / scene / provenance も比較対象に入っている。'
  ' 1 件も見ていない日は in_agreement=false（空虚合格を作らない）。読み取り専用。';

-- ===================================================================
-- 6. 回答率の計測（第1段 ⑦）
--
--    ─ これが答える問い ─
--      「送った一杯のうち、どれだけ答えてもらえたか」。設計 §2 の降伏条件
--      （3 か月運転して閾値を下回ったら経路設計を作り直す）はこの数で判定する。
--
--    ─ 分母を L0 の shipment.sent から採る理由（台帳を直接引かない）─
--      台帳 `tea_delivery_ledger`（038）は shopify_customer_id / line_user_id で
--      人を指すが、評価（rating.submitted）は subject_id で積まれる。台帳を直接
--      分母にすると **人を突き合わせられず、月ごとの粗い比しか出せない**。
--      050 までに送付が L0 に載る（`shipment.sent`・src/lib/cdp/shipment.ts）ので、
--      分子と分母が同じ主体の空間に並ぶ。**人ごとの回答率が出せるのはこの形だけ**。
--      数の詳しい正本は引き続き台帳側にある（ここは L0 の時系列だけを数える）。
--
--    ─ 閾値をここに書かない理由 ─
--      設計 §2 が「他社実績からの外挿ではなく、判断を止めないために置いた社内の閾値」
--      「実データが出たら最初に見直す数字」と明記している。**見直す前提の数字を
--      DB 関数に焼くと、直す場所が 2 つになる**。ここは数を返すだけにして、
--      判定は読む側（運用・Devlog）が行う。
--
--    ─ 2 つの率を返す理由 ─
--      strict … 評価が「どの配送のどの一杯か」を指しているもの（payload.delivery_ref あり）
--                だけを数える。設計が本当に測りたいのはこちら。
--      coarse … その月の評価を全部数える。delivery_ref を積み始める前の月でも
--                ゼロにならないので、移行期の目安になる。
--      strict と coarse を **1 つに畳まない**（畳むと、率が上がったのが
--      回答が増えたからか配線が進んだからか区別できなくなる）。
--
--    @reader src/lib/cdp/response-rate.ts
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l0_rating_response_rate(
  p_from date DEFAULT NULL,
  p_to   date DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_rows jsonb;
BEGIN
  WITH bounds AS (
    SELECT coalesce(p_from, date '2000-01-01') AS lo,
           coalesce(p_to,   date '2999-12-31') AS hi
  ),
  -- 送った一杯。1 つの shipment.sent に複数銘柄が載るので、**銘柄の数**を数える
  -- （箱の数ではない。評価は銘柄ごとに 1 件返るため、分母も銘柄で揃える）。
  -- 月は payload の shipped_on から採る（shipment.ts の foldShipmentHistory と同じ）。
  shipments AS (
    SELECT to_char((e.payload ->> 'shipped_on')::date, 'YYYY-MM') AS period,
           e.subject_id,
           coalesce(jsonb_array_length(
             CASE WHEN jsonb_typeof(e.payload -> 'items') = 'array'
                  THEN e.payload -> 'items' ELSE '[]'::jsonb END), 0) AS item_count
      FROM customer_events e, bounds b
     WHERE e.event_type = 'shipment.sent'
       AND e.schema_ok = true
       AND (e.payload ->> 'shipped_on') ~ '^\d{4}-\d{2}-\d{2}$'
       AND (e.payload ->> 'shipped_on')::date BETWEEN b.lo AND b.hi
  ),
  delivered AS (
    SELECT period,
           sum(item_count)::bigint            AS delivered,
           count(DISTINCT subject_id)::bigint AS people_sent
      FROM shipments
     GROUP BY period
  ),
  -- 届いた後の評価。月は JST の暦月（L1 の by_month と同じ切り方）。
  ratings AS (
    SELECT to_char(e.occurred_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS period,
           count(*)::bigint AS answered_any,
           count(*) FILTER (
             WHERE nullif(btrim(coalesce(e.payload ->> 'delivery_ref', '')), '') IS NOT NULL
           )::bigint AS answered_linked,
           count(*) FILTER (WHERE jsonb_typeof(e.payload -> 'score') = 'number')::bigint
             AS answered_five_scale,
           count(DISTINCT e.subject_id)::bigint AS people_answered
      FROM customer_events e, bounds b
     WHERE e.event_type = 'rating.submitted'
       AND e.schema_ok = true
       AND (e.occurred_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN b.lo AND b.hi
     GROUP BY 1
  ),
  merged AS (
    SELECT coalesce(d.period, r.period) AS period,
           coalesce(d.delivered, 0)           AS delivered,
           coalesce(d.people_sent, 0)         AS people_sent,
           coalesce(r.answered_any, 0)        AS answered_any,
           coalesce(r.answered_linked, 0)     AS answered_linked,
           coalesce(r.answered_five_scale, 0) AS answered_five_scale,
           coalesce(r.people_answered, 0)     AS people_answered
      FROM delivered d
      FULL OUTER JOIN ratings r ON r.period = d.period
  )
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'period'), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT jsonb_build_object(
        'period',              m.period,
        'delivered',           m.delivered,
        'people_sent',         m.people_sent,
        'answered_any',        m.answered_any,
        'answered_linked',     m.answered_linked,
        'answered_five_scale', m.answered_five_scale,
        'people_answered',     m.people_answered,
        -- 送っていない月に率を出さない（0 件を分母にして 0% と言わない）。
        'rate_strict', CASE WHEN m.delivered > 0
                            THEN round(m.answered_linked::numeric / m.delivered, 4) END,
        'rate_coarse', CASE WHEN m.delivered > 0
                            THEN round(m.answered_any::numeric / m.delivered, 4) END,
        -- 人で見た回答率（1 人が何杯答えたかに影響されない）。
        'rate_people', CASE WHEN m.people_sent > 0
                            THEN round(m.people_answered::numeric / m.people_sent, 4) END
      ) AS x
      FROM merged m
    ) s;

  RETURN jsonb_build_object('periods', v_rows, 'computed_at', now());
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l0_rating_response_rate(date, date) IS
  '第1段 ⑦。送った一杯（L0 の shipment.sent）に対して、どれだけ評価が返ったかを'
  ' 暦の月ごとに数える。分子・分母とも L0 なので主体で突き合わせられる（人で見た率も返す）。'
  ' 閾値の判定はしない（設計 §2 の 15/25/40% は見直す前提の仮置きなので、DB に焼かない）。'
  ' 送っていない月には率を出さない。読み取り専用。';
