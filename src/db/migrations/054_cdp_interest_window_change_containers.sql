-- 054: 取り返せない 3 つの材料に、器だけ先に作る（roji タッチポイント地図 B-1 / B-2 / B-3）
--
-- 設計正本: roji体験目的 × タッチポイント全体地図（2026-09-02・Setaka 承認済み）
--   第4章 B-1「カルテにイベントへの関心の置き場を新設する」
--        B-2「カルテに窓への傾きの置き場を新設する」
--        B-3「事前通知に対する変更の記録の器だけ、先に作る」/ 優先順位 2 位
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/roji-experience-touchpoint-map-20260902.md
-- 上位の正本: rojiマスタースペック https://app.notion.com/p/3af70c9d064c81a08be5eab8027dc2f4 第4章
-- 併読: elxea顧客プロファイル設計 rev.3.2 §3 L1 の箱 / 顧客データ統合 統合設計 §5 E1・E8'
--
-- ===================================================================
-- ─ なぜ「器だけ」を今つくるのか ─
--
--   3 つとも正本が「取り返せないもの」に挙げている材料である。器が無い間に
--   起きたことは、後から作れない:
--
--     B-1 イベントへの関心・参加履歴 … 最初の回の前に器が無ければ、その回に来た
--         人の関心はどこにも残らない（正本 第4章 取り返せないもの ④）。
--     B-2 窓への傾き … 「あとから足せるもの」だが、**材料になる行動の記録は
--         今から残す**必要がある（正本 第4章）。
--     B-3 事前通知への変更 … 「変更の操作は一瞬で終わり、記録しなければ痕跡が
--         残らない。しかも最も濃い好みの手がかり」（同 ②）。
--
--   収集の画面も配信も、ここでは作らない。**受け口と置き場だけ**を開ける。
--
-- ─ 第1段の姿勢を引き継ぐ（推論しない）─
--
--   051 と同じく、ここでやるのは **事実を積み、出所を付けて L1 に置く**ところまで。
--   「この人は音楽の人だ」のような代表値を出さない。理由は 051 と同じで、材料が
--   数か月ぶん貯まる前に検証できない判定が固定されるため。
--   ⚠ とくに窓は A-2（記事 22 本への目印付け）が終わるまで材料が 0 件で入ってくる。
--     0 件のうちから primary を出す枝を置くと、1 タップで「文学の人」が決まる。
--
-- ─ 窓の 6 分類は暫定である（Setaka 確定 2026-09-02）─
--
--   お茶・文学・アート・音楽・農・科学。正本 序章3 の「複数の窓」と同じ 6 つ。
--   最初のアンケート 2 問目がこの分類そのものを問う設計なので、**回答が出たら
--   見直す前提**で暫定開始する（地図 第5章 判断2 の推奨 (b)）。
--   語彙を閉じているのは、分類の変更が設計判断であって観測の揺らぎではないため
--   （taste の軸・PURCHASE_SCENES と同じ扱い）。知らない窓で届いた出来事は
--   L0 には残り（E1）、schema_ok = false として数えられる。
--
-- ─ 畳み直しは自動で走る（052 の shape fingerprint）─
--
--   本 migration は subject_profile に列を 3 つ足す。052 の
--   `cdp_l1_shape_fingerprint()` は subject_profile の列名から版を導くので、
--   **列が増えれば版が変わり、全員が pending になる**。051 の障害
--   （列を足したのに 1 件も畳み直されない）は構造的に再発しない。
--   その前提に乗ったうえで、051 の教訓どおり **一回性の是正**（全件畳み直し）と
--   **末尾の自己検査** もこの migration に含める。「当てたのに直っていない」を残さない。
--
-- ─ 冪等性 ─ ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE FUNCTION / 全件畳み直し。
--            何度当てても同じ状態に収束する。
-- ─ 破壊性 ─ 追加のみ。列の削除・型変更・出来事の書き換えを一切行わない。
-- ─ 消せる ─ subject_profile は 037 の列挙で既に消去対象に入っている（列を足しても変わらない）。
--
-- ─ 適用手順 ─
--   npx tsx scripts/migrate.ts --only 054 --dry-run
--   SUPABASE_DB_PASSWORD=… npx tsx scripts/migrate.ts --only 054 --apply
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認（無い物の上に建てない）
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.subject_profile') IS NULL THEN
    RAISE EXCEPTION '054: subject_profile が無い。046 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_provenance_put') IS NULL THEN
    RAISE EXCEPTION '054: cdp_provenance_put が無い。051 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_l1_shape_fingerprint') IS NULL THEN
    RAISE EXCEPTION '054: cdp_l1_shape_fingerprint が無い。052 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. 語彙（TypeScript 側 src/lib/cdp/event-vocabulary.ts と 1 対 1）
