-- ===================================================================
-- 046: 解釈を 1 冊にする（L1 subject_profile / subject_segment_state）
--      と、セグメント配信を SQL 1 本にする
--      （CDP 統合 Stage 4 / §3-2 / §5 E8' / §6-1 Stage 4 / §6-2 T-9・T-11）
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）
--   §3-2 データ流路（L1 は L0 から全再計算可能・exclusions・persona_windows）
--   §5 E8'（L1 再計算一致）/ §6-1 Stage 4（使う側の解禁）
--   §6-2 T-9（未連携カルテ lineUsers/）/ T-11（セグメント配信の全件スキャン 3 本）
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ なぜ要るか ─
--
-- 「その人はどんな人か」（カルテ・好みタイプ・セグメント）が 3 つの棚に分かれている。
-- 連携済みなら users/{shopifyId}、Web からの LINE 連携人格なら users/line:{lineUserId}、
-- 未連携 LINE なら lineUsers/{lineUserId}。棚が分かれているぶんだけカルテが分裂し、
-- 配信の宛先を出すのに **Firestore の全件スキャンを 3 本**（delivery-runtime.ts）
-- 走らせる必要がある。全件スキャンは (a) 人が増えるほど遅くなり (b) 除外条件を
-- 足す場所が無く (c) 「なぜこの人が対象なのか」を後から言えない。
--
-- L1 は「L0（出来事）を畳んだ解釈」を 1 冊に置く層である。**匿名も未連携も
-- subject を持つ**（Stage 1 で発行済み）ので、未連携用の 2 冊目が要らなくなる
-- （T-9 の置き換え先がこれ）。
--
-- ─ 不変条件（この段の芯）─
--
--   (1) L1 は L0 から **全再計算可能**。作り置きは「速いだけの写し」であって
--       正本ではない。cdp_l1_build_profile が唯一の畳み方の定義で、書く側
--       （cdp_l1_recompute_subject）も検算する側（cdp_l1_recompute_parity）も
--       同じ関数を呼ぶ。畳み方を 2 か所に書かない。
--   (2) 内訳（persona_sources）の各軸の和は合計（persona_scores）を超えない。
--       CHECK 制約で保証する（§3-2 が案 A の評価どおり移送すると決めた不変条件）。
--       超えないことを **畳む側で保証**（cdp_persona_sources_trim）してから書くので、
--       再計算が制約違反で落ちることはない。
--   (3) 期間別内訳（persona_windows）は **暦の月**（JST）で切る。「直近 30 日」の
--       ような now 相対で切ると、保存値と再計算値が時間の経過だけで食い違い、
--       E8' の一致判定が毎日偽陽性になる。
--
-- ─ 追記専用ではない（E4 を付けない）─
--   L1 は L0 からの **派生**であり、いつでも作り直せる。E4 が守るのは事実（L0）と
--   同一性（edges / links）であって、そこから導いた解釈ではない（043 の
--   delivery_identity と同じ扱い）。
--
-- ─ 消去 ─
--   両表とも `subject_id` 列を持つので、042/043 の「表の表」（roji_person_key_map）が
--   **自動で列挙する**。除外リストに入れない ＝ 消える側である、が既定になる。
--   辿らずに数える孤児検査（roji_erasure_residue）にも本migrationで足す。
--
-- ─ 冪等性 ─ CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
--            DROP TRIGGER IF EXISTS + CREATE TRIGGER。何度当てても同じ。
-- ─ 破壊性 ─ 新規オブジェクトの追加と、既存関数（roji_erasure_residue）の
--            CREATE OR REPLACE のみ。既存の表・データに一切触れない。
--
-- ─ 適用手順 ─
--
--   MIGRATE_ONLY=046 bash scripts/deploy-prod.sh
--
-- ⚠ 040 / 041 / 043 が先に当たっていること。
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認（無い物の上に建てない）
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.customer_events') IS NULL THEN
    RAISE EXCEPTION '046: customer_events が無い。041 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_canonical_subject') IS NULL THEN
    RAISE EXCEPTION '046: cdp_canonical_subject が無い。043 を先に当てること。';
  END IF;
  IF to_regclass('public.delivery_identity') IS NULL THEN
    RAISE EXCEPTION '046: delivery_identity が無い。043 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. 好みタイプの計算を 1 か所に置く（純関数群）
--
--    TypeScript 側（src/lib/firestore.ts の mergePersonaScoresWithSource /
--    pickPrimaryPersona）と **同じ決め方**をここに置く。2 か所にあるのは
--    Stage 4 では避けられない（Firestore 側の書き手はまだ生きている）ので、
--    せめて「どちらも同じ規則である」ことをテストで固定する
--    （tests/db/cdp-stage4-l1.db.test.ts / tests/unit/cdp-stage4-segment.test.ts）。
-- ===================================================================

/** 軸の並び。**同点のときの既定の優先順**でもある（TS 側 PERSONA_AXES と同一）。 */
CREATE OR REPLACE FUNCTION cdp_persona_axes() RETURNS text[] AS $$
  SELECT ARRAY['serenity', 'explorer', 'sensory']::text[];
$$ LANGUAGE sql IMMUTABLE;

/** 3 軸ゼロ。欠けた軸を落とさないための土台。 */
CREATE OR REPLACE FUNCTION cdp_persona_zero() RETURNS jsonb AS $$
  SELECT '{"serenity":0,"explorer":0,"sensory":0}'::jsonb;
$$ LANGUAGE sql IMMUTABLE;

/** jsonb から軸の数を読む（欠け・非数値は 0）。 */
CREATE OR REPLACE FUNCTION cdp_persona_num(p_bucket jsonb, p_axis text)
RETURNS numeric AS $$
DECLARE
  v text;
