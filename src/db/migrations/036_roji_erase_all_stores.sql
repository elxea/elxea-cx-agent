-- 036: 「消せます」を全経路で本当に通す — Supabase 側の全置き場を 1 本の関数で消す
--
-- 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義
--   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c  図2「本人が記録を消したとき何が消えて何が残るか」
-- 併読: roji同じ人だと分かる仕組み（置き場の地図）
--   https://www.notion.so/3b570c9d064c81d68610f9360f50c965  第6章「後でよい」順7
--
-- ─ 何が起きていたか（実測で確認・2026-08-08）─
--   034 の roji_erase_person は **roji_* の 3 表しか消していなかった**
--   （roji_word_persons / CASCADE で roji_words・roji_word_person_refs / roji_delivery_ledger）。
--   本番 Supabase には他に **会話の生の文章・感想の自由記述・操作ログ・評価・アンケート**が
--   人の ID を鍵にして残る。無期限保持に切り替えた（031）結果、これらが消える経路は
--   「本人からの削除依頼」だけになったのに、その 1 本が繋がっていない。
--   = お客さんに「消せます」と言った瞬間に嘘になる状態だった。
--
-- ─ この migration が足すもの（3 つ・すべて関数のみ）─
--   1. roji_resolve_identity(kind, id)
--        本人が持つ**すべての恒久 ID** を別名表から不動点まで辿って集める。
--        034 が roji_* の中だけでやっていた「消す前に ref を集める」を、系全体に広げたもの。
--   2. roji_erase_person(kind, id)                    ← 034 を CREATE OR REPLACE で差し替え
--        集めた ID すべてについて、人に紐づく全表から行を消す。返り値は件数のみ。
--   3. roji_erasure_residue(shopify_ids, line_ids, web_refs)
--        **読み取り専用**。消したあとに何が残っているかを表ごとに数えて返す。
--        「消しました」と言うだけにしないための検算口（タスク要件3）。
--
-- ─ 図2 のとおり「消さない」もの（ここに DELETE を足してはならない）─
--   roji_edit_records    … 編むのにかかった手間。個人へ辿れる列を構造上 1 つも持たない（本人向け文面 2）
--   roji_words (person_seq IS NULL) … イベントの場に置いた匿名の言葉（本人向け文面 3）
--   roji_delivery_months … 月の締め（集計・個人の記録ではない）
--   conversation_daily_stats / broadcast_stats / line_message_ledger … 集計値のみ
--   knowledge_chunks / probe_history / regression_tests / sync_logs / processed_events / schema_migrations
--                        … 顧客の記録ではない
--   ※「やめた月のこと」（本人向け文面 1・項目65）の置き場は**まだ作られていない**（第6章 第2段階 順8）。
--     作られたときに本表の「消さない」側へ追記すること。今は存在しないので消しようも残しようも無い。
--
-- ─ 痕跡を残さない（確定原則）─
--   「削除済み1件」というログ行を**作らない**。返り値は件数の jsonb のみで、
--   どの表にも「消した」という行を書かない。監査ログ表を足してはならない。
--
-- ─ 匿名の言葉と手元の控えを結ぶ鍵を作らない（確定原則）─
--   本 migration は roji_words の person_seq IS NULL 行に**一切触れない**（読みも書きもしない）。
--   消す前に控えの本文を読んで場の言葉と突き合わせる、といった処理を入れてはならない。
--
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION のみ。何度適用しても同じ。
-- ─ 破壊性 ─ **関数の定義を足す / 差し替えるだけ。テーブル・データに一切触れない。**
--            034 以前の SQL ファイルは書き換えない（適用済み実体との対応を壊さないため）。