--
--   ⚠ 2 か所にあるのは persona 軸・taste 軸と同じ事情（畳み手が SQL、口が TS）。
--     同じ語彙であることは tests/unit/cdp-profile-containers.test.ts が留める。
-- ===================================================================

/** イベントへの参加の意向（B-1）。TS 側 EVENT_INTEREST_MODES と同一・同順。 */
CREATE OR REPLACE FUNCTION cdp_event_interest_modes() RETURNS text[] AS $$
  SELECT ARRAY['onsite', 'online', 'not_now']::text[];
$$ LANGUAGE sql IMMUTABLE;

/** 6 つの窓（B-2・暫定）。TS 側 CONTENT_WINDOWS と同一・同順。 */
CREATE OR REPLACE FUNCTION cdp_content_windows() RETURNS text[] AS $$
  SELECT ARRAY['tea', 'literature', 'art', 'music', 'farming', 'science']::text[];
$$ LANGUAGE sql IMMUTABLE;

/**
 * 窓への触れ方（B-2）。TS 側 WINDOW_MODES と同一・同順。
 * 正本の「読んだ・聴いた・お気に入りに入れた」に、観た（映像）を足した 4 つ。
 * **聞かない**（本人に申告させない）ので、すべて観測から入る。
 */
CREATE OR REPLACE FUNCTION cdp_window_modes() RETURNS text[] AS $$
  SELECT ARRAY['read', 'listen', 'watch', 'saved']::text[];
$$ LANGUAGE sql IMMUTABLE;

/** 事前通知に対する変更の種類（B-3）。TS 側 ASSIGNMENT_CHANGE_ACTIONS と同一・同順。 */
CREATE OR REPLACE FUNCTION cdp_assignment_change_actions() RETURNS text[] AS $$
  SELECT ARRAY['add', 'remove', 'replace']::text[];
$$ LANGUAGE sql IMMUTABLE;

/**
 * 窓の数え始めの入れ物（6 つとも 0）。
 *
 * ⚠ 0 で埋めるのは、**キーの集合を出来事に依存させない**ため。触れられた窓だけを
 *   キーにすると、「まだ 1 度も触れられていない窓」と「そもそも分類に無い窓」が
 *   区別できなくなり、E8' の比較も人によってキーの数が変わる。
 */
CREATE OR REPLACE FUNCTION cdp_window_zero() RETURNS jsonb AS $$
  SELECT coalesce(jsonb_object_agg(w, 0), '{}'::jsonb)
    FROM unnest(cdp_content_windows()) w;
$$ LANGUAGE sql STABLE;

/** 触れ方の数え始めの入れ物（4 つとも 0）。理由は cdp_window_zero と同じ。 */
CREATE OR REPLACE FUNCTION cdp_window_mode_zero() RETURNS jsonb AS $$
  SELECT coalesce(jsonb_object_agg(m, 0), '{}'::jsonb)
    FROM unnest(cdp_window_modes()) m;
$$ LANGUAGE sql STABLE;

-- ===================================================================
-- 2. L1 に 3 列足す
--
--   ⚠ PII を入れない（subject_profile の既定どおり）。回の参照・銘柄の参照は
--     催しや商品の識別子であって人の識別子ではないので入れてよい。
--     記事の参照は入れない（下の window_leaning のコメント参照）。
-- ===================================================================