BEGIN
  IF p_bucket IS NULL OR jsonb_typeof(p_bucket) <> 'object' THEN RETURN 0; END IF;
  v := p_bucket ->> p_axis;
  IF v IS NULL THEN RETURN 0; END IF;
  BEGIN
    RETURN v::numeric;
  EXCEPTION WHEN others THEN
    RETURN 0;
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

/** 3 軸を 0 埋めで正規化する（余計なキーは落とす）。 */
CREATE OR REPLACE FUNCTION cdp_persona_normalize(p_bucket jsonb)
RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'serenity', cdp_persona_num(p_bucket, 'serenity'),
    'explorer', cdp_persona_num(p_bucket, 'explorer'),
    'sensory',  cdp_persona_num(p_bucket, 'sensory')
  );
$$ LANGUAGE sql IMMUTABLE;

/**
 * 好みタイプの代表値（primary）。
 *
 * 同点は **軸の固定順**で決め、いまの primary が同点の中に居ればそれを維持する
 * （TS 側 pickPrimaryPersona と同じ決め方 — 読むたびに人のタイプが入れ替わらない）。
 * 全部 0 なら NULL（「まだ手がかりが無い」を「serenity である」に化けさせない）。
 */
CREATE OR REPLACE FUNCTION cdp_persona_primary(p_scores jsonb, p_current text)
RETURNS text AS $$
DECLARE
  v_best   text := NULL;
  v_bestv  numeric := 0;
  v_axis   text;
  v_v      numeric;
BEGIN
  FOREACH v_axis IN ARRAY cdp_persona_axes() LOOP
    v_v := cdp_persona_num(p_scores, v_axis);
    IF v_best IS NULL OR v_v > v_bestv THEN
      v_best := v_axis;
      v_bestv := v_v;
    END IF;
  END LOOP;

  IF v_bestv <= 0 THEN RETURN NULL; END IF;

  -- 同点の維持: いまの primary が最高点タイなら動かさない。
  IF p_current IS NOT NULL
     AND p_current = ANY (cdp_persona_axes())
     AND cdp_persona_num(p_scores, p_current) = v_bestv THEN
    RETURN p_current;
  END IF;
  RETURN v_best;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

/**
 * 内訳の和が合計を超えていないか（§3-2 の不変条件 Σ(内訳) <= scores[軸]）。
 *
 * CHECK 制約から呼ぶので IMMUTABLE。超えた状態を **保存できなくする**のがこの関数の
 * 役目であり、超えないように畳むのは cdp_persona_sources_trim の役目。
 */
CREATE OR REPLACE FUNCTION cdp_persona_sources_within_total(p_scores jsonb, p_sources jsonb)
RETURNS boolean AS $$
DECLARE
  v_axis text;
  v_sum  numeric;
  v_src  text;
BEGIN
  IF p_sources IS NULL OR jsonb_typeof(p_sources) <> 'object' THEN RETURN true; END IF;
  FOREACH v_axis IN ARRAY cdp_persona_axes() LOOP
    v_sum := 0;
    FOR v_src IN SELECT k FROM jsonb_object_keys(p_sources) k LOOP
      -- lastUpdated など、3 軸のバケツでないキーは内訳ではないので数えない。
      CONTINUE WHEN jsonb_typeof(p_sources -> v_src) <> 'object';
      v_sum := v_sum + cdp_persona_num(p_sources -> v_src, v_axis);
    END LOOP;
    IF v_sum > cdp_persona_num(p_scores, v_axis) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

/**
 * 内訳が合計を超えているとき、**決まった順**で削って収める。
 *
 * ─ なぜ要るか ─
 *   合計も内訳も 0 未満にはしない（TS 側と同じ）。この 0 での切り上げが両方で
 *   独立に起きると、内訳の和だけが合計を上回ることがある（合計は 0 に張り付き、
 *   内訳は別のバケツに残る）。TS 側はこれを「見えたら 0 に倒す」で流していたが
 *   （unattributedPersonaScores）、DB 側は CHECK で保存を拒む側なので、
 *   **保存する前に**収めておく必要がある。
 *
 * ─ 削る順 ─
 *   diagnosis → survey → purchase → conversation → （それ以外はキー名昇順）の
 *   **逆順**から削る。重い出所（診断・アンケート）の記録を先に守る。順序を固定
 *   するのは、再計算のたびに違うバケツが削れると E8' が毎回不一致になるため。
 */
CREATE OR REPLACE FUNCTION cdp_persona_sources_trim(p_scores jsonb, p_sources jsonb)
RETURNS jsonb AS $$
DECLARE
  v_out    jsonb := coalesce(p_sources, '{}'::jsonb);
  v_axis   text;
  v_order  text[];
  v_src    text;
  v_sum    numeric;
  v_excess numeric;
  v_have   numeric;
  v_cut    numeric;
  i        integer;
