-- 032: roji「言葉の置き場」— お客さんの言葉の原文を 1 件 1 レコードで残す（項目 34〜41）
--
-- 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義
--   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c  第3章 3-5 / 第6章 第1段階 順1
-- 上位の正本: rojiマスタースペック https://www.notion.so/3af70c9d064c81a08be5eab8027dc2f4
--
-- ─ なぜ最初に作るか ─
--   分類（項目40）が決まっていなくても作れて、作った瞬間から取りこぼしが止まる。
--   いちばん安く、いちばん早く効く（定義文書 第6章 第1段階 順1）。
--
-- ─ 定義文書の「共通の決めごと」を、どう構造で担保したか ─
--   (1) 名前を持たない。内部の連番のみ
--         → roji_words は person_seq（整数）しか持たない。氏名・メール・LINE userId・
--           Shopify 顧客番号のいずれも本表に列が無い。連番と実体の対応は
--           roji_word_person_refs（別表）にだけ置く。
--   (2) 1 件 1 レコード。複数の言葉を 1 つにまとめない
--         → body は 1 件 1 行。まとめる列を作らない。
--   (3) 要約して保存しない。要約は別の欄に持ち、原文を上書きしない
--         → summary 列を別に持ち、body は UPDATE 時の書き換えをトリガで拒否する（不変）。
--   (4) 言葉を数値に変換して、変換後だけを残さない
--         → 変換値を持つ列を置かない。body が NOT NULL で常に原文が残る。
--   (5) 分類が空でも保存する
--         → axis_* は既定 '{}'。NOT NULL だが空配列を許す。保存を止めない。
--
-- ─ 置かないと決めたもの（定義文書 第4章。ここに列を足してはならない）─
--   星・点数・NPS・満足度・ランキング・良し悪しの軸（項目40は「良し悪しの軸は置かない」）/
--   言葉 1 件ごとの引用の許可（許可は人に対する設定。カルテの項目18 に 1 つだけ持つ）/
--   「消去の対象か」の印（person_seq を持つかどうかで決まる。別に持つと矛盾の源）/
--   棚の写し（棚は選び出し。この行に印を付けるだけ = 項目41）/
--   反復の回数・同じことを言った人数（person_seq と body から集計で出る）。
--
-- ─ 匿名（出所 event_floor）の構造的な担保 ─
--   イベント当日「場に置かれた言葉」は 36（誰の）の列を持たない = person_seq IS NULL を
--   CHECK 制約で強制する。同時に本人側の控え（出所 event_own_copy）は別レコードで持ち、
--   **両者を結ぶ鍵（相互参照の列）を作らない**（定義文書 第5章「写しを持つ項目は3件だけ」）。
--
-- ─ 保存期間 ─
--   **永久に残す**（2026-08-08 確定 / 定義文書 項目34〜41 の保存期間欄）。
--   本表に対する pg_cron の自動削除ジョブは作らない。docs/data-retention-policy.md にも
--   「無期限」で記載する（次の担当者が 90 日削除を入れ直すのを防ぐため）。
--   消えるのは「本人が記録を消したとき」だけ（roji_erase_person / migration 033）。
--
-- ─ 冪等性 ─ IF NOT EXISTS / CREATE OR REPLACE で再実行安全。
-- ─ 破壊性 ─ 追加のみ。既存テーブルの DROP / 型変更 / データ書き換えを一切行わない。

-- ===================================================================
-- 1. 人の連番（項目36「誰の」の実体）
--    言葉の表には整数しか置かないための間接層。
-- ===================================================================
CREATE TABLE IF NOT EXISTS roji_word_persons (
  -- 内部の連番。これが roji_words.person_seq に入る唯一の値。
  person_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 連番と、そのとき分かる恒久の ID の対応。
-- 1 人が複数の ref を持てる（LINE だけの人が後で EC 顧客番号を得ても、
-- 言葉の行を書き換えずに ref を足すだけで済む = 合流で言葉が動かない）。
-- 合流の処理そのものはタスク08。本表は器のみ。
CREATE TABLE IF NOT EXISTS roji_word_person_refs (
  person_seq bigint NOT NULL REFERENCES roji_word_persons(person_seq) ON DELETE CASCADE,
  -- 'shopify' = EC 上の顧客番号 / 'line' = LINE の userId。
  -- 別名表（customer_linkages）が正本。本表はその写しではなく、
  -- 「言葉 → 人」を引くための逆引きに限る。
  subject_kind text NOT NULL CHECK (subject_kind IN ('shopify', 'line')),
  subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id)
);

CREATE INDEX IF NOT EXISTS roji_word_person_refs_seq_idx
  ON roji_word_person_refs (person_seq);

