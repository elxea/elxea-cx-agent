-- ===================================================================
-- 049: 追記型の台帳に「取り消し」を入れる — 誤った観測・誤った判断を、
--      1 バイトも書き換えずに読み口から外せるようにする
--      （CDP 統合 Stage 2 / 040・041・043・046・047 の続き）
-- ===================================================================
--
-- 一次入力（設計の正本）:
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
-- 是正の一次調査と適用記録（本番 2026-08-31）:
--   https://app.notion.com/p/3cc70c9d064c814c8ba3d70f4812d199
--
-- ─ ⚠ この migration は本番に適用済みである（2026-08-31 19:30 JST）─
--
--   本番へは、この番号のファイルが存在しない時点で raw SQL として
--   1 トランザクションで適用され COMMIT 済みである（接続先の HARD ASSERT は
--   scripts/migrate.ts の PROD_REF と同じ値を使って通した）。
--   よって本ファイルの役割は 2 つある:
--
--     (1) **未適用の環境（staging / 新規構築）で同じ状態に到達させる。**
--     (2) **適用済みの本番を台帳（schema_migrations）に後追いで載せる。**
--         migrate.ts の `--baseline`（実在検知 → register）が
--         scripts/migrate.ts の INTROSPECTION["049_cdp_identity_retraction"] の
--         sentinel を実在確認し、applied と判定して版を登録する。
--
--   この 2 つが同じ 1 ファイルで成り立つために、本 migration は **全文が冪等**で
--   なければならない。適用済みの本番でもう一度流しても no-op になること
--   （CREATE TABLE IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS /
--    CREATE OR REPLACE VIEW / CREATE OR REPLACE FUNCTION /
--    DROP TRIGGER IF EXISTS → CREATE TRIGGER /
--    ENABLE ROW LEVEL SECURITY / DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT）を
--   tests/unit/cdp-identity-retraction.test.ts が機械で固定している。
--
-- ─ この migration が「する」こと / 「しない」こと ─
--
--   する : 取り消しの台帳 2 つ（identity_edge_retractions / subject_link_retractions）、
--          生きている観測・判断の読み口 2 つ（identity_edges_live / subject_links_live）、
--          解決の 4 関数の _live への付け替え、basis の語彙 2 つ、監視の読み口 1 つ。
--   しない: **既存の表・行に一切触れない。** identity_edges / subject_links /
--          subjects / customer_events の行は 1 バイトも変えない。
--   しない: **消去と検算の経路を _live にしない。** roji_person_key_map /
--          roji_resolve_identity / roji_erasure_residue は元の表を読む。
--          取り消した行にも生値が残っているので、消すときは必ず含める。
--   しない: **データを直さない。** この migration 単体では本番の読み出しは
--          1 ミリも動かない（取り消しの行が 0 件のうちは _live は元の表と同一集合）。
--
-- ─ 本番のデータ是正（§B）をこのファイルに入れていない理由 ─
--
--   2026-08-31 の本番適用では、下記のスキーマ（本ファイルの内容）と併せて
--   **本番固有のデータ是正 3 件**を同じトランザクションで流している:
--
--     B-1  edge_seq=6（Shopify GID を web_session_id の kind で登録してしまった観測）を
--          reason='malformed_identifier' / supersedes_with_edge_seq=2 で取り消す
--     B-2  孤立した主体を正しい人へ戻す link を 1 本足す（basis='identifier_correction'）
--     B-3  割れた LINE 主体（messaging / login で値が同一）を結ぶ link を 1 本足す
--          （basis='line_uid_identity'）
--     B-4  1 成分に Shopify 顧客 ID が 2 件ある件 → **未適用**（Setaka 判断待ち）
--
--   これらは **本番の 8 行の identity_edges に対する ULID 直指定の是正**であり、
--   migration に載せてはならない。載せると:
--     - 新規構築 / staging では対象行が存在せず、前提確認の DO ブロックが例外で止まる
--     - 「スキーマの版」と「その環境固有のデータ修理」が同じ版番号に混ざる
--   よって §B は migration ではなく **1 回限りの運用 SQL** として扱う。全文は
--   deliverables/cdp-identity-repair-20260831.sql の §B に残してある（監査用）。
--
--   本番の適用後検算（同一 tx 内・1 つでもずれたら ROLLBACK する実装で全一致）:
--     連結成分 4→2 / 孤立主体 1→0 / LINE の鍵から辿れる会話 8→28 /
--     in_segment=true 0→0 / cdp_stage2_parity() の in_agreement=true 維持。
--
-- ─ 既知の欠陥（050 で是正する）─
--
--   下記 A-5 の cdp_retraction_summary() の subjects_without_live_edges は、
--   live な観測が 1 つも無い主体を数えるが **live な link を見ていない**。
--   B-2 のように「取り消した主体を link で正しい人に戻した」場合、その主体は
--   ちゃんと辿れるのに 1 と数えられる（本番で恒常 1 を返す偽陽性）。
--   **本ファイルは本番適用済みなので書き換えない。** 是正は 050 で
--   CREATE OR REPLACE として足す（043 を 044 で是正したのと同じ流儀）。
--
-- ─ 前提 ─ 040 / 041 / 042 / 043 / 046 / 047 が当たっていること。
-- ===================================================================