BEGIN
  IF jsonb_typeof(v_out) <> 'object' THEN RETURN '{}'::jsonb; END IF;

  -- 既知の出所を先に、未知の出所を後ろに（キー名昇順）。削るのはこの逆順から。
  SELECT ARRAY(
    SELECT k FROM (
      SELECT k, CASE k
                  WHEN 'diagnosis'    THEN 1
                  WHEN 'survey'       THEN 2
                  WHEN 'purchase'     THEN 3
                  WHEN 'conversation' THEN 4
                  ELSE 5
                END AS ord
        FROM jsonb_object_keys(v_out) k
       WHERE jsonb_typeof(v_out -> k) = 'object'
    ) q ORDER BY q.ord, q.k
  ) INTO v_order;

  IF v_order IS NULL OR array_length(v_order, 1) IS NULL THEN RETURN v_out; END IF;

  FOREACH v_axis IN ARRAY cdp_persona_axes() LOOP
    v_sum := 0;
    FOREACH v_src IN ARRAY v_order LOOP
      v_sum := v_sum + cdp_persona_num(v_out -> v_src, v_axis);
    END LOOP;

    v_excess := v_sum - cdp_persona_num(p_scores, v_axis);
    CONTINUE WHEN v_excess <= 0;

    FOR i IN REVERSE array_length(v_order, 1) .. 1 LOOP
      EXIT WHEN v_excess <= 0;
      v_src := v_order[i];
      v_have := cdp_persona_num(v_out -> v_src, v_axis);
      CONTINUE WHEN v_have <= 0;
      v_cut := least(v_have, v_excess);
      v_out := jsonb_set(v_out, ARRAY[v_src, v_axis], to_jsonb(v_have - v_cut));
      v_excess := v_excess - v_cut;
    END LOOP;
  END LOOP;

  RETURN v_out;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ===================================================================
-- 2. L1 の 2 表
-- ===================================================================

CREATE TABLE IF NOT EXISTS subject_profile (
  -- canonical な主体 1 つにつき 1 行（連結成分の代表。link が足されたら畳み直す）。
  subject_id text PRIMARY KEY REFERENCES subjects(subject_id),

  -- 好みタイプ（項目7）。代表値と合計と内訳。合計と内訳の関係は下の CHECK が守る。
  persona_primary text,
  persona_scores  jsonb NOT NULL DEFAULT '{"serenity":0,"explorer":0,"sensory":0}'::jsonb,
  persona_sources jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 期間別内訳（§3-2 の persona_windows）。キーは JST の暦の月 'YYYY-MM'。
  -- now 相対の窓にしないのは、保存値と再計算値が時間の経過だけでずれないため。
  persona_windows jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ハード制約（§3-2）。**点数では絶対に覆らない**もの。
  --   tea_refs             … 「もういらない」お茶の銘柄番号（項目13 noneOf の L1 版）
  --   safety_tags          … 安全に関する申告（項目6）。**減らす方向に畳まない**（下記）
  --   broadcast_suppressed … 配信を止める（通知の停止申告）
  exclusions jsonb NOT NULL DEFAULT '{"tea_refs":[],"safety_tags":[],"broadcast_suppressed":false}'::jsonb,

  -- 本人訂正（§4 #18 profile_override）。field -> value。最後の訂正が勝つ。
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 事前通知の設定（§4 #18 notify_*）。key -> value。
  notify jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 畳んだ材料の量（「まだ何も無い」と「畳んだが空だった」を分ける）。
  event_count    bigint NOT NULL DEFAULT 0,
  folded_count   bigint NOT NULL DEFAULT 0,
  last_event_seq bigint NOT NULL DEFAULT 0,
  last_event_at  timestamptz,
  recomputed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subject_profile_primary_vocab
    CHECK (persona_primary IS NULL OR persona_primary IN ('serenity', 'explorer', 'sensory')),
  -- §3-2 の不変条件（案 A の評価どおり移送する）。
  CONSTRAINT subject_profile_sources_within_total
    CHECK (cdp_persona_sources_within_total(persona_scores, persona_sources))
);

CREATE INDEX IF NOT EXISTS subject_profile_primary
  ON subject_profile (persona_primary)
  WHERE persona_primary IS NOT NULL;

COMMENT ON TABLE subject_profile IS
  'L1。L0（customer_events）を畳んだ解釈を 1 冊に持つ。**L0 から全再計算可能**が不変条件で、'
  ' 畳み方の定義は cdp_l1_build_profile 1 か所にある。追記専用ではない（派生なので作り直せる）。'
  ' 匿名・未連携も subject を持つため、未連携用の 2 冊目（Firestore lineUsers/）が要らなくなる（T-9）。'
  ' ⚠ PII を入れない（生 LINE userId / メール / 会話本文は載せない。配信の宛先は delivery_identity）。';

COMMENT ON COLUMN subject_profile.exclusions IS
  'ハード制約。点数では絶対に覆らない。safety_tags は **減らす方向に畳まない**'
  '（カルテ定義「片方にでも申告があれば必ず残す。消す方向の統合を絶対にしない」）。';

COMMENT ON COLUMN subject_profile.persona_windows IS
  '期間別内訳。キーは JST の暦の月（YYYY-MM）。now 相対の窓にすると、保存値と再計算値が'
  ' 時間の経過だけで食い違い E8'' の一致判定が毎日偽陽性になる。';

CREATE TABLE IF NOT EXISTS subject_segment_state (
  subject_id  text NOT NULL REFERENCES subjects(subject_id),
  -- 'persona:serenity' 等。open（新しいセグメントを足すのに DDL は要らない）。
  segment_key text NOT NULL,
  in_segment  boolean NOT NULL,
  -- **入らなかった理由**。無言で外さない（T-12 と同じ作法）。
  reason      text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, segment_key),
  CONSTRAINT subject_segment_state_key_form CHECK (segment_key ~ '^[a-z][a-z0-9_]*(:[a-z0-9_]+)*$')
);

-- 配信の宛先解決はここを引く（セグメント → 人）。入っている行だけの部分 index。
CREATE INDEX IF NOT EXISTS subject_segment_state_members
  ON subject_segment_state (segment_key, subject_id)
  WHERE in_segment;

