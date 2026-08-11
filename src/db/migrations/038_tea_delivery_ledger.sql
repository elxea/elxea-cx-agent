-- 038: 配送台帳 —「誰に・いつ・何が(どの茶葉が)届いたか」の事実記録
--
-- 一次入力（仕様の正本）: elxea CX Agent機能定義 v1.5
--   https://www.notion.so/3b970c9d064c81ddb60ff08c23152929  3-2「手元のお茶から1杯を選ぶ」/ 第5節 タスク9
-- 併読: rojiカルテの項目 — 最終形の定義 https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
--
-- ─ なぜ今か（絶対）─
--   「手元にあるお茶から1杯を選ぶ」はCX Agentの代表用途だが、届いた事実の記録が現在ゼロで
--   原理的に成立しない。しかもこの記録は**過去に遡って作れない**。書かなかった月は永久に空欄。
--   表に出す・出さないと無関係に、今から書き始める価値がある（機能定義 第4節）。
--
-- ─ 033（roji_delivery_ledger）との棲み分け（単一正本の線引き・重要）─
--   033 は **roji の「割当を決めた記録」**（1人1月1行・号の編集・凍結した推定値）。
--   本表は **「実際に届いた事実の記録」**（1人×1回の配送×1銘柄）。
--   決めたこと（033）と、届いたこと（038）は別の事実で、ずれることがある（欠品・変更・返品）。
--   よって統合せず、`period` で突き合わせられる形にする。033 に列を足してはならない。
--
-- ─ 粒度 ─ 1 行 = 1人 × 1回の配送 × 1銘柄。数量は列で持つ（行を増やさない）。
--
-- ─ 誰に（鍵）─ **shopify_customer_id か line_user_id の少なくとも一方**。
--   033 は EC 上の顧客番号を必須にしたが、**EC はまだ開店しておらず顧客番号が実在しない**
--   （機能定義 3-4）。必須にすると「今から書き始める」ができず、本タスクの目的が達成できない。
--   名寄せ後の統一 ID（EC 上の顧客番号）が本命であることは変えず、**それが無い間も line_user_id で
--   書ける**ようにする。両方入っている行が最終形で、名寄せが通った時点で埋めていく。
--   列名は 037 の「人を指す列の語彙」に合わせてある（＝**消去の対象に自動で入る**。下記「消せる」）。
--
-- ─ 出所（source）─ どこから来た記録かを必ず持つ。推定と事実を混ぜないため。
--     shopify_order    : Shopify 注文 webhook 由来（機械・既定）
--     manual           : 手動投入（マルシェ手渡し・EC 開店前の実配送・記録の遡り補完）
--     roji_assignment  : roji の割当から起こした行（033 の決定を「届いた」として確定させたとき）
--
-- ─ 置かないと決めたもの（ここに列を足してはならない・roji 正本 第4章と同じ姿勢）─
--   配送先の住所 / 宛名・表示名・メールアドレスの写し（EC 側が正本・見に行く）/
--   金額・割引・送料（物販の匂いを持ち込まない。手元の推定に不要）/
--   星・点数・満足度・開封率・クリック率。
--
-- ─ 保存期間 ─ 長く残す（期間で自動的に消さない）。pg_cron の削除ジョブは作らない。
--   「手元にあるお茶」の推定は過去の配送を遡って読むため、期限つき削除と両立しない。
-- ─ 消せる ─ 037 の `roji_person_key_map()` が人を指す列を持つ表を**毎回列挙**するため、
--   本表は登録作業なしで `roji_erase_person` の削除対象に入る（既定が「消す」側）。
--   除外リスト（037 の NOT IN）に本表を足してはならない。
-- ─ 冪等性 ─ IF NOT EXISTS / CREATE OR REPLACE で再実行安全。書き込み側も (出所, 出所の参照,
--   明細の参照) の UNIQUE で二重計上しない。
-- ─ 破壊性 ─ 追加のみ。既存テーブルの DROP / 型変更 / データ書き換えを一切行わない。

-- ===================================================================
-- 0. 補助関数（generated column から呼ぶため IMMUTABLE）
-- ===================================================================

