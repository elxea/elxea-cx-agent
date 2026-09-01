-- 052: L1 の畳み直しが「列が増えたこと」に気づかない穴を塞ぐ
--
-- 設計正本: 顧客データ統合 統合設計（最終案, 2026-08-28）§3-2 L1 / §5 E8'
-- 直接の契機: 051 の本番適用（2026-09-01・bquqzrbzdzjegdovxalu）で発覚した実障害
--
-- ─ 何が起きたか（実測）─
--
--   051 は適用に成功した。だが手順どおり cdp_l1_recompute_all() を呼んでも
--   {"recomputed":0,"still_pending":0} で **1 件も畳み直されなかった**。
--   結果、既存 6 profile の taste / scene / provenance は DEFAULT '{}' のまま残り、
--   cdp_l1_recompute_parity() が in_agreement=false（checked=6 / mismatched=6）になった。
--
-- ─ なぜ起きたか（根因）─
--
--   046 の cdp_l1_recompute_all は「畳み直しが要る主体」を **last_event_seq だけ**で
--   判定していた:
--
--       pending = L1 が無い OR L1.last_event_seq < max(customer_events.event_seq)
--
--   051 は列を足しただけで **新しい出来事は 1 件も増やしていない**。よって
--   last_event_seq は据え置きのまま条件を満たさず、全員が「畳み直し不要」と判定された。
--   出来事の増加は検知するが、**解釈の形が変わったこと**は検知できない作りだった。
--
--   051 が cdp_l1_build_profile / _recompute_subject / _recompute_parity の 3 本を
--   差し替えながら **_recompute_all を差し替えなかった**のが直接の抜けである。
--
-- ─ どう直すか（恒久 + 一回性）─
--
--   (1) 恒久: 判定に「解釈の形の版」を足す。版は subject_profile の列構成から
--       **自動で**導く（cdp_l1_shape_fingerprint）。よって 053 以降で列を足しても、
--       migration 作者が何かを書き足さなくても全員が pending になる。
--       ＝ 同じ穴を二度踏まない。手で版番号を上げる方式にしないのはそのため
--       （上げ忘れが同じ障害を再生産する）。
--
--   (2) 一回性: 本 migration の中で既存 profile を全件強制的に畳み直す。
--       051 で取り残された 6 件（本番実測）がこれで埋まる。
--
--   (3) ついでに塞ぐ 2 つ目の穴: 046 の判定は customer_events を起点に組み立てて
--       いたため、**出来事が 1 件も無い profile 行**は候補にすら入らなかった。
--       候補を customer_events 側と subject_profile 側の和集合にする。
--
-- ─ shape_fingerprint を「導出値」に入れない理由 ─
--   これは解釈そのものではなく「どの版で畳んだか」という保管側の情報である。
--   cdp_l1_build_profile の返り（＝ E8' が比べる対象）に入れると、検算が
--   「解釈が合っているか」ではなく「版が同じか」も見ることになり、意味が濁る。
--   よって書き込み側（_recompute_subject）だけが触り、検算は従来どおり解釈だけを比べる。
--
-- ─ 冪等性 ─ ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE FUNCTION / 全件畳み直し。
--            何度当てても同じ状態に収束する（畳み直しは L0 からの再計算なので副作用が無い）。
-- ─ 破壊性 ─ 追加のみ。列の削除・型変更・出来事の書き換えを一切行わない。

-- ===================================================================
-- 0. 前提の確認（無い物の上に建てない）
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.subject_profile') IS NULL THEN
    RAISE EXCEPTION '052: subject_profile が無い。046 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_l1_build_profile') IS NULL THEN
    RAISE EXCEPTION '052: cdp_l1_build_profile が無い。046 / 051 を先に当てること。';
  END IF;
  -- 051 が当たっていることを、051 が足した列の実在で確かめる。
  -- （052 の一回性の是正は「051 の取り残し」を埋めるものなので、051 が無い状態で
  --   当てても意味が無い。順序を取り違えたまま進ませない。）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'subject_profile' AND column_name = 'taste'
  ) THEN
    RAISE EXCEPTION '052: subject_profile.taste が無い。051 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. 解釈の形の版（列構成から自動で導く）