-- -------------------------------------------------------------------
-- A-1. 取り消しの台帳 2 つ (どちらも追記専用)
-- -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identity_edge_retractions (
  retraction_seq bigserial PRIMARY KEY,
  -- ⚠ ON DELETE CASCADE は必須。GDPR 消去 (042) は identity_edges の行を
  --   **DELETE する**ので、CASCADE が無いと FK が消去そのものを止める
  --   (「消せます」の約束が、データを直す仕組みのせいで破れる)。
  edge_seq       bigint NOT NULL REFERENCES identity_edges(edge_seq) ON DELETE CASCADE,
  -- なぜ取り消すか。**ここに無い理由では取り消せない** (basis と同じ規律)。
  reason         text NOT NULL,
  -- 正しい観測がどれか (分かるときだけ)。「間違いだった」と「正しくはこれ」を分けて持つ。
  supersedes_with_edge_seq bigint REFERENCES identity_edges(edge_seq) ON DELETE SET NULL,
  retracted_at   timestamptz NOT NULL DEFAULT now(),
  retracted_by   text NOT NULL,
  CONSTRAINT identity_edge_retractions_reason_allowed CHECK (reason IN (
    -- 値の形が kind と合っていない (観測そのものが誤り)。
    'malformed_identifier',
    -- 同じ事実が既に正しい kind で別の行として記録されている。
    'duplicate_of_existing',
    -- 運用者判断。**Setaka 承認済みのものだけ**。
    'operator_correction'
  )),
  CONSTRAINT identity_edge_retractions_by_slug CHECK (retracted_by ~ '^[a-z0-9_.\-]{1,64}$'),
  -- 自分自身を「正しい観測」にできない。
  CONSTRAINT identity_edge_retractions_not_self CHECK (
    supersedes_with_edge_seq IS NULL OR supersedes_with_edge_seq <> edge_seq)
);

-- 1 つの観測に取り消しは 1 回まで (ON CONFLICT DO NOTHING で冪等に流せる)。
CREATE UNIQUE INDEX IF NOT EXISTS identity_edge_retractions_uniq
  ON identity_edge_retractions (edge_seq);

COMMENT ON TABLE identity_edge_retractions IS
  '「この観測は誤りだった」という追記。元の identity_edges 行は 1 バイトも変えない'
  ' (E4 の追記専用をそのまま守る)。解決の読み口はこの表を見て除くが、'
  ' **GDPR 消去と検算は元の表を見る** (取り消した行の生値も必ず消す)。';

