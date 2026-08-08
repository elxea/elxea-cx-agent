-- 037: 消す対象のベタ書きをやめ、**列挙**に統一する
--
-- 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義
--   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c  図2
--
-- ─ なぜ直すか（036 の積み残し・独立レビュー指摘 F2）─
--   036 は消す対象のテーブル名を**配列にベタ書き**していた（消す側・検算側の 2 か所）。
--   Firestore 側では「サブコレクション名のベタ書き」がまさに broadcastHistory の
--   消し漏れを生んだ原因で、それを列挙方式に直したのに、**Supabase 側にだけ
--   同じ原因が残っていた**。新しい表を足しても追随しないため、いずれ必ず同じ事故が起きる。
--
-- ─ どう直すか ─
--   「人を指す列の名前」を語彙として持ち、その列を持つ表を information_schema から
--   **毎回列挙する**。新しい表がその列名を使えば、登録作業なしで自動的に対象になる。
--   つまり既定は「消す」側に倒れる（＝約束を守る側が既定）。
--
-- ─ 消してはならない表だけを明示する（既定と例外の非対称）─
--   既定を「消す」にした以上、**消してはならないもの**を明示する必要がある。
--   図2 で「残る」と決めたものだけを除外する。ここに表を足すことは
--   「本人の記録を残す」という意味なので、差分レビューで必ず目に入る。
--
-- ─ 語彙に無い「人っぽい列」は検知する ─
--   語彙は列名の完全一致。新しい**列名**が発明されると語彙から漏れる。
--   これは SQL では防げないので、テスト側（roji-erasure.db.test.ts）が
--   「人っぽい列名なのに語彙にも既存の対象表にも入っていない」ものを検出して落とす。
--
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION のみ。何度適用しても同じ。
-- ─ 破壊性 ─ 関数の定義を差し替えるだけ。テーブル・データに一切触れない。

-- ===================================================================
-- 1. 人を指す列を持つ表を列挙する（消す側・検算側の唯一の対象表リスト）
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
      'session_id'
    )
    -- 図2 で「残る」と決めたもの。**ここに足すことは「本人の記録を残す」という意味**。
    AND c.table_name NOT IN (
      'roji_edit_records',        -- 編むのにかかった手間（本人向け文面 2）
      'roji_words',               -- 匿名の言葉（本人向け文面 3）。person_seq の CASCADE でのみ消える
      'roji_word_person_refs',    -- 同上（CASCADE で消える。列名一致で消すと二重管理になる）
      'roji_delivery_months',     -- 月の締め（集計）
      'conversation_daily_stats', -- 日次集計
      'broadcast_stats',          -- 配信の集計値
      'line_message_ledger'       -- 配信の集計値
    );
$$ LANGUAGE sql STABLE;

-- ===================================================================
-- 2. 消す（036 の配列ベタ書きを列挙に差し替え）
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
  v_actors    text[];
  v_words     integer := 0;
  v_person_del integer := 0;
  v_ledger    integer := 0;
  v_counts    jsonb   := '{}'::jsonb;
  v_n         integer;
  r           record;
  v_vals      text[];
BEGIN
  v_id := roji_resolve_identity(p_subject_kind, p_subject_id);

  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_shopify FROM jsonb_array_elements_text(v_id->'shopify_ids') x;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_line    FROM jsonb_array_elements_text(v_id->'line_ids') x;
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_web     FROM jsonb_array_elements_text(v_id->'web_refs') x;
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

  -- 返り値は件数と、解決した ID のみ。「削除済み 1 件」を記録する行は作らない。
  RETURN jsonb_build_object(
    'words_deleted',       v_words,
    'ledger_rows_deleted', v_ledger,
    'person_deleted',      v_person_del,
    'identity',            v_id,
    'deleted',             v_counts
  );
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 3. 検算（読み取り専用）— 同じ列挙を使う
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
  v_remaining jsonb := '{}'::jsonb;
  v_preserved jsonb;
  r         record;
  v_vals    text[];
  v_n       bigint;
BEGIN
  v_actors := v_line || v_web;

  FOR r IN SELECT * FROM roji_person_key_map() LOOP
    v_vals := CASE r.key_kind
                WHEN 'shopify' THEN v_shopify
                WHEN 'line'    THEN v_line
                WHEN 'web'     THEN v_web
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