--
--    ─ なぜ列構成から導くのか ─
--      手で版番号を管理する方式（定数を返す関数を migration ごとに書き換える）は、
--      **書き換え忘れが今回とまったく同じ障害を生む**。列を足せば必ず変わる値を
--      版にすれば、忘れようがない。
--
--    ─ 何を含めるか ─
--      subject_profile の全列名（順不同を避けるため名前順）。列の増減・改名で変わる。
--      型の変更では変わらないが、型だけ変えて意味が変わる改修は L1 では想定していない
--      （jsonb の中身の意味が変わる場合は列名か列数が動く）。
--
--    ⚠ STABLE であって IMMUTABLE ではない。information_schema を読むため、
--      同じ引数でも DDL の前後で値が変わる。index や生成列から呼んではいけない。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_shape_fingerprint()
RETURNS text AS $$
  SELECT md5(string_agg(column_name, ',' ORDER BY column_name))
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'subject_profile';
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION cdp_l1_shape_fingerprint() IS
  'L1 の「解釈の形の版」。subject_profile の列名から自動で導くので、列を足せば必ず変わる。'
  ' cdp_l1_recompute_all がこれを見て「出来事は増えていないが形が変わった」を検知する。'
  ' ⚠ 手で上げる版番号にしないのは、上げ忘れが 051 の障害（畳み直しが 0 件）を再生産するため。';

-- 保存側に「どの版で畳んだか」を持たせる。
-- ⚠ DEFAULT を付けない。既存行を NULL のままにしておくことで、
--   この migration を当てた直後の既存行が **必ず pending** になる（＝取り残しが起きない）。
ALTER TABLE subject_profile
  ADD COLUMN IF NOT EXISTS shape_fingerprint text;

COMMENT ON COLUMN subject_profile.shape_fingerprint IS
  'この行を畳んだときの「解釈の形の版」（cdp_l1_shape_fingerprint）。'
  ' 解釈そのものではなく保管側の情報なので、**E8'' の比較対象には入れない**。'
  ' NULL は「版が分からない = 畳み直しが要る」。';

-- ===================================================================
-- 2. 書く側に版を刻ませる（051 の cdp_l1_recompute_subject を差し替え）
--
--    差分は shape_fingerprint を書く 1 列だけ。畳み方・セグメントの決め方・
--    代表でない行を落とす挙動は 051 から 1 文字も変えていない。
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
    (v_p ->> 'event_count')::bigint,
    (v_p ->> 'folded_count')::bigint,
    (v_p ->> 'last_event_seq')::bigint,
    nullif(v_p ->> 'last_event_at', '')::timestamptz,
    now(),
    v_shape
  )
  ON CONFLICT (subject_id) DO UPDATE SET
    persona_primary   = EXCLUDED.persona_primary,
    persona_scores    = EXCLUDED.persona_scores,
    persona_sources   = EXCLUDED.persona_sources,
    persona_windows   = EXCLUDED.persona_windows,
    exclusions        = EXCLUDED.exclusions,
    overrides         = EXCLUDED.overrides,
    notify            = EXCLUDED.notify,
    taste             = EXCLUDED.taste,
    scene             = EXCLUDED.scene,
    provenance        = EXCLUDED.provenance,
    event_count       = EXCLUDED.event_count,
    folded_count      = EXCLUDED.folded_count,
    last_event_seq    = EXCLUDED.last_event_seq,
    last_event_at     = EXCLUDED.last_event_at,
    recomputed_at     = now(),
    shape_fingerprint = EXCLUDED.shape_fingerprint;

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
-- 3. 「畳み直しが要る人」の判定を作り直す（046 の cdp_l1_recompute_all を差し替え）
--
--    ─ 046 からの差分は 2 点 ─
--      (a) 判定に「形が変わった」を足した（今回の根因）
--      (b) 候補を customer_events 側 **と** subject_profile 側の和集合にした
--          （046 は customer_events を起点にしていたので、出来事が 1 件も無い
--            profile 行が候補にすら入らなかった。2 つ目の穴）
--
--    ─ 判定の言い方 ─
--      pending = L1 が無い
--             OR L1.last_event_seq < その人の最新の出来事
--             OR L1.shape_fingerprint が今の形と違う（NULL を含む）
--
--    ─ 返り値に still_pending_shape を足した理由 ─
--      「まだ畳めていない」の内訳が「出来事が増えた」なのか「形が変わった」なのかで
--      次の一手が違う。前者は放っておけば次の tick で追いつくが、後者は
--      **移行が終わっていない**という意味になる。1 つの数に畳むと区別できない。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_l1_recompute_all(p_limit integer DEFAULT 500)
RETURNS jsonb AS $$
DECLARE
  v_limit       integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_done        integer := 0;
  v_pending     bigint  := 0;
  v_pend_shape  bigint  := 0;
  v_shape       text    := cdp_l1_shape_fingerprint();
  v_derived     jsonb;
  r             record;