-- ===================================================================
-- 2. 言葉の置き場（項目 34〜41）
-- ===================================================================
CREATE TABLE IF NOT EXISTS roji_words (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- 項目34: 原文。一字一句そのまま。誤字も改行も直さない。UPDATE 不可（下のトリガ）。
  body text NOT NULL,

  -- 項目35: いつ。言葉が置かれた時刻。
  occurred_at timestamptz NOT NULL,

  -- 項目36: 誰の。内部の連番のみ。名前は書かない。
  --   NULL = 匿名（出所 event_floor）。本人に辿れないため、本人が記録を消しても消えない。
  person_seq bigint REFERENCES roji_word_persons(person_seq) ON DELETE CASCADE,

  -- 項目37: どこで出た言葉か（出所・10種）。定義文書 3-5「言葉の出所（10種）」。
  source text NOT NULL CHECK (source IN (
    'feedback_note',      -- 1. 感想の添え書き
    'concierge_utterance',-- 2. コンシェルジュの発話
    'change_reason',      -- 3. 変更理由の一言（最も濃い好みの手がかり）
    'event_homework',     -- 4. イベントの宿題の答え
    'event_floor',        -- 5. イベント当日、場に置かれた言葉（匿名・person_seq を持たない）
    'event_afterword',    -- 6. 回のあとの一言
    'cancellation_note',  -- 7. 解約・休止の一言
    'rehearsal_interview',-- 8. リハーサル・試験提供の聞き取り（1回きり・Q7の唯一の証拠）
    'survey_free_text',   -- 9. アンケートの自由記述 / メールの返信
    'event_own_copy'      -- 10. イベント当日、自分が置いた言葉の控え（本人に紐づく・じぶんのページ用）
  )),

  -- 項目38: 何についての言葉か（号 / 記事 / お茶 / 回への参照）。
  --   ※ roji_word_person_refs.subject_kind（人の種別）とは別物なので about_* と名前を分けている。
  about_kind text CHECK (about_kind IN ('issue', 'article', 'tea', 'event')),
  about_ref text,

  -- 項目39: そのとき何が起きていたか（直前の操作。例: 翌月反映の1行を読んだ直後）。
  --   文脈が無いと、後から意味が取れない言葉が大量に生まれる。
  context_slug text,

  -- 項目40: 分類（3軸・複数可・多重付与可・階層なし・後から足せる）。
  --   値を CHECK で固定しない。「後から足せる」が定義の要求のため、
  --   語彙はアプリ側と本コメントで管理する（分類が空でも保存する = 既定 '{}'）。
  --   軸1 どの窓の話か: tea / literature / art / music / farm / science / the_place / none
  axis_window text[] NOT NULL DEFAULT '{}',
  --   軸2 何についての言葉か: delivered / editing / tone / communication / place_event / ops / outside_life
  axis_about text[] NOT NULL DEFAULT '{}',
  --   軸3 何に使えるか: direction / moment / gap / incident / description
  --     ※「良し悪しの軸」は置かない（確定原則）。incident（事故）だけは即時に人へ回す運用。
  axis_use text[] NOT NULL DEFAULT '{}',

  -- 項目41: 棚に上げた印。棚は別の置き場を作らず、この行に印を付けるだけ。
  shelved boolean NOT NULL DEFAULT false,
  shelved_at timestamptz,
  shelf_reason text,           -- なぜ残したか 1行

  -- 要約（原文を上書きしないための別の欄。空でよい）。
  summary text,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- 匿名の言葉は「誰の」を持たない（構造で強制する）。
  CONSTRAINT roji_words_floor_is_anonymous
    CHECK (source <> 'event_floor' OR person_seq IS NULL),
  -- 匿名以外は必ず「誰の」を持つ（持たないと本人が消せない = 消せる約束が破れる）。
  CONSTRAINT roji_words_non_floor_has_person
    CHECK (source = 'event_floor' OR person_seq IS NOT NULL),
  -- 棚に上げたなら理由を 1行書く（印だけ付けて理由が消えるのを防ぐ）。
  CONSTRAINT roji_words_shelf_reason_required
    CHECK (shelved = false OR btrim(coalesce(shelf_reason, '')) <> ''),
  -- 何についての言葉かは、種別と参照をセットで持つ（片方だけを許さない）。
  CONSTRAINT roji_words_about_pair
    CHECK ((about_kind IS NULL) = (about_ref IS NULL))
);

CREATE INDEX IF NOT EXISTS roji_words_person_time_idx ON roji_words (person_seq, occurred_at);
CREATE INDEX IF NOT EXISTS roji_words_source_time_idx ON roji_words (source, occurred_at);
CREATE INDEX IF NOT EXISTS roji_words_about_idx ON roji_words (about_kind, about_ref)
  WHERE about_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS roji_words_shelved_idx ON roji_words (shelved, occurred_at)
  WHERE shelved = true;

-- 原文は不変。書き換え（要約への差し替え・誤字の「修正」）を構造で拒否する。
-- 定義文書 3-5「一字一句そのまま。誤字も改行も直さない」「要約は原文を上書きしない」。
CREATE OR REPLACE FUNCTION roji_words_body_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'roji_words.body は不変です（原文の書き換えは禁止・言葉の置き場の定義）';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS roji_words_body_immutable ON roji_words;
CREATE TRIGGER roji_words_body_immutable
  BEFORE UPDATE ON roji_words
  FOR EACH ROW EXECUTE FUNCTION roji_words_body_is_immutable();

-- ===================================================================
-- RLS（migration 017 / 018 / 019 / 024 / 025 / 029 と同じ姿勢）
--   アプリは service_role_key で接続し RLS をバイパスする。
--   ポリシー無し = 非 service_role 接続に対し deny-all。
-- ===================================================================
ALTER TABLE roji_word_persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE roji_word_person_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE roji_words ENABLE ROW LEVEL SECURITY;
