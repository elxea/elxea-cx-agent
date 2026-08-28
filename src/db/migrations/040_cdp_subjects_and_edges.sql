-- ===================================================================
-- 040: 人の鍵を「借りる」のをやめ、こちらで「発行する」（CDP 統合 Stage 1 / §3-1）
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）§3-1 ID 体系 / §5 E3・E4
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ なぜ要るか ─
--
-- いま「この人は誰か」を表すのに、外から借りた鍵（LINE の userId / Shopify の顧客番号 /
-- Web の一時 ID）をそのまま人の識別子として使っている。借り物なので:
--
--   * 連携のたびに **既存の行を書き換えて**（棚から棚へ荷物を移して）統合するしかない。
--     移送の途中で落ちれば片方に残り、移送表から漏れた置き場（comments 等）は
--     連携後に持ち主が合わなくなる。
--   * 借りた鍵が増えるたびに台帳が増える（いま 2 冊。相互参照ゼロで並存している）。
--
-- 発行制の ID（subject_id）を最初の接触で配れば、連携は「同じ人だと分かった」という
-- **追記 1 行**になり、書き換えという操作そのものが消える。
--
-- ─ 何を作るか ─
--
--   subjects        … 主体そのもの。ULID・不変・無意味（表示しない・URL に出さない）。
--   identity_edges  … 「この主体はこの識別子で観測された」という **観測事実の追記**。
--
-- subject_links（「同一人物と判定した」という判断の追記）は Stage 2。ここでは作らない。
-- 段の境界は「止めても壊れない」ところに置く（設計 §6-1）。
--
-- ─ email を鍵にしない（SEC-1・3 案全会一致）─
--
-- identifier_kind に 'email_hash' は置くが、これは **観測の記録** であって
-- 名寄せの根拠ではない。同一 email であることを理由に主体を結ぶ経路は作らない
-- （042 の解決関数も email_hash の枝を持たない）。生アドレスは決して入れない。
--
-- ─ LINE の 2 つの ID を別 kind で並置する（J-0 非依存）─
--
-- line_messaging_uid（Messaging API の userId）と line_login_uid（LINE Login の sub）は
-- 別物であり、突き合わせ（J-0）が終わっていなくても **別 kind の edge を 2 本持てば
-- それだけで済む**。J-0 完了時は edge が 1 本増えるだけで、スキーマも解決も変わらない。
--
-- ─ 追記専用を DB 側で強制する（E4 / fail-closed）─
--
-- UPDATE / DELETE はトリガで RAISE する。**唯一の例外は GDPR 消去経路**で、
-- 消去関数が `SET LOCAL app.erasure_context = 'on'` を立てたときだけ通る。
-- 例外表をコードの外（DB）に置くのは、「消せます」の約束と「書き換えない」の約束が
-- 両方とも守られていることを、呼び出し側の作法に依存せず言えるようにするため。
--
-- ─ 冪等性 ─ CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
--            DROP TRIGGER IF EXISTS + CREATE TRIGGER。何度当てても同じ。
-- ─ 破壊性 ─ 新規オブジェクトの追加のみ。既存の表・関数・データに一切触れない。
--
-- ─ 適用手順 ─
--
--   MIGRATE_ONLY=040 bash scripts/deploy-prod.sh
--
-- bare `--apply` は使わない（deploy-prod.sh が fail-closed で止める）。
-- ===================================================================

