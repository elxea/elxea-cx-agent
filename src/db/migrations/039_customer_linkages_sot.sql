-- ===================================================================
-- 039: 連携台帳の正本を customer_linkages に確定し、死蔵表 customer_profiles を落とす
--      （再設計 M-1 / F11 / 決裁 J-3）
-- ===================================================================
--
-- ─ なぜ要るか ─
--
-- 「この LINE はどの顧客か」を持つ表が **3 つ**あった。
--
--   1. customer_linkages … 連携の正本。書き込み経路が実際に使っている
--   2. user_identity_map … 会話履歴の名寄せ。line_login_user_id / web_session_id を
--                          持つ**独立した部分ビュー**で、単なる重複コピーではない
--   3. customer_profiles … **死蔵**。ランタイム参照ゼロ（`from("customer_profiles")` が
--                          src/ に 0 件）。消去 RPC だけが「別名表」として参照している
--
-- 3 つあると、書く側は片方しか書かず、読む側は別の片方を読む、が起きる。実際
-- 「解除しても Web に LINE 側の会話履歴が出続ける」は、解除が customer_linkages
-- しか触らず user_identity_map を放置していたことから来ている。
--
-- ─ 何をするか ─
--
--   A. customer_linkages を正本と**宣言する**（COMMENT）。宣言は実行されないが、
--      次にこのスキーマを読む人が最初に見る場所に置く意味がある
--   B. user_identity_map を「従属」と宣言する（J-3 の段階移行。表は残す）
--   C. customer_profiles を**表ごと落とす**
--
-- ─ C を安全にやるための順序 ─
--
-- customer_profiles を参照しているのは roji_resolve_identity（036 由来）だけ。
-- **先に関数を差し替えてから、表を落とす。** 逆順だと、その間に消去要求が来た
-- 場合に「存在しない表を参照する関数」が走り、消去がまるごと失敗する。
--
-- roji_erase_person / roji_erasure_residue（037）は information_schema から対象表を
-- **動的に列挙する**ので、表が消えれば自動的に対象から外れる。触る必要は無い。
--
-- ─ 破壊性 ─
--
-- DROP TABLE を含む。ただし本番の customer_profiles は **0 行**（2026-08-25 に
-- PostgREST で read-only 実測）。落として失われるデータは無い。
--
-- ─ 冪等性 ─
--
-- CREATE OR REPLACE FUNCTION と DROP TABLE IF EXISTS のみ。何度当てても同じ。
--
-- ─ 適用手順 ─
--
--   MIGRATE_ONLY=039 bash scripts/deploy-prod.sh
--
-- bare `--apply` は使わない（deploy-prod.sh が fail-closed で止める）。
-- ===================================================================

-- ===================================================================
-- A/B. どれが正本かをスキーマ自身に書く
-- ===================================================================
COMMENT ON TABLE customer_linkages IS
  '連携の正本（SoT）。「この LINE はどの顧客か」を決めるのはこの表だけ。'
  ' 解除は行を消さず shopify_customer_id / shopify_email / source を null にする'
  '（同じ行に broadcast_opted_out / unfollowed_at が同居しており、行ごと消すと'
  ' お客さまが設定した配信停止まで巻き戻るため）。'
  ' 1 LINE = 1 顧客（J-4: 世帯共有は認めない）。衝突は 409 で利用者に明示する。';

COMMENT ON TABLE user_identity_map IS
  '会話履歴の名寄せ用の従属ビュー（正本は customer_linkages / 決裁 J-3）。'
  ' line_login_user_id と web_session_id という customer_linkages に無い軸を持つため'
  ' 単なる重複コピーではなく、まだ落とせない。'
  ' ⚠ 連携の有無をこの表で判定しないこと。判定は必ず customer_linkages を見る。';

-- ===================================================================
-- C-1. 先に関数から customer_profiles を外す（表を落とす前に）
--
--      036 の roji_resolve_identity から、customer_profiles を引く 2 つの UNION 枝
--      だけを取り除いた版。他は 036 と同一。
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

    -- 別名表（customer_linkages 正 / user_identity_map 従属）と
    -- 言葉の置き場の ref を、両方向に 1 段引く。
    -- ⚠ customer_profiles の枝は 039 で削除（表ごと廃止・死蔵かつ 0 行）。
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
    ) q WHERE l IS NOT NULL AND l <> '';

    -- Web の一時 ID は別名表に載っているものだけ（匿名 Web は本人に辿れないので対象外）。
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
-- C-2. 死蔵表を落とす
--
--      ⚠ 空でないなら落とさない。本番は 0 行と実測済みだが、実測は過去の一点の
--        事実にすぎない。当てる瞬間に行があれば、それは前提が変わったということ
--        なので、黙って消さずに止める。
-- ===================================================================
DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.customer_profiles') IS NULL THEN
    RAISE NOTICE '039: customer_profiles は既に存在しない（適用済み）';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM customer_profiles' INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION
      '039: customer_profiles に % 行ある。0 行を前提とした migration なので中止する。'
      ' 行の中身を確認し、customer_linkages へ移すか破棄するかを決めてから当て直すこと。',
      v_rows;
  END IF;

  DROP TABLE customer_profiles;
  RAISE NOTICE '039: customer_profiles を落とした（0 行・死蔵）';
END;
$$;
