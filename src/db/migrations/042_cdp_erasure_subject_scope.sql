-- ===================================================================
-- 042: 新しい置き場（subjects / identity_edges / customer_events）を
--      消去の列挙に **自動で** 乗せる（CDP 統合 Stage 1 / GDPR ゲート）
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）§3-3-4 / §6-1「GDPR ゲート」
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
-- 併読: rojiカルテの項目 — 最終形の定義  https://www.notion.so/3b570c9d064c81669025cdbe1064b12c 図2
--
-- ─ なぜ要るか ─
--
-- 037 は「人を指す **列の名前** を語彙として持ち、その列を持つ表を毎回列挙する」
-- という形にした。既定が「消す」側に倒れるので、新しい表を足しても登録作業なしで
-- 対象になる — ただし **その列名を使っていれば** の話である。
--
-- 040 / 041 が足した置き場は、人を `subject_id`（発行制の ULID）で指す。これは
-- 037 の語彙（shopify_customer_id / line_user_id / line_login_user_id /
-- web_session_id / user_id / user_ref / session_id）に無い。つまりこのままだと
-- **新しい置き場だけが消去から漏れる**。段の完了条件に「erasePerson residue が
-- clean」を置いている以上、置き場を足した段で必ず同時に手当てする。
--
-- ─ 何をするか ─
--
--   1. roji_resolve_identity … 解決の輪に subject_ids を足す。
--      借りた鍵（LINE / Shopify / Web）↔ subject を identity_edges で両方向に辿る。
--      ⚠ email_hash の枝は作らない（SEC-1: 同一 email を根拠に人を結ばない）。
--   2. roji_person_key_map  … 語彙に 'subject_id' を足し、key_kind 'subject' を返す。
--      除外に 'subjects' を足す（主体そのものは行を消さず retired_at を立てるため）。
--   3. roji_erase_person    … app.erasure_context を立て（E4 の唯一の例外表）、
--      subject 系の表を列挙で消し、最後に subjects.retired_at を立てる。
--   4. roji_erasure_residue … 同じ列挙で検算し、さらに **消し残しの孤児** を数える。
--
-- ─ 関数の入口（シグネチャ）は変えない ─
--
-- roji-erasure.ts は roji_erase_person(p_subject_kind, p_subject_id) と
-- roji_erasure_residue(p_shopify_ids, p_line_ids, p_web_refs) を RPC で呼ぶ。
-- 引数を増やすと「migration を当てた瞬間から Worker を出すまで」の間、消去が
-- まるごと落ちる窓ができる。よって **引数は 1 つも変えない**。subject の解決は
-- 関数の中で identity_edges から行う。
--
-- ─ 検算が「消えたのに 0 と言う」ことにならないか ─
--
-- 消去が終わると identity_edges は 0 本になるので、検算のときに借りた鍵から
-- subject へ辿る道も消えている。これだけだと「events が残っていても辿れないので
-- 0 と数える」という最悪の形になりうる。2 つで塞ぐ:
--   (a) roji_erase_person は 1 つのトランザクションなので、途中で落ちれば全部戻る
--       （「edges だけ消えて events が残る」中間状態は永続しない）。
--   (b) それでも残った場合に気づけるよう、**辿らずに数える**孤児検査を residue に
--       足す: 「retired_at が立っていて edges が 0 本なのに、subject 系の表に行が
--       ある subject」の行数。これは誰の消去かに依存しない全体不変条件なので、
--       取りこぼしがあれば必ず 0 より大きくなる。
--
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION のみ。何度当てても同じ。
-- ─ 破壊性 ─ 関数定義の差し替えのみ。表・データに一切触れない。
--
-- ─ 適用手順 ─
--
--   MIGRATE_ONLY=042 bash scripts/deploy-prod.sh
--
-- ⚠ 040 / 041 が先に当たっていること（identity_edges / customer_events を参照する）。
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認（順序を間違えると消去がまるごと落ちる）
--
--    この migration が差し替える roji_resolve_identity は identity_edges を引く。
--    040 より先に当たると「存在しない表を参照する関数」ができ、その状態で消去
--    依頼が来ると **消去が全部失敗する**。黙って進めず、ここで止める。
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.identity_edges') IS NULL THEN
    RAISE EXCEPTION
      '042: identity_edges がまだ無い。040 を先に当てること'
      '（この関数は identity_edges を引くので、順序を逆にすると消去が全部落ちる）。';
  END IF;
  IF to_regclass('public.customer_events') IS NULL THEN
    RAISE EXCEPTION '042: customer_events がまだ無い。041 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. 解決の輪に subject を足す（039 版に subject の枝を追加したもの）