COMMENT ON TABLE subject_segment_state IS
  'L1。「この人はこのセグメントに入るか」を 1 行で持つ。配信の宛先解決（cdp_segment_line_targets）は'
  ' この表を引く — Firestore の全件スキャン 3 本（delivery-runtime.ts / T-11）の置き換え先。'
  ' 入らなかった行も reason 付きで残す（なぜ対象外かを後から言えるようにする）。';

ALTER TABLE subject_profile       ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_segment_state ENABLE ROW LEVEL SECURITY;

-- 消した人の解釈は復活しない（041 の cdp_reject_retired_subject を再利用）。
DROP TRIGGER IF EXISTS subject_profile_no_retired ON subject_profile;
CREATE TRIGGER subject_profile_no_retired
  BEFORE INSERT ON subject_profile
  FOR EACH ROW EXECUTE FUNCTION cdp_reject_retired_subject();

DROP TRIGGER IF EXISTS subject_segment_state_no_retired ON subject_segment_state;
CREATE TRIGGER subject_segment_state_no_retired
  BEFORE INSERT ON subject_segment_state
  FOR EACH ROW EXECUTE FUNCTION cdp_reject_retired_subject();

-- ===================================================================
-- 3. 畳み方の唯一の定義 — cdp_l1_build_profile
--
--    書く側（cdp_l1_recompute_subject）も検算する側（cdp_l1_recompute_parity）も
--    この関数を呼ぶ。**畳み方を 2 か所に書かない**（2 か所にあると、片方だけ直した
--    日に「一致していない」のか「直した」のか区別できなくなる）。
--
--    返すのは **導出値だけ**。recomputed_at のような時刻は返さない（時刻を混ぜると
--    「保存値と再計算値が等しい」を jsonb の等値で言えなくなる）。
--
--    ─ 畳む対象 ─
--      連結成分（cdp_subject_component）に属する全主体の customer_events。
--      link が足されたら同じ 1 人として畳まれる（★11 と同じ解き方を使い回す）。
--
--    ─ schema_ok = false は畳まない ─
--      未知の語彙・壊れた payload は **保存はされている**（E1）が、意味が確定して
--      いないので解釈には使わない。何件あったかは folded_count と event_count の
--      差で分かる（黙って捨てない）。
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

      -- 移行の起点。Firestore に既に貯まっていた点を 1 回だけ L0 に載せ、
      -- ここで土台にする（これが無いと L1 は「記録を始めてから」の点しか持てず、
      -- 新旧の配信対象が構造的にずれ続ける）。後から来た baseline が勝つ。
      WHEN 'persona.baseline_imported' THEN
        v_scores  := cdp_persona_normalize(r.payload -> 'scores');
        v_sources := coalesce(
          CASE WHEN jsonb_typeof(r.payload -> 'sources') = 'object'
               THEN r.payload -> 'sources' ELSE NULL END,
          '{}'::jsonb);

      -- 点が動いた 1 回分。合計・出所別内訳・その月の内訳を **同じ増減で**動かす。
      WHEN 'persona.signal_applied' THEN
        v_src := coalesce(nullif(r.payload ->> 'source', ''), 'unknown');
        FOREACH v_axis IN ARRAY cdp_persona_axes() LOOP
          v_delta := cdp_persona_num(r.payload -> 'delta', v_axis);
          CONTINUE WHEN v_delta = 0;

          -- 合計は 0 未満にしない（TS 側 mergePersonaScoresWithSource と同じ）。
          v_before := cdp_persona_num(v_scores, v_axis);
          v_after  := greatest(0, v_before + v_delta);
          -- **実際に効いた分**だけを内訳にも入れる。合計が 0 で止まったのに内訳だけ
          -- 動くと、内訳の和が合計を上回る（CHECK で保存できなくなる）。
          v_eff := v_after - v_before;
          CONTINUE WHEN v_eff = 0;

          v_scores := jsonb_set(v_scores, ARRAY[v_axis], to_jsonb(v_after));

          -- ⚠ coalesce を外さないこと。キーが無いとき `v_sources -> v_src` は NULL で、
          --   jsonb_typeof(NULL) も NULL になる。NULL <> 'object' は **真ではなく NULL**
          --   なので IF が成立せず、バケツが作られない。すると次の jsonb_set は
          --   （親が無い経路なので）**黙って何もせず元の値を返し**、内訳が永久に空のまま
          --   になる（合計だけ増えて内訳が空、という壊れ方をする）。
          IF coalesce(jsonb_typeof(v_sources -> v_src), 'null') <> 'object' THEN
            v_sources := jsonb_set(v_sources, ARRAY[v_src], cdp_persona_zero(), true);
          END IF;
          v_sources := jsonb_set(
            v_sources, ARRAY[v_src, v_axis],
            to_jsonb(greatest(0, cdp_persona_num(v_sources -> v_src, v_axis) + v_eff)));

          -- ⚠ 上と同じ理由で coalesce が要る（NULL 比較で IF が成立しない）。
          IF coalesce(jsonb_typeof(v_windows -> v_month), 'null') <> 'object' THEN
            v_windows := jsonb_set(v_windows, ARRAY[v_month], cdp_persona_zero(), true);
          END IF;
          v_windows := jsonb_set(
            v_windows, ARRAY[v_month, v_axis],
            to_jsonb(greatest(0, cdp_persona_num(v_windows -> v_month, v_axis) + v_eff)));
        END LOOP;

      -- 「もういらない」（項目13 noneOf の L1 版）。割当の必須条件。
      WHEN 'exclusion.set' THEN
        v_ref := nullif(btrim(coalesce(r.payload ->> 'ref', '')), '');
        IF v_ref IS NOT NULL AND NOT (v_ref = ANY (v_tea)) THEN
          v_tea := v_tea || v_ref;
        END IF;

      -- 解除できる（項目13「それぞれ解除できる」）。安全申告は解除できない（下記）。
      WHEN 'exclusion.cleared' THEN
        v_ref := nullif(btrim(coalesce(r.payload ->> 'ref', '')), '');
        IF v_ref IS NOT NULL THEN
          SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO v_tea
            FROM unnest(v_tea) x WHERE x <> v_ref;
        END IF;

      -- 安全に関する申告（項目6）。**union のみ**。カルテ定義が「片方にでも申告が
      -- あれば必ず残す。消す方向の統合を絶対にしない」と定めているので、L1 でも
      -- 減らす畳み方を作らない（作れば「消せる経路」がそこに生まれる）。
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

      -- 事前通知の設定（§4 #18 notify_*）。最後の設定が勝つ。
      WHEN 'notify.preference_set' THEN
        v_key := nullif(btrim(coalesce(r.payload ->> 'key', '')), '');
        IF v_key IS NOT NULL THEN
          v_notify := jsonb_set(v_notify, ARRAY[v_key],
                                coalesce(r.payload -> 'value', 'null'::jsonb), true);
        END IF;

      -- 「もう送らないで」。配信の宛先解決（cdp_segment_line_targets）が実際に外す。
      WHEN 'notify.suppressed' THEN
        v_suppress := true;
        v_notify := jsonb_set(v_notify, ARRAY['suppressed_reason'],
                              to_jsonb(coalesce(r.payload ->> 'reason', 'unspecified')), true);

      WHEN 'notify.resumed' THEN
        v_suppress := false;
        v_notify := v_notify - 'suppressed_reason';

      -- 本人訂正（§4 #18 profile_override）。最後の訂正が勝つ。
      WHEN 'profile.override' THEN
        v_key := nullif(btrim(coalesce(r.payload ->> 'field', '')), '');
        IF v_key IS NOT NULL THEN
          v_overrides := jsonb_set(v_overrides, ARRAY[v_key],
                                   coalesce(r.payload -> 'value', 'null'::jsonb), true);
        END IF;

      ELSE
        -- 解釈に使わない出来事（行動ログ・フロー・購入そのもの）。畳んだ数には入る。
        NULL;
    END CASE;
  END LOOP;

  -- 内訳を合計の中に収める（保存できない状態を作らない）。
  v_sources := cdp_persona_sources_trim(v_scores, v_sources);
  v_primary := cdp_persona_primary(v_scores, NULL);

  -- 本人訂正で好みタイプを直接上書きできる（項目20 の系譜。点は動かさない）。
  IF v_overrides ? 'persona_primary' THEN
    v_key := v_overrides ->> 'persona_primary';
    IF v_key = ANY (cdp_persona_axes()) THEN
      v_primary := v_key;
    ELSIF v_key IS NULL OR v_key = '' THEN
      v_primary := NULL;
    END IF;
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
    'event_count',    v_total,
    'folded_count',   v_folded,
    'last_event_seq', v_last_seq,
    'last_event_at',  v_last_at
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l1_build_profile(text) IS
  'L1 の畳み方の**唯一の定義**。L0 だけを読み、導出値だけを返す（時刻は返さない）。'
  ' 書く側（cdp_l1_recompute_subject）と検算する側（cdp_l1_recompute_parity）が同じこれを呼ぶ。';