-- ===================================================================
-- 1. subjects — 発行制・不変・無意味な主体 ID
-- ===================================================================
CREATE TABLE IF NOT EXISTS subjects (
  -- ULID（Crockford base32・26 文字）。時刻順に並ぶので index が素直に効く。
  -- 表示しない・URL に出さない（設計 §3-1）。
  subject_id  text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- GDPR 消去で立つ。行そのものは消さない（消去後に残るのは「どの識別子とも
  -- 結びつかない 26 文字」だけで、本人に辿れる情報を含まない）。
  retired_at  timestamptz,
  CONSTRAINT subjects_ulid_form
    CHECK (subject_id ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$')
);

COMMENT ON TABLE subjects IS
  'CDP の主体。発行制・不変・無意味な subject_id（ULID）を持つ唯一の表。'
  ' 借りた鍵（LINE userId / Shopify 顧客番号 / Web 一時 ID）はここに入れない —'
  ' それらは identity_edges 側の観測事実として持つ。'
  ' 表示・URL 露出は禁止（設計 §3-1）。';

COMMENT ON COLUMN subjects.retired_at IS
  'GDPR 消去で立つ。行を消さないのは、customer_events / identity_edges からの'
  ' 外部キーを壊さずに「この主体はもう本人に辿れない」を表すため。'
  ' 消去後は edges が 0 本になるので、残るのは本人に結びつかない 26 文字だけ。';

-- ===================================================================
-- 2. identity_edges — 「この主体はこの識別子で観測された」の追記だけ
-- ===================================================================
CREATE TABLE IF NOT EXISTS identity_edges (
  edge_seq         bigserial PRIMARY KEY,
  subject_id       text NOT NULL REFERENCES subjects(subject_id),
  -- 識別子の種類。**語彙をここで閉じる**（未知の kind は型で拒否する）。
  -- 出来事（customer_events.event_type）は open enum だが、識別子の種類は
  -- 閉じてよい — 新しい種類の鍵が増えるのは設計判断であって、観測の揺らぎではない。
  identifier_kind  text NOT NULL,
  identifier_value text NOT NULL,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  -- どの経路が観測したか（slug）。「なぜこの edge があるのか」を後から言えるようにする。
  observed_by      text NOT NULL,
  CONSTRAINT identity_edges_kind_allowed CHECK (identifier_kind IN (
    -- LINE Messaging API の userId（U...）。
    'line_messaging_uid',
    -- LINE Login の sub。messaging とは別物なので別 kind で並置する（J-0 非依存）。
    'line_login_uid',
    -- Shopify の顧客番号（数字。gid:// 形は入れる前に正規化する）。
    'shopify_customer_id',
    -- Web の匿名来訪者に配る不透明 ID（localStorage 保管・consent="all" のときのみ発行）。
    'web_anonymous_id',
    -- 既存の web セッション ID（conversations.user_id と同じ規約）。
    'web_session_id',
    -- SEC-1: **観測の記録としてのみ**置く。同一 email を根拠に主体を結ぶ経路は作らない。
    -- 生アドレスは決して入れない（入れる側が hash 済みの値だけを渡す）。
    'email_hash'
  )),
  CONSTRAINT identity_edges_value_nonempty CHECK (length(identifier_value) > 0),
  CONSTRAINT identity_edges_observed_by_slug CHECK (observed_by ~ '^[a-z0-9_.\-]{1,64}$')
);

-- 同じ（種類・値・主体）の観測を何度記録しても 1 行に収める。
-- 追記専用なので「上書きで整える」ことができない以上、重複の抑止は index 側に置く。
CREATE UNIQUE INDEX IF NOT EXISTS identity_edges_uniq
  ON identity_edges (identifier_kind, identifier_value, subject_id);

-- 「この鍵はどの主体か」（解決の主経路）。
CREATE INDEX IF NOT EXISTS identity_edges_lookup
  ON identity_edges (identifier_kind, identifier_value);

-- 「この主体はどの鍵で観測されたか」（消去・逆引き）。
CREATE INDEX IF NOT EXISTS identity_edges_subject
  ON identity_edges (subject_id);

COMMENT ON TABLE identity_edges IS
  '「この主体はこの識別子で観測された」という事実の追記だけを持つ台帳。'
  ' 既存行の書き換えは行わない（E4: UPDATE/DELETE はトリガで拒否。例外は GDPR 消去経路のみ）。'
  ' ⚠ email_hash は観測の記録であって名寄せの根拠ではない（SEC-1）。'
  ' 同一 email を理由に主体を結ぶ経路は 042 の解決関数にも存在しない。';

-- ===================================================================
-- 3. E4 — 追記専用を DB 側で強制する
--
--    例外表はここ 1 か所にしか無い: `app.erasure_context = 'on'`。
--    これを立てられるのは消去関数（042 の roji_erase_person）だけで、
--    SET LOCAL 相当（set_config(..., is_local => true)）なのでトランザクションを
--    抜ければ自動的に外れる。呼び出し側が立てっぱなしにすることはできない。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_erasure_context_active() RETURNS boolean AS $$
  SELECT coalesce(current_setting('app.erasure_context', true), '') = 'on';
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION cdp_erasure_context_active() IS
  'E4 の唯一の例外表。GDPR 消去経路が set_config(''app.erasure_context'', ''on'', true) を'
  ' 立てているときだけ true。第 2 引数 true（missing_ok）なので未設定でも例外にならない。';

CREATE OR REPLACE FUNCTION cdp_append_only_guard() RETURNS trigger AS $$
BEGIN
  IF cdp_erasure_context_active() THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION
    'append-only violation: % on public.% は許可されていない（E4）。'
    ' この表は追記専用で、書き換え・削除はできない。'
    ' 唯一の例外は GDPR 消去経路（roji_erase_person）で、そこだけが'
    ' app.erasure_context を立てて通る。',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS identity_edges_append_only ON identity_edges;
CREATE TRIGGER identity_edges_append_only
  BEFORE UPDATE OR DELETE ON identity_edges
  FOR EACH ROW EXECUTE FUNCTION cdp_append_only_guard();

-- subjects は「retired_at を立てる」という 1 つの UPDATE だけを許す。
-- それ以外の列は不変で、DELETE は消去経路からのみ。
CREATE OR REPLACE FUNCTION cdp_subjects_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF cdp_erasure_context_active() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'append-only violation: DELETE on public.subjects は許可されていない（E4）。'
      ' 消去は roji_erase_person 経由で行う（retired_at を立て、edges を消す）。';
  END IF;

  IF NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'subjects.subject_id / created_at は不変（E4）。発行した ID は付け替えない。';
  END IF;

  IF NEW.retired_at IS DISTINCT FROM OLD.retired_at
     AND NOT cdp_erasure_context_active() THEN
    RAISE EXCEPTION
      'subjects.retired_at は GDPR 消去経路からのみ立てられる（E4 の例外表）。';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subjects_append_only ON subjects;
CREATE TRIGGER subjects_append_only
  BEFORE UPDATE OR DELETE ON subjects
  FOR EACH ROW EXECUTE FUNCTION cdp_subjects_guard();

-- ===================================================================
-- 4. RLS — 017 で有効化した方針に揃える（service_role のみが触る）
--
--    Worker は service role key で接続するので RLS は素通りする。
--    anon / authenticated から見えないようにするために有効化だけしておく。
-- ===================================================================
ALTER TABLE subjects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_edges ENABLE ROW LEVEL SECURITY;