ALTER TABLE subject_profile
  ADD COLUMN IF NOT EXISTS event_interest     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS window_leaning     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS assignment_changes jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN subject_profile.event_interest IS
  'イベントへの関心と参加の記録（B-1 / 正本 第4章「イベントへの関心 → 回の案内、招く判断」）。'
  ' intent … 本人が言った参加の意向 {mode, month}。最後に言ったことが勝つ。言っていなければ null。'
  ' attendance … 出た回 {n, refs, last_month}。n は **重複を除いた回の数**。'
  ' ⚠ 「この人はイベントの人だ」という代表値は置かない（第1段は材料のみ）。';

COMMENT ON COLUMN subject_profile.window_leaning IS
  '6 つの窓への傾き（B-2 / 正本 序章3「複数の窓」・第4章「窓への傾き → 読み物の選定」）。'
  ' counts … 窓ごとの回数（6 つとも常に在る。0 も書く）。by_mode … 触れ方ごとの回数。'
  ' totals.n … 総数。'
  ' ⚠ どの記事に触れたかの参照は L1 に持たない（L0 に残る）。L1 は傾きを言うための'
  ' 数だけを持つ — 読んだ記事の一覧を解釈の側に置くと、消去と訂正の対象が二重になる。'
  ' ⚠ primary（いちばん多い窓）を置かない。A-2 の目印付けが終わるまで材料は 0 件で入るので、'
  ' 1 タップで「文学の人」が決まる枝を作らない（第1段は材料のみ）。'
  ' ⚠ 6 分類は暫定（Setaka 確定 2026-09-02）。最初のアンケート 2 問目で見直す。';

COMMENT ON COLUMN subject_profile.assignment_changes IS
  '事前通知に対する変更の記録（B-3 / 正本 第4章 取り返せないもの ②「最も濃い好みの手がかり」）。'
  ' n … 変更した回数。by_period … 暦の月ごとの {n, add, remove, replace}。'
  ' totals … 種類ごとの合計。last_period … 最後に変えた月。'
  ' ⚠ 「このままでいい」は数えない。通知そのものが未実装で送り手が居らず、'
  ' 分母を作れないため（分母は通知が動いてから、送った側の記録で数える）。'
  ' ⚠ 変更の中身（何を何に変えたか）の詳しい正本は 033 の preview_changes 側に残す。'
  ' ここは「本人が能動的に動いた」という解釈の材料だけを持つ。';