-- 届いた日 → 年月（'YYYY-MM'）。033 の period と同じ形にして突き合わせ可能にする。
CREATE OR REPLACE FUNCTION tea_delivery_period(d date)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT lpad(EXTRACT(YEAR FROM d)::int::text, 4, '0')
      || '-' || lpad(EXTRACT(MONTH FROM d)::int::text, 2, '0');
$$;

-- 日付の確からしさの順位。同じ明細に後からより確かな日付が来たときだけ上書きする。
--   ordered(1)   … 注文日で代用（発送前・最弱）
--   fulfilled(2) … 発送の記録がある
--   manual(3)    … 人が実際の受け渡しを確認して入れた（最強）
CREATE OR REPLACE FUNCTION tea_delivery_basis_rank(basis text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE basis WHEN 'manual' THEN 3 WHEN 'fulfilled' THEN 2 WHEN 'ordered' THEN 1 ELSE 0 END;
$$;

-- ===================================================================
-- 1. 配送台帳
-- ===================================================================
CREATE TABLE IF NOT EXISTS tea_delivery_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- 誰に（名寄せ後の統一 ID が本命。EC 開店前は LINE の ID だけで書ける）。
  shopify_customer_id text,
  line_user_id text,

  -- いつ（届いた日。時刻は持たない = 受け取り時刻は分からないのが普通）。
  delivered_on date NOT NULL,
  -- その日付が何に基づくか（推定と事実を混ぜないための印）。
  date_basis text NOT NULL CHECK (date_basis IN ('ordered', 'fulfilled', 'manual')),

  -- 何が（銘柄単位）。参照が正本で、名前はその時点の写し（商品が改名・削除されても中身が残るように）。
  -- 'unknown' は「まだ分類していない」の意味。分からないものを 'tea' と書かない（推測で埋めない）。
  -- 商品マスタ側の分類が付いた時点で 'tea' / 'goods' に直す（後から直せる）。
  item_kind text NOT NULL DEFAULT 'unknown' CHECK (item_kind IN ('tea', 'goods', 'other', 'unknown')),
  item_ref text NOT NULL,
  item_variant_ref text,
  item_name text,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),

  -- どこから来た記録か。
  source text NOT NULL CHECK (source IN ('shopify_order', 'manual', 'roji_assignment')),
  -- 出所の参照（注文 ID / 手動投入の根拠 / 033 の period）。
  source_ref text NOT NULL,
  -- 明細の参照（Shopify の line_item ID / 手動投入の連番）。二重計上を防ぐ鍵の一部。
  source_line_ref text NOT NULL,

  -- 手動投入の出所メモ（「7/20 マルシェで手渡し」等）。個人を特定する記述は書かない。
  note text,

  -- 月の突き合わせ用（033 の period と同じ形）。
  period text GENERATED ALWAYS AS (tea_delivery_period(delivered_on)) STORED,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 誰の記録か分からない行を作らない（guest checkout は行を作らずスキップする）。
  CONSTRAINT tea_delivery_ledger_subject_required
    CHECK (shopify_customer_id IS NOT NULL OR line_user_id IS NOT NULL),
  -- 同じ明細を二度数えない（webhook の再送・複数 topic・手動の再実行に耐える）。
  CONSTRAINT tea_delivery_ledger_source_uniq
    UNIQUE (source, source_ref, source_line_ref)
);

CREATE INDEX IF NOT EXISTS tea_delivery_ledger_shopify_idx
  ON tea_delivery_ledger (shopify_customer_id, delivered_on DESC)
  WHERE shopify_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tea_delivery_ledger_line_idx
  ON tea_delivery_ledger (line_user_id, delivered_on DESC)
  WHERE line_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tea_delivery_ledger_period_idx
  ON tea_delivery_ledger (period);
CREATE INDEX IF NOT EXISTS tea_delivery_ledger_item_idx
  ON tea_delivery_ledger (item_ref, delivered_on DESC);