CREATE TABLE IF NOT EXISTS subject_link_retractions (
  retraction_seq bigserial PRIMARY KEY,
  link_seq       bigint NOT NULL REFERENCES subject_links(link_seq) ON DELETE CASCADE,
  reason         text NOT NULL,
  retracted_at   timestamptz NOT NULL DEFAULT now(),
  retracted_by   text NOT NULL,
  CONSTRAINT subject_link_retractions_reason_allowed CHECK (reason IN (
    -- 判断の根拠にした旧台帳の行が、後から別の値で上書きされていた。
    'stale_ledger_source',
    -- 別人だったことが分かった。
    'wrong_person',
    -- 運用者判断。**Setaka 承認済みのものだけ**。
    'operator_correction'
  )),
  CONSTRAINT subject_link_retractions_by_slug CHECK (retracted_by ~ '^[a-z0-9_.\-]{1,64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS subject_link_retractions_uniq
  ON subject_link_retractions (link_seq);

COMMENT ON TABLE subject_link_retractions IS
  '「この判断は誤りだった」という追記。元の subject_links 行は変えない。'
  ' 取り消しを取り消したいときは、新しい link を正しい basis で足し直す'
  ' (取り消しの取り消しという操作は作らない — 履歴が読めなくなる)。';

-- 取り消しそのものも追記専用 (040 のガードを流用。例外表は増やさない)。
DROP TRIGGER IF EXISTS identity_edge_retractions_append_only ON identity_edge_retractions;
CREATE TRIGGER identity_edge_retractions_append_only
  BEFORE UPDATE OR DELETE ON identity_edge_retractions
  FOR EACH ROW EXECUTE FUNCTION cdp_append_only_guard();

DROP TRIGGER IF EXISTS subject_link_retractions_append_only ON subject_link_retractions;
CREATE TRIGGER subject_link_retractions_append_only
  BEFORE UPDATE OR DELETE ON subject_link_retractions
  FOR EACH ROW EXECUTE FUNCTION cdp_append_only_guard();

ALTER TABLE identity_edge_retractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_link_retractions  ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------------------
-- A-2. 「生きている観測 / 生きている判断」の読み口
--
--      名前を分けるのは、**どちらを読むべきかを呼び出し側に選ばせる**ため。
--      解決 (誰なのか) は _live を読む。消去と検算は元の表を読む。
--      同じ表を読んでいるように見えて意味が違う、という状態を作らない。
-- -------------------------------------------------------------------

CREATE OR REPLACE VIEW identity_edges_live AS
  SELECT e.*
    FROM identity_edges e
   WHERE NOT EXISTS (
     SELECT 1 FROM identity_edge_retractions r WHERE r.edge_seq = e.edge_seq);

COMMENT ON VIEW identity_edges_live IS
  '取り消されていない観測だけ。**解決の読み口はこちらを使う**。'
  ' GDPR 消去 (roji_person_key_map 経由) と孤児検査は元の identity_edges を使う'
  ' — 取り消した行にも生値が残っているので、消すときは必ず含める。';

CREATE OR REPLACE VIEW subject_links_live AS
  SELECT l.*
    FROM subject_links l
   WHERE NOT EXISTS (
     SELECT 1 FROM subject_link_retractions r WHERE r.link_seq = l.link_seq);

-- -------------------------------------------------------------------
-- A-3. 解決の 4 本を _live に付け替える
--
--      置き換えるのは「誰なのかを解く」側だけ。042/043 の消去
--      (roji_person_key_map / roji_resolve_identity / roji_erasure_residue) は
--      **触らない** — 消去は取り消された行も消さなければならない。
-- -------------------------------------------------------------------

-- (i) 連結成分。043 の定義から subject_links → subject_links_live だけを替える。
CREATE OR REPLACE FUNCTION cdp_subject_component(p_subject_id text)
RETURNS text[] AS $$
DECLARE
  v_members text[];
BEGIN
  IF p_subject_id IS NULL OR p_subject_id = '' THEN
    RETURN ARRAY[]::text[];
  END IF;

  WITH RECURSIVE walk(subject_id) AS (
    SELECT p_subject_id
    UNION
    SELECT CASE WHEN l.subject_a = w.subject_id THEN l.subject_b ELSE l.subject_a END
      FROM walk w
      JOIN subject_links_live l          -- 049: 取り消された判断は辿らない
        ON l.subject_a = w.subject_id OR l.subject_b = w.subject_id
  )
  SELECT coalesce(array_agg(DISTINCT subject_id), ARRAY[]::text[])
    INTO v_members
    FROM walk;

  IF coalesce(array_length(v_members, 1), 0) > 500 THEN
    RAISE WARNING 'cdp_subject_component: 連結成分が % 件に達している（link を疑うこと）',
      array_length(v_members, 1);
  END IF;

  RETURN v_members;
END;
$$ LANGUAGE plpgsql STABLE;

-- (ii) 横断読み出しの読み口。043 の定義から identity_edges → identity_edges_live、
--      subject_links → subject_links_live に替えるだけ。
--
--      ⚠ 併せて 1 つ既存の欠陥を直している (下記「既知の欠陥」参照):
--        identifier_total は行数を数え、identifier_values は値でまとめるので、
--        **同じ値が 2 つの kind で観測されている人は truncated が偽で true になる**。
--        本番の L (messaging と login で同じ値) がまさにこれに当たるので、
--        total 側も DISTINCT identifier_value で数えるよう揃える。
CREATE OR REPLACE FUNCTION cdp_canonical_identifiers(
  p_kind      text,
  p_value     text,
  p_max_refs  integer DEFAULT 50
) RETURNS jsonb AS $$
DECLARE
  v_seed      text;
  v_members   text[];
  v_refs      text[];
  v_total     integer := 0;
  v_links     integer := 0;
  v_max       integer := greatest(coalesce(p_max_refs, 50), 1);
BEGIN
  IF p_kind IS NULL OR p_value IS NULL OR p_value = '' THEN
    RETURN jsonb_build_object('found', false, 'reason', 'identifier_empty');
  END IF;
  IF p_kind = 'email_hash' THEN
    RETURN jsonb_build_object('found', false, 'reason', 'identifier_kind_not_resolvable');
  END IF;

  SELECT e.subject_id INTO v_seed
    FROM identity_edges_live e
   WHERE e.identifier_kind = p_kind AND e.identifier_value = p_value
   LIMIT 1;

  IF v_seed IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'subject_not_found');
  END IF;

  v_members := cdp_subject_component(v_seed);

  SELECT count(*) INTO v_links
    FROM subject_links_live l
   WHERE l.subject_a = ANY (v_members) OR l.subject_b = ANY (v_members);

  -- 049: 行数ではなく **値の種類**で数える (truncated の偽陽性を消す)。
  SELECT count(DISTINCT e.identifier_value) INTO v_total
    FROM identity_edges_live e
   WHERE e.subject_id = ANY (v_members)
     AND e.identifier_kind <> 'email_hash';

  SELECT coalesce(array_agg(v ORDER BY t DESC), ARRAY[]::text[]) INTO v_refs FROM (
    SELECT e.identifier_value AS v, max(e.observed_at) AS t
      FROM identity_edges_live e
     WHERE e.subject_id = ANY (v_members)
       AND e.identifier_kind <> 'email_hash'
     GROUP BY e.identifier_value
     ORDER BY max(e.observed_at) DESC
     LIMIT v_max
  ) q;

  RETURN jsonb_build_object(
    'found',             true,
    'canonical_id',      (SELECT min(m) FROM unnest(v_members) AS m),
    'member_count',      coalesce(array_length(v_members, 1), 0),
    'link_count',        v_links,
    'identifier_values', to_jsonb(v_refs),
    'identifier_total',  v_total,
    'truncated',         v_total > coalesce(array_length(v_refs, 1), 0)
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- (iii) J-4 ガード。取り消された観測で「LINE が 2 本ある」と誤判定しないようにする。
CREATE OR REPLACE FUNCTION cdp_subject_links_j4_guard() RETURNS trigger AS $$
DECLARE
  v_members text[];
  v_line    integer;
BEGIN
  v_members := cdp_subject_component(NEW.subject_a) || cdp_subject_component(NEW.subject_b);

  SELECT count(DISTINCT e.identifier_value) INTO v_line
    FROM identity_edges_live e                 -- 049
   WHERE e.subject_id = ANY (v_members)
     AND e.identifier_kind = 'line_messaging_uid';

  IF v_line > 1 THEN
    RAISE EXCEPTION
      'J-4 violation: 1 人の Shopify 顧客に複数の LINE を束縛することはできない'
      '（この link を足すと 1 つの連結成分に LINE トーク ID が % 本入る）。'
      ' 世帯共有（N:1）は 2026-08-24 の決裁 J-4 で恒久 deny。', v_line
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (iv) 配信の宛先の派生 (046)。取り消された LINE 観測から宛先を作らない。
CREATE OR REPLACE FUNCTION cdp_l1_derive_delivery_identity(p_limit integer DEFAULT 5000)
RETURNS jsonb AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH cand AS (
    SELECT DISTINCT ON (cdp_canonical_subject(e.subject_id))
           cdp_canonical_subject(e.subject_id) AS subject_id,
           e.identifier_value                  AS line_user_id
      FROM identity_edges_live e               -- 049
      JOIN subjects s ON s.subject_id = e.subject_id AND s.retired_at IS NULL
     WHERE e.identifier_kind = 'line_messaging_uid'
       AND e.identifier_value ~ '^U[0-9a-f]{32}$'
     ORDER BY cdp_canonical_subject(e.subject_id), e.edge_seq
     LIMIT greatest(coalesce(p_limit, 5000), 1)
  ), ins AS (
    INSERT INTO delivery_identity (subject_id, line_user_id, source, updated_at)
    SELECT c.subject_id, c.line_user_id, 'cdp.l1-derive', now()
      FROM cand c
     WHERE NOT EXISTS (SELECT 1 FROM delivery_identity d WHERE d.subject_id = c.subject_id)
       AND NOT EXISTS (SELECT 1 FROM delivery_identity d WHERE d.line_user_id = c.line_user_id)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------------
-- A-4. 是正で使う basis を 2 つ増やす (047 と同じ作法で、意味を明記する)
--
--      043 は「ここに値を足すことは『その根拠で人を結んでよい』という決定そのもの」
--      と書いている。よって足す値の意味を正確に言う。
--
--      'line_uid_identity'
--        意味: line_messaging_uid と line_login_uid の **生値がバイト単位で同一**
--              であることを根拠に結ぶ。LINE Login と Messaging が同じプロバイダー
--              配下にあるとき sub == userId になるという LINE の仕様に基づく。
--        SEC-1 との関係: email_equality を拒む理由は「メールが一致するだけで
--              **他人が** 人を結べる」ことにある。LINE userId は webhook 署名 /
--              id_token 検証を通った値しか identity_edges に入らないので、
--              外から新しい結び付きを作れるようにはならない。
--
--      'identifier_correction'
--        意味: 同じ観測が **誤った kind で別主体を立ててしまった**ので、正しい主体に
--              戻す。identity_edge_retractions に対応する取り消し行があることが前提。
--        書ける経路: 運用者スクリプトのみ (通常のアプリ経路からは書かない)。
-- -------------------------------------------------------------------
ALTER TABLE subject_links DROP CONSTRAINT IF EXISTS subject_links_basis_allowed;
ALTER TABLE subject_links ADD CONSTRAINT subject_links_basis_allowed CHECK (basis IN (
  'liff_id_token',
  'line_account_link',
  'anonymous_promotion',
  'legacy_ledger_backfill',
  'line_uid_identity',      -- 049
  'identifier_correction'   -- 049
));

-- -------------------------------------------------------------------
-- A-5. 取り消しが増えていないかを毎日数える (048 の parity に相乗り・読み取り専用)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cdp_retraction_summary()
RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'edges_total',        (SELECT count(*) FROM identity_edges),
    'edges_retracted',    (SELECT count(*) FROM identity_edge_retractions),
    'links_total',        (SELECT count(*) FROM subject_links),
    'links_retracted',    (SELECT count(*) FROM subject_link_retractions),
    -- 取り消されたのに live な観測が 1 つも残っていない主体
    -- (＝ 誰とも結ばれない主体になっていないか)。0 であるべき。
    'subjects_without_live_edges', (
      SELECT count(*) FROM subjects s
       WHERE s.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM identity_edges_live e WHERE e.subject_id = s.subject_id)),
    -- 1 成分に Shopify 顧客 ID が 2 件以上 (人の取り違えの見張り)。
    --
    -- ⚠ 計上単位は **成分 1 つにつき 1** (QA 指摘 2026-08-31)。
    --   旧版は「live な link に出てくる主体」を走査して主体ごとに 1 数えていたので、
    --   同じ 1 成分を member 数だけ重複計上していた (本番の P' は member 7 なので
    --   「1 件」と読むべき歪みが「7 件」と出る)。名前が components である以上、
    --   数えるのは成分でなければならない。成分の代表は 043 の canonical と同じ
    --   min(ULID) を使う。
    --   併せて母集団を「link に出てくる主体」から「retired でない全主体」に広げる。
    --   1 主体が複数 kind の鍵を持てる以上、link が 1 本も無い単独主体でも
    --   Shopify 顧客 ID を 2 件持つことは構造的に起こりうるため。
    'multi_shopify_components', (
      SELECT count(*) FROM (
        SELECT DISTINCT (SELECT min(m) FROM unnest(cdp_subject_component(s.subject_id)) AS m)
                 AS component_key
          FROM subjects s
         WHERE s.retired_at IS NULL
           AND (SELECT count(DISTINCT e.identifier_value)
                  FROM identity_edges_live e
                 WHERE e.subject_id = ANY (cdp_subject_component(s.subject_id))
                   AND e.identifier_kind = 'shopify_customer_id') > 1
      ) q)
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION cdp_retraction_summary() IS
  '取り消しの数と、取り消した結果できた歪み (live な鍵を 1 つも持たない主体 /'
  ' 1 人に見えて Shopify 顧客が 2 件ある成分) を数える。読み取り専用。'
  ' 日次 tick から 1 行ログに残す。';