-- ===================================================================
-- 3. 畳み方（051 の cdp_l1_build_profile を差し替え）
--
--    051 からの差分は 2 点だけ:
--      (a) event_interest / window_leaning / assignment_changes を導出値に足した
--      (b) event.interest_declared / event.attended / window.entered /
--          assignment.changed を畳む枝を足した
--    persona・exclusions・overrides・notify・taste・scene の畳み方は
--    **1 文字も変えていない**（変えると E8' の一致判定で「ずれた」のか「直した」のか
--    区別できなくなる）。
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
  -- 054 で足したもの
  v_ev_mode    text := NULL;                 -- B-1 参加の意向（最後に言ったものが勝つ）
  v_ev_month   text := NULL;                 -- その意向を言った月
  v_ev_refs    text[] := ARRAY[]::text[];    -- B-1 出た回（重複を除く）
  v_ev_last    text := NULL;                 -- 最後に出た月
  v_win        jsonb := cdp_window_zero();      -- B-2 窓ごとの回数
  v_win_modes  jsonb := cdp_window_mode_zero(); -- B-2 触れ方ごとの回数
  v_win_n      bigint := 0;                  -- B-2 総数
  v_win_key    text;
  v_chg        jsonb := '{}'::jsonb;         -- B-3 月ごとの変更
  v_chg_n      bigint := 0;
  v_chg_add    bigint := 0;
  v_chg_rem    bigint := 0;
  v_chg_rep    bigint := 0;
  v_chg_last   text := NULL;
  v_period     text;
  v_act        text;
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

      -- ---- 046 / 051 から変更なし ---------------------------------------
      WHEN 'persona.baseline_imported' THEN
        v_scores  := cdp_persona_normalize(r.payload -> 'scores');
        v_sources := coalesce(
          CASE WHEN jsonb_typeof(r.payload -> 'sources') = 'object'
               THEN r.payload -> 'sources' ELSE NULL END,
          '{}'::jsonb);
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
          v_prov := cdp_provenance_put(v_prov, v_key, 'declared', r.occurred_at);
        END IF;
        v_prov := cdp_provenance_put(v_prov, 'overrides', 'declared', r.occurred_at);

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
            v_bucket := jsonb_set(v_bucket, ARRAY['last_score'], to_jsonb(v_score));
            v_bucket := jsonb_set(v_bucket, ARRAY['last_month'], to_jsonb(v_month));
          END IF;
          v_by_product := jsonb_set(v_by_product, ARRAY[v_pno], v_bucket, true);

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

          v_prov := cdp_provenance_put(v_prov, 'taste', 'observed', r.occurred_at);
        END IF;

      WHEN 'taste.declared' THEN
        v_axis := nullif(btrim(coalesce(r.payload ->> 'axis', '')), '');
        v_key  := nullif(btrim(coalesce(r.payload ->> 'pole', '')), '');
        IF v_axis IS NOT NULL AND v_key IS NOT NULL
           AND v_axis = ANY (cdp_taste_axes())
           AND v_key = ANY (cdp_taste_poles(v_axis)) THEN
          v_declared := jsonb_set(v_declared, ARRAY[v_axis], to_jsonb(v_key), true);
          v_prov := cdp_provenance_put(v_prov, 'taste', 'declared', r.occurred_at);
        END IF;

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

      -- ---- 054 で足したもの ---------------------------------------------

      /**
       * B-1 参加の意向。本人が言ったことなので **最後に言ったものが勝つ**
       * （設計 §3「本人の訂正は最新が勝つ」/ taste.declared と同じ扱い）。
       *
       * ⚠ 「いまは出ない」(not_now) を **記録しない、にしない**。記録しないと
       *   「聞かれていない人」と「今回は出ないと言った人」が同じに見え、
       *   招く判断のときに区別できない。降りる意思も材料である。
       */
      WHEN 'event.interest_declared' THEN
        v_key := nullif(btrim(coalesce(r.payload ->> 'mode', '')), '');
        IF v_key IS NOT NULL AND v_key = ANY (cdp_event_interest_modes()) THEN
          v_ev_mode  := v_key;
          v_ev_month := v_month;
          v_prov := cdp_provenance_put(v_prov, 'event_interest', 'declared', r.occurred_at);
        END IF;

      /**
       * B-1 出た回。回の参照だけを持つ（誰と出たか・何を話したかは持たない）。
       *
       * 同じ回について 2 行来ても 1 回として数える（受付の打ち間違い・再送で
       * 参加回数が水増しされない）。冪等キーは L0 側が別に守っているが、
       * 参照が同じなら同じ回である、という事実の側でも重ねて守る。
       */
      WHEN 'event.attended' THEN
        v_ref := nullif(btrim(coalesce(r.payload ->> 'event_ref', '')), '');
        IF v_ref IS NOT NULL THEN
          IF NOT (v_ref = ANY (v_ev_refs)) THEN
            v_ev_refs := v_ev_refs || v_ref;
          END IF;
          v_ev_last := v_month;
          -- 出たという事実は「見て分かったこと」。本人が関心を述べたのではない。
          v_prov := cdp_provenance_put(v_prov, 'event_interest', 'observed', r.occurred_at);
        END IF;

      /**
       * B-2 窓に入った。読んだ・聴いた・観た・お気に入りに入れた の 4 つ。
       *
       * ⚠ 本人に聞かない（正本 第4章「後から集計できる形にする（聞かない）」）。
       *   よって出所は必ず observed で、declared に上がる枝をここに作らない。
       * ⚠ どの記事かは数えるだけで持たない（L1 のコメント参照）。
       */
      WHEN 'window.entered' THEN
        v_win_key := nullif(btrim(coalesce(r.payload ->> 'window', '')), '');
        v_key     := nullif(btrim(coalesce(r.payload ->> 'mode', '')), '');
        IF v_win_key IS NOT NULL AND v_win_key = ANY (cdp_content_windows()) THEN
          v_win := jsonb_set(v_win, ARRAY[v_win_key],
                             to_jsonb(coalesce((v_win ->> v_win_key)::numeric, 0) + 1));
          v_win_n := v_win_n + 1;
          IF v_key IS NOT NULL AND v_key = ANY (cdp_window_modes()) THEN
            v_win_modes := jsonb_set(v_win_modes, ARRAY[v_key],
                                     to_jsonb(coalesce((v_win_modes ->> v_key)::numeric, 0) + 1));
          END IF;
          v_prov := cdp_provenance_put(v_prov, 'window_leaning', 'observed', r.occurred_at);
        END IF;

      /**
       * B-3 事前通知に対する変更。本人が能動的に動いた記録なので declared。
       *
       * 月は **payload の period**（どの月の中身を変えたか）から採る。出来事が
       * 起きた月（v_month）ではない — 10 月号の中身を 9 月末に変えることが普通に
       * あり、出来事の月で数えると「変えた月」と「変えた対象の月」がずれる。
       */
      WHEN 'assignment.changed' THEN
        v_period := nullif(btrim(coalesce(r.payload ->> 'period', '')), '');
        IF v_period ~ '^[0-9]{4}-[0-9]{2}$' THEN
          v_chg_n := v_chg_n + 1;

          v_bucket := coalesce(
            CASE WHEN jsonb_typeof(v_chg -> v_period) = 'object'
                 THEN v_chg -> v_period ELSE NULL END,
            jsonb_build_object('n', 0, 'add', 0, 'remove', 0, 'replace', 0));
          v_bucket := jsonb_set(v_bucket, ARRAY['n'],
                                to_jsonb(coalesce((v_bucket ->> 'n')::numeric, 0) + 1));

          FOR v_act IN
            SELECT e ->> 'action'
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(r.payload -> 'changes') = 'array'
                          THEN r.payload -> 'changes' ELSE '[]'::jsonb END) e
          LOOP
            CONTINUE WHEN v_act IS NULL
                       OR NOT (v_act = ANY (cdp_assignment_change_actions()));
            v_bucket := jsonb_set(v_bucket, ARRAY[v_act],
                                  to_jsonb(coalesce((v_bucket ->> v_act)::numeric, 0) + 1));
            IF    v_act = 'add'     THEN v_chg_add := v_chg_add + 1;
            ELSIF v_act = 'remove'  THEN v_chg_rem := v_chg_rem + 1;
            ELSIF v_act = 'replace' THEN v_chg_rep := v_chg_rep + 1;
            END IF;
          END LOOP;

          v_chg := jsonb_set(v_chg, ARRAY[v_period], v_bucket, true);
          IF v_chg_last IS NULL OR v_period > v_chg_last THEN
            v_chg_last := v_period;
          END IF;
          v_prov := cdp_provenance_put(v_prov, 'assignment_changes', 'declared', r.occurred_at);
        END IF;

      ELSE
        -- 解釈に使わない出来事（行動ログ・フロー・購入そのもの・送付）。畳んだ数には入る。
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
    'scene', jsonb_build_object(
      'counts', jsonb_build_object('self', v_scene_self, 'gift', v_scene_gift),
      'primary', v_scene_pri
    ),
    -- 054 B-1: イベントへの関心（意向 + 出た回）
    'event_interest', jsonb_build_object(
      'intent',
        CASE WHEN v_ev_mode IS NULL THEN NULL::jsonb
             ELSE jsonb_build_object('mode', v_ev_mode, 'month', v_ev_month) END,
      'attendance', jsonb_build_object(
        'n',          coalesce(array_length(v_ev_refs, 1), 0),
        'refs',       to_jsonb(coalesce((SELECT array_agg(x ORDER BY x) FROM unnest(v_ev_refs) x), ARRAY[]::text[])),
        'last_month', v_ev_last
      )
    ),
    -- 054 B-2: 窓への傾き（数えるだけ・代表値は出さない）
    'window_leaning', jsonb_build_object(
      'counts',  v_win,
      'by_mode', v_win_modes,
      'totals',  jsonb_build_object('n', v_win_n)
    ),
    -- 054 B-3: 事前通知に対する変更
    'assignment_changes', jsonb_build_object(
      'n',           v_chg_n,
      'by_period',   v_chg,
      'totals',      jsonb_build_object('add', v_chg_add, 'remove', v_chg_rem, 'replace', v_chg_rep),
      'last_period', v_chg_last
    ),
    'provenance',     v_prov,
    'event_count',    v_total,
    'folded_count',   v_folded,
    'last_event_seq', v_last_seq,
    'last_event_at',  v_last_at
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l1_build_profile(text) IS
  'L1 の畳み方の**唯一の定義**（046 → 051 → 054 と差し替えてきた最新版）。L0 だけを読み、'
  ' 導出値だけを返す（時刻は返さない）。書く側（cdp_l1_recompute_subject）と検算する側'
  ' （cdp_l1_recompute_parity）が同じこれを呼ぶ。'
  ' 054 で足したのは B-1 イベントへの関心 / B-2 窓への傾き / B-3 事前通知への変更の 3 つで、'
  ' いずれも **材料を数えるだけ**（代表値・位置の推論はしない）。';