-- ===================================================================
-- 1. 本人が持つすべての恒久 ID を集める（不動点まで広げる）
--
--    なぜ不動点か: 別名表は N 対 1（世帯共有＝複数の LINE から 1 人の EC 顧客）を許可済み。
--    片方向に 1 回引くだけでは、同じ人の別の ID がぶら下がったまま残る。
--    「どの ID から消しても結果が同じ」を成立させるため、増えなくなるまで広げる。
-- ===================================================================
CREATE OR REPLACE FUNCTION roji_resolve_identity(
  p_subject_kind text,
  p_subject_id   text
) RETURNS jsonb AS $$
DECLARE
  v_shopify text[]   := ARRAY[]::text[];
  v_line    text[]   := ARRAY[]::text[];
  v_web     text[]   := ARRAY[]::text[];
  v_persons bigint[] := ARRAY[]::bigint[];
  v_size    integer  := -1;
  v_prev    integer  := -2;
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

    -- 別名表（customer_linkages 正 / user_identity_map 重複）と
    -- 言葉の置き場の ref を、両方向に 1 段引く。
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
      SELECT shopify_customer_id FROM customer_profiles
        WHERE shopify_customer_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR shopify_customer_id = ANY (v_shopify))
      UNION
      SELECT subject_id FROM roji_word_person_refs
        WHERE subject_kind = 'shopify' AND person_seq = ANY (v_persons)
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
      SELECT line_user_id FROM customer_profiles
        WHERE line_user_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR shopify_customer_id = ANY (v_shopify))
      UNION
      SELECT subject_id FROM roji_word_person_refs
        WHERE subject_kind = 'line' AND person_seq = ANY (v_persons)
    ) q WHERE l IS NOT NULL AND l <> '';

    -- Web の一時 ID は別名表に載っているものだけ（象限D の匿名 Web は本人に辿れないので対象外）。
    SELECT coalesce(array_agg(DISTINCT w), ARRAY[]::text[]) INTO v_web FROM (
      SELECT unnest(v_web) AS w
      UNION
      SELECT web_session_id FROM user_identity_map
        WHERE web_session_id IS NOT NULL
          AND (line_user_id = ANY (v_line) OR line_login_user_id = ANY (v_line)
               OR shopify_customer_id = ANY (v_shopify) OR web_session_id = ANY (v_web))
    ) q WHERE w IS NOT NULL AND w <> '';

    SELECT coalesce(array_agg(DISTINCT ps), ARRAY[]::bigint[]) INTO v_persons FROM (
      SELECT unnest(v_persons) AS ps
      UNION
      SELECT person_seq FROM roji_word_person_refs
        WHERE (subject_kind = 'shopify' AND subject_id = ANY (v_shopify))
           OR (subject_kind = 'line'    AND subject_id = ANY (v_line))
    ) q WHERE ps IS NOT NULL;

    v_size := coalesce(array_length(v_shopify, 1), 0)
            + coalesce(array_length(v_line, 1), 0)
            + coalesce(array_length(v_web, 1), 0)
            + coalesce(array_length(v_persons, 1), 0);

    EXIT WHEN v_size = v_prev;
  END LOOP;

  RETURN jsonb_build_object(
    'shopify_ids', to_jsonb(v_shopify),
    'line_ids',    to_jsonb(v_line),
    'web_refs',    to_jsonb(v_web),
    'person_seqs', to_jsonb(v_persons)
  );
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 2. 人に紐づく行を全表から消す
--
--    順序の要点: **別名表を消すのは最後**。先に消すと、まだ辿っていない ID が
--    辿れなくなる（034 が roji_* の中で踏んだ穴と同じ様式）。
--    そのため identity は冒頭で 1 度だけ解決し、以後はその配列だけを使う。
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
  v_actors    text[];   -- 会話・操作ログ等の「行為者」列に入りうる ID（LINE と Web の一時 ID）
  v_words     integer := 0;
  v_person_del integer := 0;
  v_ledger    integer := 0;
  v_counts    jsonb   := '{}'::jsonb;
  v_n         integer;