-- ===================================================================
CREATE OR REPLACE FUNCTION roji_resolve_identity(
  p_subject_kind text,
  p_subject_id   text
) RETURNS jsonb AS $$
DECLARE
  v_shopify  text[]   := ARRAY[]::text[];
  v_line     text[]   := ARRAY[]::text[];
  v_web      text[]   := ARRAY[]::text[];
  v_persons  bigint[] := ARRAY[]::bigint[];
  v_subjects text[]   := ARRAY[]::text[];
  v_size     integer  := -1;
  v_prev     integer  := -2;
BEGIN
  IF p_subject_kind NOT IN ('shopify', 'line') THEN
    RAISE EXCEPTION 'roji_resolve_identity: subject_kind は shopify / line のいずれか（受領: %）', p_subject_kind;
  END IF;
  IF p_subject_id IS NULL OR p_subject_id = '' THEN
    RAISE EXCEPTION 'roji_resolve_identity: subject_id が空';
  END IF;

  IF p_subject_kind = 'shopify' THEN
    v_shopify := ARRAY[p_subject_id];
  ELSE
    v_line := ARRAY[p_subject_id];
  END IF;

  LOOP
    v_prev := v_size;

    -- 別名表（customer_linkages 正 / user_identity_map 従属）と言葉の置き場の ref、
    -- そして identity_edges を、両方向に 1 段引く。
    -- ⚠ customer_profiles の枝は 039 で削除（表ごと廃止）。
    -- ⚠ identity_edges の email_hash は **決して引かない**（SEC-1）。
    SELECT coalesce(array_agg(DISTINCT s), ARRAY[]::text[]) INTO v_shopify FROM (
      SELECT unnest(v_shopify) AS s
      UNION
      SELECT shopify_customer_id FROM customer_linkages
        WHERE shopify_customer_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR shopify_customer_id = ANY (v_shopify))
      UNION
      SELECT shopify_customer_id FROM user_identity_map
        WHERE shopify_customer_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR line_login_user_id = ANY (v_line)
               OR shopify_customer_id = ANY (v_shopify) OR web_session_id = ANY (v_web))
      UNION
      SELECT subject_id FROM roji_word_person_refs
        WHERE subject_kind = 'shopify' AND person_seq = ANY (v_persons)
      UNION
      SELECT identifier_value FROM identity_edges
        WHERE identifier_kind = 'shopify_customer_id' AND subject_id = ANY (v_subjects)
    ) q WHERE s IS NOT NULL AND s <> '';

    SELECT coalesce(array_agg(DISTINCT l), ARRAY[]::text[]) INTO v_line FROM (
      SELECT unnest(v_line) AS l
      UNION
      SELECT line_user_id FROM customer_linkages
        WHERE line_user_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR shopify_customer_id = ANY (v_shopify))
      UNION
      SELECT line_user_id FROM user_identity_map
        WHERE line_user_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR line_login_user_id = ANY (v_line)
               OR shopify_customer_id = ANY (v_shopify) OR web_session_id = ANY (v_web))
      UNION
      SELECT line_login_user_id FROM user_identity_map
        WHERE line_login_user_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR line_login_user_id = ANY (v_line)
               OR shopify_customer_id = ANY (v_shopify) OR web_session_id = ANY (v_web))
      UNION
      SELECT subject_id FROM roji_word_person_refs
        WHERE subject_kind = 'line' AND person_seq = ANY (v_persons)
      UNION
      SELECT identifier_value FROM identity_edges
        WHERE identifier_kind IN ('line_messaging_uid', 'line_login_uid')
          AND subject_id = ANY (v_subjects)
    ) q WHERE l IS NOT NULL AND l <> '';

    -- Web の一時 ID は別名表か identity_edges に載っているものだけ。
    SELECT coalesce(array_agg(DISTINCT w), ARRAY[]::text[]) INTO v_web FROM (
      SELECT unnest(v_web) AS w
      UNION
      SELECT web_session_id FROM user_identity_map
        WHERE web_session_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR line_login_user_id = ANY (v_line)
               OR shopify_customer_id = ANY (v_shopify) OR web_session_id = ANY (v_web))
      UNION
      SELECT identifier_value FROM identity_edges
        WHERE identifier_kind IN ('web_session_id', 'web_anonymous_id')
          AND subject_id = ANY (v_subjects)
    ) q WHERE w IS NOT NULL AND w <> '';

    SELECT coalesce(array_agg(DISTINCT ps), ARRAY[]::bigint[]) INTO v_persons FROM (
      SELECT unnest(v_persons) AS ps
      UNION
      SELECT person_seq FROM roji_word_person_refs
        WHERE (subject_kind = 'shopify' AND subject_id = ANY (v_shopify))
           OR (subject_kind = 'line'    AND subject_id = ANY (v_line))
    ) q WHERE ps IS NOT NULL;

    -- 借りた鍵から主体へ。email_hash は入っていない（SEC-1）。
    SELECT coalesce(array_agg(DISTINCT sj), ARRAY[]::text[]) INTO v_subjects FROM (
      SELECT unnest(v_subjects) AS sj
      UNION
      SELECT e.subject_id FROM identity_edges e
        WHERE (e.identifier_kind = 'shopify_customer_id' AND e.identifier_value = ANY (v_shopify))
           OR (e.identifier_kind IN ('line_messaging_uid', 'line_login_uid')
               AND e.identifier_value = ANY (v_line))
           OR (e.identifier_kind IN ('web_session_id', 'web_anonymous_id')
               AND e.identifier_value = ANY (v_web))
    ) q WHERE sj IS NOT NULL AND sj <> '';

    v_size := coalesce(array_length(v_shopify, 1), 0)
            + coalesce(array_length(v_line, 1), 0)
            + coalesce(array_length(v_web, 1), 0)
            + coalesce(array_length(v_persons, 1), 0)
            + coalesce(array_length(v_subjects, 1), 0);

    EXIT WHEN v_size = v_prev;
  END LOOP;

  RETURN jsonb_build_object(
    'shopify_ids', to_jsonb(v_shopify),
    'line_ids',    to_jsonb(v_line),
    'web_refs',    to_jsonb(v_web),
    'person_seqs', to_jsonb(v_persons),
    'subject_ids', to_jsonb(v_subjects)
  );
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 2. 語彙に subject_id を足す
--
--    ⚠ 'subject_id' という列名は roji_word_person_refs も持っているが、
--      あちらの中身は shopify / line の **借りた鍵** であって CDP の主体 ID ではない。
--      同表は 032 以来この列挙の除外に入っているので衝突しないが、
--      名前が同じものが 2 つある事実は残るのでここに明記しておく。
-- ===================================================================
CREATE OR REPLACE FUNCTION roji_person_key_map()
RETURNS TABLE(tbl text, col text, key_kind text) AS $$
  SELECT
    c.table_name::text,
    c.column_name::text,
    CASE c.column_name
      WHEN 'shopify_customer_id' THEN 'shopify'
      WHEN 'line_user_id'        THEN 'line'
      WHEN 'line_login_user_id'  THEN 'line'
      WHEN 'web_session_id'      THEN 'web'
      WHEN 'subject_id'          THEN 'subject'
      ELSE 'actor'   -- user_id / user_ref / session_id は LINE と Web の両方が入りうる
    END
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name   = c.table_name
   AND t.table_type   = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    -- 人を指す列の語彙（完全一致）。新しい列名を使うときはここに足す。
    AND c.column_name IN (
      'shopify_customer_id',
      'line_user_id',
      'line_login_user_id',
      'web_session_id',
      'user_id',
      'user_ref',
      'session_id',
      'subject_id'
    )
    -- 図2 で「残る」と決めたもの。**ここに足すことは「本人の記録を残す」という意味**。
    AND c.table_name NOT IN (
      'roji_edit_records',        -- 編むのにかかった手間（本人向け文面 2）
      'roji_words',               -- 匿名の言葉（本人向け文面 3）。person_seq の CASCADE でのみ消える
      'roji_word_person_refs',    -- 同上（CASCADE で消える。列名一致で消すと二重管理になる）
      'roji_delivery_months',     -- 月の締め（集計）
      'conversation_daily_stats', -- 日次集計
      'broadcast_stats',          -- 配信の集計値
      'line_message_ledger',      -- 配信の集計値
      -- 主体そのもの。行は消さず retired_at を立てる（040 の設計）。
      -- 消したあとに残るのは、どの識別子とも結びつかない 26 文字だけで、
      -- customer_events / identity_edges からの外部キーを壊さずに済む。
      'subjects'
    );