-- ===================================================================
-- 4. 書く（052 の cdp_l1_recompute_subject を差し替え）
--    差分は INSERT / UPDATE の列が 3 つ増えただけ。セグメントの決め方も
--    形の版の刻み方も変えていない。
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
  v_shape     text := cdp_l1_shape_fingerprint();
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
    event_interest, window_leaning, assignment_changes,
    event_count, folded_count, last_event_seq, last_event_at, recomputed_at,
    shape_fingerprint
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
    v_p -> 'event_interest',
    v_p -> 'window_leaning',
    v_p -> 'assignment_changes',
    (v_p ->> 'event_count')::bigint,
    (v_p ->> 'folded_count')::bigint,
    (v_p ->> 'last_event_seq')::bigint,
    nullif(v_p ->> 'last_event_at', '')::timestamptz,
    now(),
    v_shape
  )
  ON CONFLICT (subject_id) DO UPDATE SET
    persona_primary    = EXCLUDED.persona_primary,
    persona_scores     = EXCLUDED.persona_scores,
    persona_sources    = EXCLUDED.persona_sources,
    persona_windows    = EXCLUDED.persona_windows,
    exclusions         = EXCLUDED.exclusions,
    overrides          = EXCLUDED.overrides,
    notify             = EXCLUDED.notify,
    taste              = EXCLUDED.taste,
    scene              = EXCLUDED.scene,
    provenance         = EXCLUDED.provenance,
    event_interest     = EXCLUDED.event_interest,
    window_leaning     = EXCLUDED.window_leaning,
    assignment_changes = EXCLUDED.assignment_changes,
    event_count        = EXCLUDED.event_count,
    folded_count       = EXCLUDED.folded_count,
    last_event_seq     = EXCLUDED.last_event_seq,
    last_event_at      = EXCLUDED.last_event_at,
    recomputed_at      = now(),
    shape_fingerprint  = EXCLUDED.shape_fingerprint;

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
-- 5. 検算（051 の cdp_l1_recompute_parity を差し替え）
--    比べる項目に 3 列を足す。足さないと、新しい 3 列だけが **黙って検算の外に
--    出る**（ずれても誰も気づかない列ができる）。051 と同じ理由。
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
      'subject_id',         r.subject_id,
      'persona_primary',    r.persona_primary,
      'persona_scores',     r.persona_scores,
      'persona_sources',    r.persona_sources,
      'persona_windows',    r.persona_windows,
      'exclusions',         r.exclusions,
      'overrides',          r.overrides,
      'notify',             r.notify,
      'taste',              r.taste,
      'scene',              r.scene,
      'provenance',         r.provenance,
      'event_interest',     r.event_interest,
      'window_leaning',     r.window_leaning,
      'assignment_changes', r.assignment_changes,
      'event_count',        r.event_count,
      'folded_count',       r.folded_count,
      'last_event_seq',     r.last_event_seq,
      'last_event_at',      r.last_event_at
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
  'E8'' の L1 側（046 → 051 → 054 の最新版）。保存してある解釈と、いま L0 から畳み直した'
  ' 解釈を比べる。054 で足した event_interest / window_leaning / assignment_changes も'
  ' 比較対象に入っている。1 件も見ていない日は in_agreement=false（空虚合格を作らない）。読み取り専用。';