-- ===================================================================
-- 2. 書き込み口（アプリはこの関数だけを呼ぶ）
--
--   なぜ関数にするか: 「同じ明細に後からより確かな日付が来たときだけ上書きする」を
--   ON CONFLICT の WHERE で表す必要があり、クライアント側の upsert では表現できない。
--   ここに置けば、どの経路（webhook / 手動スクリプト）から書いても規則が 1 つになる。
--
--   入力: 行の配列（jsonb）。返り値: 件数だけ（誰の行かは返さない）。
-- ===================================================================
CREATE OR REPLACE FUNCTION record_tea_deliveries(p_rows jsonb)
RETURNS jsonb AS $$
DECLARE
  r          jsonb;
  v_inserted int := 0;
  v_updated  int := 0;
  v_kept     int := 0;
  v_was_new  boolean;
  v_touched  boolean;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'record_tea_deliveries: 配列の jsonb を渡すこと（受領: %）', jsonb_typeof(p_rows);
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF coalesce(r->>'shopify_customer_id', '') = ''
       AND coalesce(r->>'line_user_id', '') = '' THEN
      RAISE EXCEPTION 'record_tea_deliveries: 誰の記録か分からない行は書けない（鍵が両方とも空）';
    END IF;

    v_was_new := false;
    v_touched := false;

    INSERT INTO tea_delivery_ledger (
      shopify_customer_id, line_user_id, delivered_on, date_basis,
      item_kind, item_ref, item_variant_ref, item_name, quantity,
      source, source_ref, source_line_ref, note
    )
    VALUES (
      nullif(r->>'shopify_customer_id', ''),
      nullif(r->>'line_user_id', ''),
      (r->>'delivered_on')::date,
      r->>'date_basis',
      coalesce(nullif(r->>'item_kind', ''), 'unknown'),
      r->>'item_ref',
      nullif(r->>'item_variant_ref', ''),
      nullif(r->>'item_name', ''),
      coalesce((r->>'quantity')::int, 1),
      r->>'source',
      r->>'source_ref',
      r->>'source_line_ref',
      nullif(r->>'note', '')
    )
    ON CONFLICT (source, source_ref, source_line_ref) DO UPDATE SET
      -- 鍵は「埋まる方向」にだけ動かす（名寄せが通って顧客番号が付いたとき）。消さない。
      shopify_customer_id = coalesce(EXCLUDED.shopify_customer_id, tea_delivery_ledger.shopify_customer_id),
      line_user_id        = coalesce(EXCLUDED.line_user_id, tea_delivery_ledger.line_user_id),
      delivered_on        = EXCLUDED.delivered_on,
      date_basis          = EXCLUDED.date_basis,
      item_name           = coalesce(EXCLUDED.item_name, tea_delivery_ledger.item_name),
      -- 分類は「分かった方向」にだけ動かす（unknown で上書きして分類を消さない）。
      item_kind           = CASE WHEN EXCLUDED.item_kind <> 'unknown'
                                 THEN EXCLUDED.item_kind ELSE tea_delivery_ledger.item_kind END,
      quantity            = EXCLUDED.quantity,
      note                = coalesce(EXCLUDED.note, tea_delivery_ledger.note),
      updated_at          = now()
    WHERE tea_delivery_basis_rank(EXCLUDED.date_basis)
          >= tea_delivery_basis_rank(tea_delivery_ledger.date_basis)
    RETURNING (xmax = 0) INTO v_was_new;

    -- INSERT / UPDATE のどちらかが起きたか（WHERE で弾かれると FOUND = false）。
    v_touched := FOUND;

    IF NOT v_touched THEN
      -- 既存行の方が確かな日付を持っていた（WHERE で弾かれた）。何もしない。
      v_kept := v_kept + 1;
    ELSIF v_was_new THEN
      v_inserted := v_inserted + 1;
    ELSE
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'kept', v_kept);
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- 3. RLS（017 / 019 / 024 / 032 / 033 と同じ姿勢）
--   アプリは service_role_key で接続し RLS をバイパスする。
--   ポリシー無し = 非 service_role 接続に対し deny-all。
-- ===================================================================
ALTER TABLE tea_delivery_ledger ENABLE ROW LEVEL SECURITY;