-- ===================================================================
-- 4. 書く — 1 人分を畳んで L1 に置く
--
--    canonical でない主体の行は消す（link が足された日に「同じ人の L1 が 2 行」に
--    ならないようにする。045 が persons.subject_id を canonical で返すのと同じ理由）。
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

  -- 代表でなくなった主体の行を落とす（1 人 = 1 行を保つ）。
  DELETE FROM subject_profile
   WHERE subject_id = ANY (v_members) AND subject_id <> v_canonical;
  DELETE FROM subject_segment_state
   WHERE subject_id = ANY (v_members) AND subject_id <> v_canonical;

  INSERT INTO subject_profile (
    subject_id, persona_primary, persona_scores, persona_sources, persona_windows,
    exclusions, overrides, notify,
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
    event_count     = EXCLUDED.event_count,
    folded_count    = EXCLUDED.folded_count,
    last_event_seq  = EXCLUDED.last_event_seq,
    last_event_at   = EXCLUDED.last_event_at,
    recomputed_at   = now();

  -- セグメント（好みタイプ別）。**入らなかった行も理由付きで残す**。
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
-- 5. 配信の宛先を delivery_identity に寄せる（E5 を破らずに未連携も届かせる）
--
--    ─ なぜ要るか ─
--      delivery_identity は Stage 2 では **連携が成立したとき**にだけ派生していた
--      （account-link / identity ルート）。だが T-9 が置き換えようとしている
--      lineUsers 直読みは **未連携の人**の宛先を出す経路である。派生を連携時だけに
--      しておくと、新しい resolver は未連携の人を 1 人も出せず、新旧が構造的に
--      食い違う（＝ Stage 4 の完了条件に永久に届かない）。
--
--    ─ どこから採るか ─
--      identity_edges の line_messaging_uid（= LINE webhook 由来の生 userId で、
--      Stage 1 の gateway が主体を発行したときに 1 行だけ入っている）。
--      **新しい置き場は作らない** — 生値の保管は delivery_identity 1 表のままで、
--      edges は「観測の台帳」として既に同じ値を持っている（E5 の数は増えない）。
--
--    ─ 1 主体 1 宛先 ─
--      同じ連結成分に LINE が 2 本ある状態は J-4 のトリガが作らせない。念のため
--      edge_seq の若い順で 1 本だけ採る（決定的）。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_derive_delivery_identity(p_limit integer DEFAULT 5000)
RETURNS jsonb AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH cand AS (
    SELECT DISTINCT ON (cdp_canonical_subject(e.subject_id))
           cdp_canonical_subject(e.subject_id) AS subject_id,
           e.identifier_value                  AS line_user_id
      FROM identity_edges e
      JOIN subjects s ON s.subject_id = e.subject_id AND s.retired_at IS NULL
     WHERE e.identifier_kind = 'line_messaging_uid'
       AND e.identifier_value ~ '^U[0-9a-f]{32}$'
     ORDER BY cdp_canonical_subject(e.subject_id), e.edge_seq
     LIMIT greatest(coalesce(p_limit, 5000), 1)
  ), ins AS (
    INSERT INTO delivery_identity (subject_id, line_user_id, source, updated_at)
    SELECT c.subject_id, c.line_user_id, 'cdp.l1-derive', now()
      FROM cand c
      -- 主体側にも宛先側にも既存があれば触らない（連携時に入った行を上書きしない）。
     WHERE NOT EXISTS (SELECT 1 FROM delivery_identity d WHERE d.subject_id = c.subject_id)
       AND NOT EXISTS (SELECT 1 FROM delivery_identity d WHERE d.line_user_id = c.line_user_id)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 6. まとめて畳み直す（日次）
--
--    L0 に新しい出来事が入った主体だけを畳み直す。**畳み残しを数えて返す**ので、
--    上限で切れた日は次の実行が続きから拾う（黙って取りこぼさない）。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_recompute_all(p_limit integer DEFAULT 500)
RETURNS jsonb AS $$
DECLARE
  v_limit    integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_done     integer := 0;
  v_pending  bigint  := 0;
  v_derived  jsonb;
  r          record;
BEGIN
  v_derived := cdp_l1_derive_delivery_identity(v_limit);

  FOR r IN
    -- 畳み直しが要る主体 = 「L1 が無い」か「L1 の last_event_seq より新しい出来事がある」。
    SELECT c.subject_id, max(c.event_seq) AS max_seq
      FROM customer_events c
      JOIN subjects s ON s.subject_id = c.subject_id AND s.retired_at IS NULL
     GROUP BY c.subject_id
    HAVING NOT EXISTS (
             SELECT 1 FROM subject_profile p
              WHERE p.subject_id = cdp_canonical_subject(c.subject_id)
                AND p.last_event_seq >= max(c.event_seq))
     ORDER BY max(c.event_seq)
     LIMIT v_limit
  LOOP
    PERFORM cdp_l1_recompute_subject(r.subject_id);
    v_done := v_done + 1;
  END LOOP;

  SELECT count(*) INTO v_pending FROM (
    SELECT c.subject_id
      FROM customer_events c
      JOIN subjects s ON s.subject_id = c.subject_id AND s.retired_at IS NULL
     GROUP BY c.subject_id
    HAVING NOT EXISTS (
             SELECT 1 FROM subject_profile p
              WHERE p.subject_id = cdp_canonical_subject(c.subject_id)
                AND p.last_event_seq >= max(c.event_seq))
  ) q;

  RETURN jsonb_build_object(
    'recomputed',        v_done,
    'still_pending',     v_pending,
    'delivery_identity', v_derived
  );
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 7. E8' の L1 側 — 「保存してある解釈は、いま L0 から畳み直したものと同じか」
--
--    ─ これが答える問い ─
--      L1 は速さのための作り置きである。作り置きが元（L0）とずれていたら、
--      配信も割当も「古い解釈」で動く。ずれを **後から気づく**のではなく毎日数える。
--
--    ─ 比べるもの ─
--      導出値だけ（cdp_l1_build_profile の返り）。recomputed_at のような時刻は
--      比較に入れない（入れると必ず不一致になる）。
--
--    @reader src/lib/cdp/stage4-parity.ts
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
    CONTINUE WHEN v_fresh IS NULL;   -- 消去済み等（別の検算 = 孤児検査が拾う）

    v_stored := jsonb_build_object(
      'subject_id',      r.subject_id,
      'persona_primary', r.persona_primary,
      'persona_scores',  r.persona_scores,
      'persona_sources', r.persona_sources,
      'persona_windows', r.persona_windows,
      'exclusions',      r.exclusions,
      'overrides',       r.overrides,
      'notify',          r.notify,
      'event_count',     r.event_count,
      'folded_count',    r.folded_count,
      'last_event_seq',  r.last_event_seq,
      'last_event_at',   r.last_event_at
    );

    v_checked := v_checked + 1;
    IF v_stored <> v_fresh THEN
      v_mismatch := v_mismatch + 1;
      -- どの項目がずれたかまで残す（「一致しなかった」だけでは次の一手が決まらない）。
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
    -- 1 件も見ていない日を「一致した日」と言わない（空虚合格を作らない）。
    'in_agreement',     (v_checked > 0 AND v_mismatch = 0)
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l1_recompute_parity(integer) IS
  'E8'' の L1 側。保存してある解釈と、いま L0 から畳み直した解釈を比べる。'
  ' 1 件も見ていない日は in_agreement=false（空虚合格を作らない）。読み取り専用。';

-- ===================================================================
-- 8. セグメント配信の SQL 1 本（T-11 の置き換え先）
--
--    いま delivery-runtime.ts が回している 3 本の全件スキャン
--      (1) Supabase customer_linkages 全件
--      (2) Firestore users の persona EQUAL クエリ（cursor ページング）
--      (3) Firestore lineUsers の persona EQUAL クエリ（cursor ページング）
--    が、この 1 本になる。
--
--    ─ 除外（ここが「除外条件が割当・配信に実効」の実体）─
--      * 消去済み（subjects.retired_at）
--      * 通知の停止申告（exclusions.broadcast_suppressed）
--      * 友だち解除（customer_linkages.unfollowed_at）
--        ⚠ Stage 4 の時点では friend 解除の事実が L0 に無い（LINE の unfollow は
--          customer_linkages の列にしか残っていない）。**ここだけ旧台帳を読む**。
--          Stage 5 で unfollow を L0 の出来事にしてから、この枝を外す（T-7）。
--          「読んでいる」ことを隠さないために excluded の内訳に数えて返す。
--
--    ─ opt-out は見ない ─
--      broadcast_opted_out は 2026-07-13 のオーナー方針で配信経路から廃止済み
--      （配信停止は LINE 標準ブロックに委譲）。旧 resolver（filterEligible）も
--      見ていないので、ここでも見ない — **新旧を一致させるために揃える**。
--
--    @reader src/lib/cdp/segment-resolver.ts
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_segment_line_targets(
  p_persona text,
  p_limit   integer DEFAULT 5000
)
RETURNS jsonb AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 5000), 1), 50000);
  v_ids   jsonb;
  v_n     integer;
  v_members        bigint := 0;
  v_no_address     bigint := 0;
  v_unfollowed     bigint := 0;
  v_suppressed     bigint := 0;