-- ===================================================================
-- 6. 一回性の是正 — 既存の全 profile をいま畳み直す
--
--    052 の shape fingerprint により、列が増えた時点で全員が pending になる。
--    だがそれは「次に誰かが cdp_l1_recompute_all を呼んだとき」の話であって、
--    当てた瞬間に直るわけではない。051 の障害は「適用は成功・中身は未是正」だったので、
--    是正まで含めて 1 つの migration にする（052 と同じ作法）。
--
--    ⚠ 走査中に対象が動くことへの備え: cdp_l1_recompute_subject は代表でない行を
--      DELETE することがある。先に id を配列へ確定させてから回す。
-- ===================================================================
DO $$
DECLARE
  v_ids   text[];
  v_id    text;
  v_done  integer := 0;
  v_gone  integer := 0;
BEGIN
  SELECT coalesce(array_agg(p.subject_id ORDER BY p.subject_id), ARRAY[]::text[])
    INTO v_ids
    FROM subject_profile p
    JOIN subjects s ON s.subject_id = p.subject_id AND s.retired_at IS NULL;

  FOREACH v_id IN ARRAY v_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM subject_profile WHERE subject_id = v_id) THEN
      v_gone := v_gone + 1;
      CONTINUE;
    END IF;
    PERFORM cdp_l1_recompute_subject(v_id);
    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE '054: 既存 profile の強制畳み直し 完了 — 対象 % 件 / 畳み直し % 件 / 途中で代表でなくなった % 件',
    array_length(v_ids, 1), v_done, v_gone;