BEGIN
  v_id := roji_resolve_identity(p_subject_kind, p_subject_id);

  SELECT coalesce(array_agg(x), ARRAY[]::text[])   INTO v_shopify FROM jsonb_array_elements_text(v_id->'shopify_ids') x;
  SELECT coalesce(array_agg(x), ARRAY[]::text[])   INTO v_line    FROM jsonb_array_elements_text(v_id->'line_ids') x;
  SELECT coalesce(array_agg(x), ARRAY[]::text[])   INTO v_web     FROM jsonb_array_elements_text(v_id->'web_refs') x;
  SELECT coalesce(array_agg(x::bigint), ARRAY[]::bigint[]) INTO v_persons FROM jsonb_array_elements_text(v_id->'person_seqs') x;

  v_actors := v_line || v_web;

  -- ── 言葉の置き場（034 から継承）─────────────────────────────
  -- 匿名（person_seq IS NULL）は person_seq で引かないので構造的に触れない。
  IF array_length(v_persons, 1) IS NOT NULL THEN
    SELECT count(*) INTO v_words FROM roji_words WHERE person_seq = ANY (v_persons);
    DELETE FROM roji_word_persons WHERE person_seq = ANY (v_persons);
    GET DIAGNOSTICS v_person_del = ROW_COUNT;
    -- roji_word_person_refs / roji_words は ON DELETE CASCADE で消える（032）。
  END IF;

  -- ── 送った記録の台帳（034 から継承）─────────────────────────
  -- roji_edit_records は ON DELETE SET NULL で残る（＝「編むのにかかった手間」は骨として残る）。
  IF array_length(v_shopify, 1) IS NOT NULL THEN
    DELETE FROM roji_delivery_ledger WHERE shopify_customer_id = ANY (v_shopify);
    GET DIAGNOSTICS v_ledger = ROW_COUNT;
  END IF;

  -- ── 出来事の置き場・会話・言葉（036 で新たに繋いだ分）───────────
  --
  --   なぜ EXECUTE と to_regclass で包むのか（重要）:
  --   **本番と staging でテーブルの顔ぶれが違う**（実測 2026-08-08: 本番に
  --   dormant_reengagement_log / broadcast_stats が無い）。素の DELETE で書くと
  --   plpgsql は初回実行時に解決を試みて "relation does not exist" で落ち、
  --   **消去が丸ごと失敗する**。無い置き場は「消すものが無い」であって異常ではないので、
  --   実在するものだけを消す。将来ここに表を足すときも同じ形で足すこと。
  DECLARE
    v_targets text[][] := ARRAY[
      -- {テーブル名, WHERE 句}   $1 = shopify_ids / $2 = actors(line+web) / $3 = line_ids / $4 = web_refs
      ['conversations',            'user_id = ANY($2)'],
      ['message_feedback',         'user_id = ANY($2)'],
      ['unanswered_queries',       'user_id = ANY($2)'],
      ['tasting_note_survey',      'user_id = ANY($2) OR session_id = ANY($2)'],
      ['flow_events',              'user_ref = ANY($2)'],
      ['product_ratings',          'user_ref = ANY($2)'],
      ['pending_follow_refs',      'line_user_id = ANY($3)'],
      -- 送信の下書き本文（body_preview）を持つため、集計ではなく個人の記録として消す。
      ['dormant_reengagement_log', 'line_user_id = ANY($3)'],
      ['marche_activation_log',    'line_user_id = ANY($3)'],
      ['account_link_nonces',      'shopify_customer_id = ANY($1)'],
      -- ── 別名表は最後（identity は冒頭で解決済みなので、ここで消して安全）──
      --   通常の「連携解除」は行を残して列だけ空にする（配信停止の設定を巻き戻さないため）。
      --   だが**記録を消す**ときは人ごと居なくなるので、行ごと消す。
      --   残すと「以前この人が居た」という痕跡になり、確定原則に反する。
      ['customer_profiles',        'line_user_id = ANY($3) OR shopify_customer_id = ANY($1)'],
      ['user_identity_map',        'line_user_id = ANY($3) OR line_login_user_id = ANY($3) OR shopify_customer_id = ANY($1) OR web_session_id = ANY($4)'],
      ['customer_linkages',        'line_user_id = ANY($3) OR shopify_customer_id = ANY($1)']
    ];
    v_t text;
    v_w text;
    i   integer;
  BEGIN
    FOR i IN 1 .. array_length(v_targets, 1) LOOP
      v_t := v_targets[i][1];
      v_w := v_targets[i][2];
      IF to_regclass('public.' || v_t) IS NOT NULL THEN
        EXECUTE format('DELETE FROM public.%I WHERE %s', v_t, v_w)
          USING v_shopify, v_actors, v_line, v_web;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_counts := v_counts || jsonb_build_object(v_t, v_n);
      END IF;
    END LOOP;
  END;

  -- 返り値は件数と、解決した ID のみ。「削除済み 1 件」を記録する行は作らない。
  -- identity を返すのは、呼び出し側が直後に roji_erasure_residue で検算するため
  -- （別名表を消した後は同じ ID 群を二度と復元できない）。
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
-- 3. 検算（読み取り専用）— 消したあとに何が残っているか
--
--    「消しました」と言うだけの実装にしないための口。
--    remaining が全て 0 であることをテストと運用の両方で確認する。
--    preserved は図2 で「残る」と決めたものの件数（0 でないのが正常）。
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
  v_checks text[][];
  v_t text;
  v_w text;
  v_n bigint;
  i   integer;
