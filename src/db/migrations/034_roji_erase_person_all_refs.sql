-- 034: roji_erase_person の消し残しを塞ぐ — 本人が持つ「すべての恒久ID」から台帳を消す
--
-- 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義
--   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c  図2「本人が記録を消したとき」
--
-- ─ 何が起きていたか（033 の実装の穴・実測で確認）─
--   033 の roji_erase_person は「渡された 1 つの ID」しか見ていなかった。
--   そのため **LINE の ID で消すと、同じ人の台帳（EC 上の顧客番号が鍵）が残る**。
--   合流済みの人（LINE と EC の両方の ref を持つ人）は必ずこれに当たる。
--   実測（staging・tx 内で再現し ROLLBACK 済み）:
--     roji_erase_person('line','U-...') → words_deleted=1 / ledger_rows_deleted=0
--     台帳の行が 1 行残った。= 「消せる」の約束が破れる。
--
-- ─ どう直すか ─
--   人を消す前に **その人が持つ ref を全部集め**、そのうち shopify の ref すべてについて
--   台帳の行を消す。どちらの ID から消しても結果が同じになる（対称にする）。
--   ref は roji_word_persons の削除で CASCADE で消えるため、**消す前に集める**のが要点。
--
-- ─ 変えないもの（定義どおり）─
--   匿名の言葉（person_seq を持たない）は消えない。
--   編集の記録（roji_edit_records）は骨として残る。
--   月の締め記録（roji_delivery_months）は消えない。
--   削除済み 1 件という痕跡を残さない（返り値は件数のみ・ログ行を作らない）。
--
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION のみ。何度適用しても同じ。
-- ─ 破壊性 ─ 関数の定義を差し替えるだけ。テーブル・データに一切触れない。
--            033 の SQL ファイルは書き換えない（適用済み実体との対応を壊さないため）。

CREATE OR REPLACE FUNCTION roji_erase_person(
  p_subject_kind text,
  p_subject_id text
) RETURNS jsonb AS $$
DECLARE
  v_person_seq bigint;
  v_shopify_ids text[] := ARRAY[]::text[];
  v_words_deleted integer := 0;
  v_ledger_deleted integer := 0;
  v_ledger_batch integer := 0;
  v_person_deleted integer := 0;
BEGIN
  IF p_subject_kind NOT IN ('shopify', 'line') THEN
    RAISE EXCEPTION 'roji_erase_person: subject_kind は shopify / line のいずれか（受領: %）', p_subject_kind;
  END IF;

  SELECT person_seq INTO v_person_seq
  FROM roji_word_person_refs
  WHERE subject_kind = p_subject_kind AND subject_id = p_subject_id;

  -- 本人が持つ EC 上の顧客番号を **消す前に** すべて集める。
  -- （roji_word_persons を消すと ref は CASCADE で消えるため、後からは辿れない）
  IF v_person_seq IS NOT NULL THEN
    SELECT coalesce(array_agg(subject_id), ARRAY[]::text[]) INTO v_shopify_ids
    FROM roji_word_person_refs
    WHERE person_seq = v_person_seq AND subject_kind = 'shopify';
  END IF;

  -- 呼び出しが shopify の ID で来た場合、ref が無くても台帳は消せなければならない
  -- （言葉を 1 件も置いていない人 = ref がまだ無い人がこれに当たる）。
  IF p_subject_kind = 'shopify' AND NOT (p_subject_id = ANY (v_shopify_ids)) THEN
    v_shopify_ids := v_shopify_ids || p_subject_id;
  END IF;

  IF v_person_seq IS NOT NULL THEN
    SELECT count(*) INTO v_words_deleted FROM roji_words WHERE person_seq = v_person_seq;
    DELETE FROM roji_word_persons WHERE person_seq = v_person_seq;
    GET DIAGNOSTICS v_person_deleted = ROW_COUNT;
  END IF;

  -- 集めた EC 上の顧客番号すべてについて台帳を消す。
  IF array_length(v_shopify_ids, 1) IS NOT NULL THEN
    DELETE FROM roji_delivery_ledger WHERE shopify_customer_id = ANY (v_shopify_ids);
    GET DIAGNOSTICS v_ledger_batch = ROW_COUNT;
    v_ledger_deleted := v_ledger_deleted + v_ledger_batch;
  END IF;

  RETURN jsonb_build_object(
    'words_deleted', v_words_deleted,
    'ledger_rows_deleted', v_ledger_deleted,
    'person_deleted', v_person_deleted
  );
END;
$$ LANGUAGE plpgsql;