$$ LANGUAGE sql STABLE;

-- ===================================================================
-- 3. 消す — subject 系を列挙に載せ、最後に主体を retire する
-- ===================================================================
CREATE OR REPLACE FUNCTION roji_erase_person(
  p_subject_kind text,
  p_subject_id   text
) RETURNS jsonb AS $$
DECLARE
  v_id        jsonb;
  v_shopify   text[];
  v_line      text[];
  v_web       text[];
  v_persons   bigint[];
  v_subjects  text[];
  v_actors    text[];
  v_words     integer := 0;
  v_person_del integer := 0;
  v_ledger    integer := 0;
  v_retired   integer := 0;
  v_counts    jsonb   := '{}'::jsonb;
  v_n         integer;
  r           record;
  v_vals      text[];
BEGIN
  -- E4 の唯一の例外表を立てる。set_config(..., is_local => true) は SET LOCAL と
  -- 同じで、このトランザクションを抜ければ自動的に外れる（立てっぱなしにできない）。
  PERFORM set_config('app.erasure_context', 'on', true);

  v_id := roji_resolve_identity(p_subject_kind, p_subject_id);

  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_shopify  FROM jsonb_array_elements_text(v_id->'shopify_ids') x;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_line     FROM jsonb_array_elements_text(v_id->'line_ids') x;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_web      FROM jsonb_array_elements_text(v_id->'web_refs') x;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_subjects FROM jsonb_array_elements_text(v_id->'subject_ids') x;
  SELECT coalesce(array_agg(x::bigint), ARRAY[]::bigint[]) INTO v_persons FROM jsonb_array_elements_text(v_id->'person_seqs') x;

  v_actors := v_line || v_web;

  -- ── 言葉の置き場 ─────────────────────────────────────────────
  -- 匿名（person_seq IS NULL）は person_seq で引かないので構造的に触れない。
  IF array_length(v_persons, 1) IS NOT NULL THEN
    SELECT count(*) INTO v_words FROM roji_words WHERE person_seq = ANY (v_persons);
    DELETE FROM roji_word_persons WHERE person_seq = ANY (v_persons);
    GET DIAGNOSTICS v_person_del = ROW_COUNT;
    -- roji_word_person_refs / roji_words は ON DELETE CASCADE で消える（032）。
  END IF;

  -- ── 人を指す列を持つ表を、列挙して消す ────────────────────────
  --   1 つの表が複数の鍵の列を持つことがある（例: customer_linkages は
  --   line_user_id と shopify_customer_id の両方）。列ごとに 1 回ずつ消せば
  --   OR で消したのと同じ結果になる。件数は表ごとに合算する。
  FOR r IN SELECT * FROM roji_person_key_map() LOOP
    v_vals := CASE r.key_kind
                WHEN 'shopify' THEN v_shopify
                WHEN 'line'    THEN v_line
                WHEN 'web'     THEN v_web
                WHEN 'subject' THEN v_subjects
                ELSE                v_actors
              END;
    CONTINUE WHEN array_length(v_vals, 1) IS NULL;

    EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', r.tbl, r.col) USING v_vals;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    v_counts := v_counts || jsonb_build_object(
      r.tbl, coalesce((v_counts->>r.tbl)::int, 0) + v_n);

    -- 台帳の件数は 034 からの互換のため別枠でも数える。
    IF r.tbl = 'roji_delivery_ledger' THEN
      v_ledger := v_ledger + v_n;
    END IF;
  END LOOP;

  -- ── 主体を retire する（行は残す・本人には辿れない 26 文字だけになる）──
  IF array_length(v_subjects, 1) IS NOT NULL THEN
    UPDATE subjects SET retired_at = now()
      WHERE subject_id = ANY (v_subjects) AND retired_at IS NULL;
    GET DIAGNOSTICS v_retired = ROW_COUNT;
  END IF;

  -- 返り値は件数と、解決した ID のみ。「削除済み 1 件」を記録する行は作らない。
  RETURN jsonb_build_object(
    'words_deleted',       v_words,
    'ledger_rows_deleted', v_ledger,
    'person_deleted',      v_person_del,
    'subjects_retired',    v_retired,
    'identity',            v_id,
    'deleted',             v_counts
  );
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 4. 検算（読み取り専用）— 同じ列挙 + 辿らずに数える孤児検査
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

  -- 借りた鍵から辿れる主体（消去が完了していればここは空になる）。
  SELECT coalesce(array_agg(DISTINCT e.subject_id), ARRAY[]::text[]) INTO v_subjects
    FROM identity_edges e
   WHERE (e.identifier_kind = 'shopify_customer_id' AND e.identifier_value = ANY (v_shopify))
      OR (e.identifier_kind IN ('line_messaging_uid', 'line_login_uid')
          AND e.identifier_value = ANY (v_line))
      OR (e.identifier_kind IN ('web_session_id', 'web_anonymous_id')
          AND e.identifier_value = ANY (v_web));

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

  -- 言葉の置き場は person_seq 経由でしか本人に結びつかないので、別に数える。
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

  -- ── 辿らずに数える孤児検査（消去の取りこぼしを、誰の消去かに依存せず捕まえる）──
  --   retire 済み（= 消去が通った）主体なのに subject 系の表に行が残っている数。
  --   消去が正しく効いていれば常に 0。edges が消えて辿れなくなっても、この数は残る。
  SELECT
    coalesce((SELECT count(*) FROM customer_events ce
                JOIN subjects s ON s.subject_id = ce.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM identity_edges ie
                JOIN subjects s ON s.subject_id = ie.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
    INTO v_orphans;

  v_remaining := v_remaining || jsonb_build_object('cdp_retired_subject_orphans', v_orphans);

  -- 図2 で「残る」と決めたもの。0 になっていたら消しすぎ。
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