BEGIN
  v_actors := v_line || v_web;

  -- 消す側（roji_erase_person）と同じ「実在するものだけ」の扱いにする。
  -- ここが素の SELECT だと、本番に無い表を数えようとして検算そのものが落ちる。
  v_checks := ARRAY[
    ['conversations',            'user_id = ANY($2)'],
    ['message_feedback',         'user_id = ANY($2)'],
    ['unanswered_queries',       'user_id = ANY($2)'],
    ['tasting_note_survey',      'user_id = ANY($2) OR session_id = ANY($2)'],
    ['flow_events',              'user_ref = ANY($2)'],
    ['product_ratings',          'user_ref = ANY($2)'],
    ['pending_follow_refs',      'line_user_id = ANY($3)'],
    ['dormant_reengagement_log', 'line_user_id = ANY($3)'],
    ['marche_activation_log',    'line_user_id = ANY($3)'],
    ['account_link_nonces',      'shopify_customer_id = ANY($1)'],
    ['customer_profiles',        'line_user_id = ANY($3) OR shopify_customer_id = ANY($1)'],
    ['customer_linkages',        'line_user_id = ANY($3) OR shopify_customer_id = ANY($1)'],
    ['user_identity_map',        'line_user_id = ANY($3) OR line_login_user_id = ANY($3) OR shopify_customer_id = ANY($1) OR web_session_id = ANY($4)'],
    ['roji_delivery_ledger',     'shopify_customer_id = ANY($1)'],
    ['roji_word_person_refs',    '(subject_kind = ''shopify'' AND subject_id = ANY($1)) OR (subject_kind = ''line'' AND subject_id = ANY($3))'],
    ['roji_words',               'person_seq IN (SELECT person_seq FROM roji_word_person_refs WHERE (subject_kind = ''shopify'' AND subject_id = ANY($1)) OR (subject_kind = ''line'' AND subject_id = ANY($3)))']
  ];

  FOR i IN 1 .. array_length(v_checks, 1) LOOP
    v_t := v_checks[i][1];
    v_w := v_checks[i][2];
    IF to_regclass('public.' || v_t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', v_t, v_w)
        INTO v_n USING v_shopify, v_actors, v_line, v_web;
      v_remaining := v_remaining || jsonb_build_object(
        CASE WHEN v_t = 'roji_words' THEN 'roji_words_person_linked' ELSE v_t END, v_n);
    END IF;
  END LOOP;

  -- 図2 で「残る」と決めたもの。0 になっていたら消しすぎ。
  SELECT jsonb_build_object(
    'roji_edit_records',        (SELECT count(*) FROM roji_edit_records),
    'roji_words_anonymous',     (SELECT count(*) FROM roji_words WHERE person_seq IS NULL),
    'roji_delivery_months',     (SELECT count(*) FROM roji_delivery_months)
  ) INTO v_preserved;

  RETURN jsonb_build_object(
    'remaining', v_remaining,
    'preserved', v_preserved,
    -- 表が 1 つも実在しないとき bool_and は NULL を返す。検算が NULL を返すと
    -- 呼び出し側で「clean ではない」と「判定不能」の区別が付かないため true に倒す
    -- （数える対象が無い = 残っているものが無い）。
    'clean',     coalesce((SELECT bool_and(value::text::bigint = 0) FROM jsonb_each(v_remaining)), true)
  );
END;
$$ LANGUAGE plpgsql STABLE;
