-- 033: roji「送った記録の台帳」— 誰に・いつ・何を送ったか（項目 42〜53・66）＋ 編集の記録（項目52）
--
-- 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義
--   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c  第3章 3-6 / 第6章 第1段階 順2
-- 上位の正本: rojiマスタースペック https://www.notion.so/3af70c9d064c81a08be5eab8027dc2f4
--
-- ─ なぜ創刊号を出す前に必要か（絶対）─
--   書かなかった月は永久に空欄になる。定義文書は本台帳を「唯一の必須の新設・最優先」と置いている。
--
-- ─ 定義文書の「共通の決めごと」を、どう構造で担保したか ─
--   (1) 1人1月1行  → UNIQUE (shopify_customer_id, period)
--   (2) 配送先の住所は書き写さない → 住所に相当する列を一切置かない（EC 側が正本・見に行く）
--   (3) 割当を確定したときに行を作る（何も起きなかった人にも行ができる）→ 必須列は鍵と期間だけ
--   (4) 月そのものの締め記録を別に 1 件持つ（項目66）→ roji_delivery_months
--
-- ─ 項目52（編集の記録）を別表に分けた理由 ─
--   定義文書では置き場は「台帳」だが、**消え方だけが他の列と違う**（項目42〜53 は「消える」、
--   項目52 だけ「骨だけ残る」）。同じ行に置くと、本人が記録を消したとき行ごと消えて
--   Q9（編集のやり方が再現できるか）の母数が欠ける。逆に行を残すと「消える」の約束が破れる。
--   よって **台帳の中の別の行（roji_edit_records）** として持ち、台帳行からは参照だけを張る。
--   本人が消す = 台帳行が消える = 参照が消える。編集の記録は個人への列を 1 つも持たないまま残る。
--   2026-08-08 Boss判断（判断4・第3の道）「誰に向けて編んだかは切り離し、
--   号の識別子も個人を特定できる形なら持たない」を構造で実現したもの。
--
-- ─ 置かないと決めたもの（定義文書 第4章。ここに列を足してはならない）─
--   星・点数・NPS・満足度・ランキング・バッジ・連続記録・達成率・レベル /
--   他人との比較 / 滞在時間 / 開封率・クリック率・回遊数・ページビュー /
--   配送先の住所の写し / 表示名・メールアドレスの写し。
--
-- ─ 保存期間 ─ 長く残す（期間で自動的に消さない）。pg_cron の削除ジョブは作らない。
-- ─ 冪等性 ─ IF NOT EXISTS / CREATE OR REPLACE で再実行安全。
-- ─ 破壊性 ─ 追加のみ。既存テーブルの DROP / 型変更 / データ書き換えを一切行わない。

-- ===================================================================
-- 1. 編集の記録（項目52）— 個人への参照を 1 つも持たない骨
-- ===================================================================
CREATE TABLE IF NOT EXISTS roji_edit_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 編んだ月（YYYY-MM）。号の識別子は持たない（roji は 1人ずつに編むため、
  -- 号がそのまま個人を指しかねない = 2026-08-08 Boss判断の条件）。
  edited_period text NOT NULL CHECK (edited_period ~ '^[0-9]{4}-[0-9]{2}$'),
  -- 誰が編んだか（運営の識別。お客さんではない）。
  editor_ref text NOT NULL,
  -- 手直しの量（下書きにどれだけ手を入れたか）。単位はアプリ側で定義する。
  revision_amount numeric,
  -- 直した箇所の性質（複数可）:
  --   fact / tone / order / length / quotation / other
  revision_kinds text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
  -- ここに shopify_customer_id 等、個人に辿り着ける列を足してはならない。
  -- 足した瞬間に「骨だけ残る」が成立しなくなる（tests/unit/roji-containers.test.ts が機械チェックする）。
);

CREATE INDEX IF NOT EXISTS roji_edit_records_period_idx ON roji_edit_records (edited_period);

-- ===================================================================
-- 2. 送った記録の台帳（項目 42〜53）— 1人1月1行
-- ===================================================================
CREATE TABLE IF NOT EXISTS roji_delivery_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- 項目42: 誰に / いつ（行の鍵）。EC 上の顧客番号 + 年月。
  shopify_customer_id text NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),

  -- 項目43: どのお茶を（参照・複数件）。じぶんのページの月別履歴と翌月の重複回避に使う。
  teas jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 項目44: どの号を（参照）。
  issue_ref text,

  -- 項目45: 事前通知に対する変更（何を何に変えたか・複数件）。
  --   形: [{"from": <ref>, "to": <ref>, "at": <ISO8601>}, ...]
  --   1タップの反応よりはるかに強い意思表示（Q4・N4）。
  preview_changes jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 項目46: 事前通知の中身の画面を開いたか / そのままにしたか。
  --   **全体の分母としてのみ使い、個人の推定には一切使わない**（2026-08-08 確定）。
  preview_opened boolean NOT NULL DEFAULT false,
  preview_first_opened_at timestamptz,

  -- 項目47: 変更の画面に入ったが確定しなかった（迷いの所在）。
  change_abandoned boolean NOT NULL DEFAULT false,

  -- 項目48: 割当を決めた時点の推定のスナップショット（その月に凍結した値）。
  --   カルテの写しではない。カルテは上書きされる現在の値、これは凍結値。
  estimate_snapshot jsonb,

  -- 項目49: 候補に出したが選ばなかったもの ＋ 外した理由の記号。
  --   形: [{"ref": <ref>, "reason": "<code>"}, ...]
  candidates_not_chosen jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 項目50: その号に置いた素材と、その順番。
  --   形: [{"ref": <ref>, "position": 1}, ...]
  issue_materials jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 項目51: 素材の版（参照のみ。版の実体は素材のマスタ側）。
  material_versions jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 項目52: 編集の記録への参照。本人が記録を消すと本行ごと消え、参照も消える。
  --   参照先（骨）は個人への列を持たないまま残る。
  edit_record_id bigint REFERENCES roji_edit_records(id) ON DELETE SET NULL,

  -- 項目53: その月の1行。何も起きなかった月も必ず「反応なし」と書く。空欄を許さない。
  --   行を作った時点では未記入でよく、**月を締めた時点で空欄を許さない**（下の CHECK）。
  monthly_note text,
  closed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 1人1月1行。
  CONSTRAINT roji_delivery_ledger_person_period_uniq UNIQUE (shopify_customer_id, period),
  -- 月を締めたなら「その月の1行」は空欄にできない（N3 の見張りの土台）。
  --   行があるのに1行が空 = 記録漏れ / 行があって「反応なし」= 無風、を機械的に見分けるため。
  CONSTRAINT roji_delivery_ledger_note_required_on_close
    CHECK (closed_at IS NULL OR btrim(coalesce(monthly_note, '')) <> ''),
  -- 開いた日時があるなら「開いた」が立っていること（片側だけの矛盾を防ぐ）。
  CONSTRAINT roji_delivery_ledger_open_pair
    CHECK (preview_first_opened_at IS NULL OR preview_opened = true)
);