END;
$$;

-- ===================================================================
-- 7. 当てた結果の自己検査（失敗したら migration を失敗させる）
--
--    (a) 形の版の取り残しが 0 件
--    (b) 足した 3 列が DEFAULT のまま残っていない（＝畳み手が実際に書いた）
--
--    (b) を別に見るのは、(a) だけだと「版は刻んだが中身は空」を通してしまうため。
--    051 の障害の本体はまさにそれだった。
-- ===================================================================
DO $$
DECLARE
  v_stale bigint;
  v_empty bigint;
  v_shape text := cdp_l1_shape_fingerprint();
BEGIN
  SELECT count(*) INTO v_stale
    FROM subject_profile p
    JOIN subjects s ON s.subject_id = p.subject_id AND s.retired_at IS NULL
   WHERE p.shape_fingerprint IS DISTINCT FROM v_shape;

  IF v_stale > 0 THEN
    RAISE EXCEPTION '054: 畳み直しの取り残しが % 件ある（形の版が古いまま）。適用を失敗として扱う。', v_stale;
  END IF;

  -- 3 列とも「畳んだ結果」が入っているはず。出来事が 1 件も無い人でも、
  -- 器の骨格（counts の 6 キー・attendance・totals）は必ず書かれる。
  SELECT count(*) INTO v_empty
    FROM subject_profile p
    JOIN subjects s ON s.subject_id = p.subject_id AND s.retired_at IS NULL
   WHERE p.event_interest = '{}'::jsonb
      OR p.window_leaning = '{}'::jsonb
      OR p.assignment_changes = '{}'::jsonb;

  IF v_empty > 0 THEN
    RAISE EXCEPTION
      '054: 足した 3 列が DEFAULT のまま残っている行が % 件ある。'
      ' 畳み手が書いていない（051 と同じ壊れ方）。適用を失敗として扱う。', v_empty;
  END IF;

  RAISE NOTICE '054: 自己検査 OK — 形の版が古い profile 0 件 / 新 3 列が空の profile 0 件';
END;
$$;