BEGIN
  IF p_persona IS NULL OR NOT (p_persona = ANY (cdp_persona_axes())) THEN
    RAISE EXCEPTION 'cdp_segment_line_targets: 未知の好みタイプ（受領: %）', p_persona;
  END IF;

  -- 内訳（なぜ減ったかを言えるようにする。数だけで PII は返さない）。
  SELECT
    count(*),
    count(*) FILTER (WHERE d.line_user_id IS NULL),
    count(*) FILTER (WHERE d.line_user_id IS NOT NULL AND cl.unfollowed_at IS NOT NULL)
    INTO v_members, v_no_address, v_unfollowed
    FROM subject_segment_state s
    JOIN subjects sj ON sj.subject_id = s.subject_id AND sj.retired_at IS NULL
    LEFT JOIN delivery_identity d ON d.subject_id = s.subject_id
    LEFT JOIN customer_linkages cl ON cl.line_user_id = d.line_user_id
   WHERE s.segment_key = 'persona:' || p_persona
     AND s.in_segment;

  SELECT count(*) INTO v_suppressed
    FROM subject_segment_state s
   WHERE s.segment_key = 'persona:' || p_persona
     AND NOT s.in_segment
     AND s.reason = 'broadcast_suppressed';

  SELECT coalesce(jsonb_agg(t.line_user_id ORDER BY t.line_user_id), '[]'::jsonb), count(*)
    INTO v_ids, v_n
    FROM (
      SELECT DISTINCT d.line_user_id
        FROM subject_segment_state s
        JOIN subjects sj ON sj.subject_id = s.subject_id AND sj.retired_at IS NULL
        JOIN delivery_identity d ON d.subject_id = s.subject_id
       WHERE s.segment_key = 'persona:' || p_persona
         AND s.in_segment
         AND NOT EXISTS (
               SELECT 1 FROM customer_linkages cl
                WHERE cl.line_user_id = d.line_user_id
                  AND cl.unfollowed_at IS NOT NULL)
       ORDER BY d.line_user_id
       LIMIT v_limit
    ) t;

  RETURN jsonb_build_object(
    'persona',   p_persona,
    'count',     v_n,
    'user_ids',  v_ids,
    -- 上限に当たったら黙って削らない（呼び出し側が fail-closed を選べるようにする）。
    'truncated', v_n >= v_limit,
    'excluded',  jsonb_build_object(
      'segment_members',      v_members,
      'no_delivery_address',  v_no_address,
      'unfollowed',           v_unfollowed,
      'broadcast_suppressed', v_suppressed
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_segment_line_targets(text, integer) IS
  'セグメント配信の宛先を L1 から 1 本の SQL で出す（T-11 の置き換え先）。'
  ' Firestore の全件スキャン 3 本と入れ替える先だが、**Stage 4 では並走**する'
  '（撤去は Stage 5）。unfollow だけは旧台帳 customer_linkages を読む（L0 に事実が'
  ' 無いため。Stage 5 で L0 の出来事にしてからこの枝を外す）。';

-- ===================================================================
-- 9. 割当（roji 月次）が読む除外条件
--
--    月次割当は Shopify 顧客番号を鍵に回る（migration 033 の台帳の鍵）。
--    L1 の除外条件をその鍵で引けるようにする。**割当側に新しい鍵を作らない**。
--
--    @reader scripts/roji-monthly-run.ts
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_exclusions_by_shopify(p_shopify_customer_ids text[])
RETURNS jsonb AS $$
DECLARE
  v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(q.shopify_customer_id, q.exclusions), '{}'::jsonb)
    INTO v_rows
    FROM (
      SELECT DISTINCT ON (e.identifier_value)
             e.identifier_value AS shopify_customer_id,
             p.exclusions       AS exclusions
        FROM identity_edges e
        JOIN subjects s ON s.subject_id = e.subject_id AND s.retired_at IS NULL
        JOIN subject_profile p ON p.subject_id = cdp_canonical_subject(e.subject_id)
       WHERE e.identifier_kind = 'shopify_customer_id'
         AND e.identifier_value = ANY (coalesce(p_shopify_customer_ids, ARRAY[]::text[]))
       ORDER BY e.identifier_value, e.edge_seq
    ) q;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_l1_exclusions_by_shopify(text[]) IS
  'roji 月次割当が読む除外条件（「もういらない」・安全申告）を Shopify 顧客番号で引く。'
  ' 割当側に新しい鍵を作らないための口。読み取り専用・PII を返さない。';

-- ===================================================================
-- 10. 検算に L1 の 2 表を載せる（043 の差し替え）
--
--     列挙（roji_person_key_map）経由の数え方は subject_id 列があるので既に載る。
--     ここで足すのは **辿らずに数える孤児検査**のほう（retire 済みの主体を指す行）。
-- ===================================================================
CREATE OR REPLACE FUNCTION roji_erasure_residue(
  p_shopify_ids text[],
  p_line_ids    text[],
  p_web_refs    text[]
) RETURNS jsonb AS $$
DECLARE
  v_shopify text[] := coalesce(p_shopify_ids, ARRAY[]::text[]);
  v_line    text[] := coalesce(p_line_ids,    ARRAY[]::text[]);
  v_web     text[] := coalesce(p_web_refs,    ARRAY[]::text[]);
  v_actors  text[];
  v_subjects text[];
  v_remaining jsonb := '{}'::jsonb;
  v_preserved jsonb;
  v_orphans bigint := 0;
  r         record;
  v_vals    text[];
  v_n       bigint;
BEGIN
  v_actors := v_line || v_web;

  SELECT coalesce(array_agg(DISTINCT e.subject_id), ARRAY[]::text[]) INTO v_subjects
    FROM identity_edges e
   WHERE (e.identifier_kind = 'shopify_customer_id' AND e.identifier_value = ANY (v_shopify))
      OR (e.identifier_kind IN ('line_messaging_uid', 'line_login_uid')
          AND e.identifier_value = ANY (v_line))
      OR (e.identifier_kind IN ('web_session_id', 'web_anonymous_id')
          AND e.identifier_value = ANY (v_web));

  SELECT coalesce(array_agg(DISTINCT sj), ARRAY[]::text[]) INTO v_subjects FROM (
    SELECT unnest(v_subjects) AS sj
    UNION
    SELECT m FROM unnest(v_subjects) AS x, LATERAL unnest(cdp_subject_component(x)) AS m
  ) q WHERE sj IS NOT NULL AND sj <> '';

  FOR r IN SELECT * FROM roji_person_key_map() LOOP
    v_vals := CASE r.key_kind
                WHEN 'shopify' THEN v_shopify
                WHEN 'line'    THEN v_line
                WHEN 'web'     THEN v_web
                WHEN 'subject' THEN v_subjects
                ELSE                v_actors
              END;
    IF array_length(v_vals, 1) IS NULL THEN
      v_remaining := v_remaining || jsonb_build_object(r.tbl, coalesce((v_remaining->>r.tbl)::bigint, 0));
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = ANY($1)', r.tbl, r.col)
      INTO v_n USING v_vals;

    v_remaining := v_remaining || jsonb_build_object(
      r.tbl, coalesce((v_remaining->>r.tbl)::bigint, 0) + v_n);
  END LOOP;

  v_remaining := v_remaining || jsonb_build_object(
    'roji_word_person_refs', (SELECT count(*) FROM roji_word_person_refs
                                WHERE (subject_kind = 'shopify' AND subject_id = ANY (v_shopify))
                                   OR (subject_kind = 'line'    AND subject_id = ANY (v_line))),
    'roji_words_person_linked', (SELECT count(*) FROM roji_words w
                                   WHERE w.person_seq IN (
                                     SELECT person_seq FROM roji_word_person_refs
                                      WHERE (subject_kind = 'shopify' AND subject_id = ANY (v_shopify))
                                         OR (subject_kind = 'line'    AND subject_id = ANY (v_line))))
  );

  -- ── 辿らずに数える孤児検査 ──
  --   046: L1 の 2 表（subject_profile / subject_segment_state）を足した。
  --   解釈は事実より後に作られるので、消去のあとに **畳み直しが走って復活する**
  --   経路が理屈の上ではありうる（実際には cdp_reject_retired_subject が INSERT を
  --   止めるが、止まっていることをこの数で確かめられるようにしておく）。
  SELECT
    coalesce((SELECT count(*) FROM customer_events ce
                JOIN subjects s ON s.subject_id = ce.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM identity_edges ie
                JOIN subjects s ON s.subject_id = ie.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM subject_links sl
                JOIN subjects s ON s.subject_id IN (sl.subject_a, sl.subject_b)
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM delivery_identity di
                JOIN subjects s ON s.subject_id = di.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM subject_profile sp
                JOIN subjects s ON s.subject_id = sp.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM subject_segment_state ss
                JOIN subjects s ON s.subject_id = ss.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
    INTO v_orphans;

  v_remaining := v_remaining || jsonb_build_object('cdp_retired_subject_orphans', v_orphans);

  SELECT jsonb_build_object(
    'roji_edit_records',    (SELECT count(*) FROM roji_edit_records),
    'roji_words_anonymous', (SELECT count(*) FROM roji_words WHERE person_seq IS NULL),
    'roji_delivery_months', (SELECT count(*) FROM roji_delivery_months)
  ) INTO v_preserved;

  RETURN jsonb_build_object(
    'remaining', v_remaining,
    'preserved', v_preserved,
    'clean',     coalesce((SELECT bool_and(value::text::bigint = 0) FROM jsonb_each(v_remaining)), true)
  );
END;
$$ LANGUAGE plpgsql;