BEGIN
  v_derived := cdp_l1_derive_delivery_identity(v_limit);

  FOR r IN
    WITH ev AS (
      SELECT c.subject_id, max(c.event_seq) AS max_seq
        FROM customer_events c
        JOIN subjects s ON s.subject_id = c.subject_id AND s.retired_at IS NULL
       GROUP BY c.subject_id
    ),
    -- 出来事のある人 + すでに L1 の行がある人。後者を足さないと、
    -- 出来事が 1 件も無い profile 行が永久に畳み直されない。
    --
    -- ⚠ 素の UNION にしないこと。両方に居る人（出来事も L1 もある人）が
    --   (id, max_seq) と (id, NULL) の **2 行**になり、同じ人を 2 回畳み直し、
    --   still_pending も二重に数えてしまう。GROUP BY で 1 人 1 行に畳む
    --   （max は NULL を無視するので、出来事のある人は max_seq が残る）。
    candidates AS (
      SELECT u.subject_id, max(u.max_seq) AS max_seq
        FROM (
          SELECT e.subject_id, e.max_seq FROM ev e
          UNION ALL
          SELECT p.subject_id, NULL::bigint
            FROM subject_profile p
            JOIN subjects s ON s.subject_id = p.subject_id AND s.retired_at IS NULL
        ) u
       GROUP BY u.subject_id
    )
    SELECT c.subject_id, c.max_seq
      FROM candidates c
      LEFT JOIN subject_profile p
        ON p.subject_id = cdp_canonical_subject(c.subject_id)
     WHERE p.subject_id IS NULL                                   -- L1 が無い
        OR (c.max_seq IS NOT NULL AND p.last_event_seq < c.max_seq) -- 出来事が増えた
        OR p.shape_fingerprint IS DISTINCT FROM v_shape             -- 形が変わった
     ORDER BY coalesce(c.max_seq, 0)
     LIMIT v_limit
  LOOP
    PERFORM cdp_l1_recompute_subject(r.subject_id);
    v_done := v_done + 1;
  END LOOP;

  -- 残りを数え直す（同じ判定を使う。ここを別の式にすると 2 か所管理になる）。
  WITH ev AS (
    SELECT c.subject_id, max(c.event_seq) AS max_seq
      FROM customer_events c
      JOIN subjects s ON s.subject_id = c.subject_id AND s.retired_at IS NULL
     GROUP BY c.subject_id
  ),
  -- 上の候補と **同じ組み立て方**にする（片方だけ素の UNION にすると、
  -- 両方に居る人が 2 行になって still_pending が二重に膨らむ）。
  candidates AS (
    SELECT u.subject_id, max(u.max_seq) AS max_seq
      FROM (
        SELECT e.subject_id, e.max_seq FROM ev e
        UNION ALL
        SELECT p.subject_id, NULL::bigint
          FROM subject_profile p
          JOIN subjects s ON s.subject_id = p.subject_id AND s.retired_at IS NULL
      ) u
     GROUP BY u.subject_id
  ),
  still AS (
    SELECT c.subject_id,
           (p.subject_id IS NOT NULL
            AND p.shape_fingerprint IS DISTINCT FROM v_shape) AS by_shape
      FROM candidates c
      LEFT JOIN subject_profile p
        ON p.subject_id = cdp_canonical_subject(c.subject_id)
     WHERE p.subject_id IS NULL
        OR (c.max_seq IS NOT NULL AND p.last_event_seq < c.max_seq)
        OR p.shape_fingerprint IS DISTINCT FROM v_shape
  )
  SELECT count(*), count(*) FILTER (WHERE by_shape)
    INTO v_pending, v_pend_shape
    FROM still;

  RETURN jsonb_build_object(
    'recomputed',          v_done,
    'still_pending',       v_pending,
    -- 内訳: このうち「形が古いせいで残っている」件数（移行が終わっていない印）。
    'still_pending_shape', v_pend_shape,
    'shape_fingerprint',   v_shape,
    'delivery_identity',   v_derived
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cdp_l1_recompute_all(integer) IS
  '畳み直しが要る人をまとめて畳み直す。判定は「L1 が無い / 出来事が増えた / **形が変わった**」の 3 つ。'
  ' 3 つ目が 052 で足した条件で、051 の「列を足したのに 1 件も畳み直されない」を根治する。'
  ' 候補は customer_events 側と subject_profile 側の和集合（出来事ゼロの行を取りこぼさない）。';

-- ===================================================================
-- 4. 一回性の是正 — 既存の全 profile をいま畳み直す
--
--    ─ なぜ migration の中でやるのか ─
--      051 で取り残された行（本番実測 6 件）は、運用者が別途コマンドを打つまで
--      DEFAULT '{}' のまま残る。**「当てたのに直っていない」状態を残さない**ため、
--      是正まで含めて 1 つの migration にする。
--
--    ─ 冪等性 ─
--      畳み直しは L0 からの再計算なので、何度走らせても同じ結果に収束する。
--      2 回目以降は shape_fingerprint が一致するため recompute_all 側では
--      pending にならないが、ここは**無条件に全件**回す（当て直したときに
--      確実に是正されることを優先する）。
--
--    ─ 走査中に対象が動くことへの備え ─
--      cdp_l1_recompute_subject は代表でない行を DELETE することがある。
--      カーソルで subject_profile を舐めながら同じ表を更新すると足元が崩れるので、
--      **先に id を配列へ確定させてから**回す。
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
    -- 直前の畳み直しで代表でなくなり消えた行は飛ばす（例外にしない）。
    IF NOT EXISTS (SELECT 1 FROM subject_profile WHERE subject_id = v_id) THEN
      v_gone := v_gone + 1;
      CONTINUE;
    END IF;
    PERFORM cdp_l1_recompute_subject(v_id);
    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE '052: 既存 profile の強制畳み直し 完了 — 対象 % 件 / 畳み直し % 件 / 途中で代表でなくなった % 件',
    array_length(v_ids, 1), v_done, v_gone;
END;
$$;

-- ===================================================================
-- 5. 当てた結果の自己検査（失敗したら migration を失敗させる）
--
--    「当てたのに直っていない」を、運用者が parity を叩くまで気づけない状態に
--    しない。051 の障害はまさにそれ（適用は成功・中身は未是正）だったので、
--    ここで migration 自身に確かめさせる。
-- ===================================================================
DO $$
DECLARE
  v_stale bigint;
  v_shape text := cdp_l1_shape_fingerprint();
BEGIN
  SELECT count(*) INTO v_stale
    FROM subject_profile p
    JOIN subjects s ON s.subject_id = p.subject_id AND s.retired_at IS NULL
   WHERE p.shape_fingerprint IS DISTINCT FROM v_shape;

  IF v_stale > 0 THEN
    RAISE EXCEPTION '052: 畳み直しの取り残しが % 件ある（形の版が古いまま）。適用を失敗として扱う。', v_stale;
  END IF;

  RAISE NOTICE '052: 自己検査 OK — 形の版が古い profile は 0 件';
END;
$$;