CREATE INDEX IF NOT EXISTS roji_delivery_ledger_period_idx
  ON roji_delivery_ledger (period);
CREATE INDEX IF NOT EXISTS roji_delivery_ledger_customer_idx
  ON roji_delivery_ledger (shopify_customer_id);
CREATE INDEX IF NOT EXISTS roji_delivery_ledger_unclosed_idx
  ON roji_delivery_ledger (period) WHERE closed_at IS NULL;

-- ===================================================================
-- 3. 月の締め記録（項目66）— 人ではなく月の単位。1月につき1件。消えない。
--    会員が0人だった月は台帳の個人行が0行になるため、月の行が無いと
--    「誰も居なかった」のか「締めが走らなかった」のかを見分けられない。
-- ===================================================================
CREATE TABLE IF NOT EXISTS roji_delivery_months (
  period text PRIMARY KEY CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  closed_at timestamptz NOT NULL,
  -- その月の対象会員数。
  member_count integer NOT NULL CHECK (member_count >= 0),
  -- 台帳に作った行数。member_count と食い違えば記録の事故（N3）。
  row_count integer NOT NULL CHECK (row_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================================================================
-- 4. 本人が記録を消したとき — 定義どおりのものだけを残す
--    定義文書「図2 — 本人が記録を消したとき、何が消えて何が残るか」の実装。
--
--    消える   : 本人に紐づく言葉（roji_words）/ 台帳の行 / 連番と ref の対応
--    骨だけ残る: 編集の記録（roji_edit_records。誰に向けて編んだかは切り離す）
--    残る     : イベント当日の匿名の言葉（person_seq を持たない = 最初から誰のものか分からない）
--              月の締め記録（個人の記録ではない）
--
--    ※ 本関数が扱うのは **本 migration と 032 で新設した器だけ**。
--      既存の Firestore カルテ・出来事の置き場・未連携カルテ2か所への削除の配線は
--      別作業（「消せる」を全経路に通す。アンケート公開前までの必達項目）。
--    ※ 返り値は削除件数のみ。**削除済み1件という痕跡は一切残さない**（確定原則）。
-- ===================================================================
CREATE OR REPLACE FUNCTION roji_erase_person(
  p_subject_kind text,
  p_subject_id text
) RETURNS jsonb AS $$
DECLARE
  v_person_seq bigint;
  v_words_deleted integer := 0;
  v_ledger_deleted integer := 0;
  v_person_deleted integer := 0;
BEGIN
  IF p_subject_kind NOT IN ('shopify', 'line') THEN
    RAISE EXCEPTION 'roji_erase_person: subject_kind は shopify / line のいずれか（受領: %）', p_subject_kind;
  END IF;

  SELECT person_seq INTO v_person_seq
  FROM roji_word_person_refs
  WHERE subject_kind = p_subject_kind AND subject_id = p_subject_id;

  IF v_person_seq IS NOT NULL THEN
    -- 本人に紐づく言葉を数えてから、人ごと消す（refs / words は ON DELETE CASCADE）。
    SELECT count(*) INTO v_words_deleted FROM roji_words WHERE person_seq = v_person_seq;
    DELETE FROM roji_word_persons WHERE person_seq = v_person_seq;
    GET DIAGNOSTICS v_person_deleted = ROW_COUNT;
  END IF;

  -- 台帳は EC 上の顧客番号が鍵。line 指定では台帳に辿り着けない（設計どおり）。
  IF p_subject_kind = 'shopify' THEN
    DELETE FROM roji_delivery_ledger WHERE shopify_customer_id = p_subject_id;
    GET DIAGNOSTICS v_ledger_deleted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'words_deleted', v_words_deleted,
    'ledger_rows_deleted', v_ledger_deleted,
    'person_deleted', v_person_deleted
  );
END;
$$ LANGUAGE plpgsql;

-- ===================================================================
-- RLS（migration 017 / 018 / 019 / 024 / 025 / 029 / 032 と同じ姿勢）
--   アプリは service_role_key で接続し RLS をバイパスする。
--   ポリシー無し = 非 service_role 接続に対し deny-all。
-- ===================================================================
ALTER TABLE roji_edit_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE roji_delivery_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE roji_delivery_months ENABLE ROW LEVEL SECURITY;
