-- ===================================================================
-- 043: 「同じ人だ」と分かったことを、書き換えではなく 1 行の追記にする
--      （CDP 統合 Stage 2 / §3-1 / §6-1 Stage 2 / §4 C-1（★11））
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）§3-1 ID 体系 / §5 E4・E5 /
--   §6-1 Stage 2 / §4 C-1（★11 LINE 会話の断線）
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ いま何が壊れているか（★11 / C-1）─
--
-- LIFF 連携（src/routes/identity.ts）と LINE 純正 Account Link（src/lib/account-link.ts）は
-- customer_linkages にしか行を書かない。ところが会話の横断読み出し
-- （src/lib/supabase.ts の getCrossChannelMessages）と、そもそも「横断して読むか」を
-- 決める resolveUnifiedUserId（src/lib/identity.ts）は user_identity_map しか引かない。
-- 台帳が 2 冊あって相互参照が無いので、**連携したのに LINE の会話が統合ビューに出ない**。
--
-- 台帳を 1 冊に寄せるのが恒久解で、その 1 冊目がここで作る subject_links である。
--
-- ─ なぜ「追記」なのか ─
--
-- いまの統合は「棚から棚へ荷物を移す」形（mergeLineUserIntoShopify /
-- mergeLineIdentityIntoShopify / mergeAnonymousSession）で、移送の途中で落ちれば
-- 片方に残り、移送表から漏れた置き場（comments 等）は持ち主が合わなくなる。
-- 「同じ人だと判定した」を **1 行足すだけ** にすれば、移送という操作自体が消える。
--
-- ─ 何を作るか ─
--
--   subject_links      … 「この主体とこの主体は同じ人」という **判断の追記**。
--   cdp_subject_component / cdp_canonical_subject / cdp_canonical_identifiers
--                      … 追記された link の **連結成分**を解いて「1 人」を返す読み口。
--   delivery_identity  … 生 LINE userId の置き場（E5 の行き先。Stage 2 では派生・
--                        唯一化は Stage 5）。
--
-- ─ basis はホワイトリスト（email_equality を型で拒否 = SEC-1 の継承）─
--
-- 「なぜ同じ人だと判定したか」を必ず持たせ、値を CHECK で閉じる。
-- **email_equality はこの語彙に無い**。メールが同じことを根拠に人を結ぶのは
-- アカウント乗っ取り経路であり（src/lib/identity.ts の [SEC-1] コメントが実例を
-- 書いている）、コードの作法ではなく **型で** 不可能にする。
-- ここに値を足すことは「その根拠で人を結んでよい」という決定そのものである。
--
-- ─ J-4（1 Shopify 顧客に複数 LINE を束縛しない）─
--
-- 2026-08-24 の決裁 J-4 は世帯共有（N:1）を恒久 deny とした。現行の
-- routes/identity.ts は customer_linkages の UNIQUE 衝突を 409 に倒すことでこれを
-- 守っている。**スキーマ（customer_linkages）は触らない**まま、link 側でも同じ
-- 不変条件を保つ: 挿入時に「その link を足すと 1 つの連結成分に 2 つ以上の
-- LINE トーク ID が入る」なら RAISE する（下の cdp_subject_links_j4_guard）。
-- J-4 が将来覆ったら、このトリガを落とすだけでスキーマ変更は要らない。
--
-- ─ E4（追記専用）─
--
-- UPDATE / DELETE は 040 の cdp_append_only_guard をそのまま付ける。
-- 唯一の例外は GDPR 消去経路（app.erasure_context）。例外表は 040 の 1 か所のまま
-- 増やさない。
--
-- ─ 消去（GDPR）に自動で載ること ─
--
-- 037/042 の「人を指す列の名前を語彙として持ち、その列を持つ表を毎回列挙する」に
-- subject_a / subject_b を足す。列ごとに 1 回ずつ消すので、どちら側に居ても消える。
-- delivery_identity は subject_id と line_user_id を持つのでそのまま列挙に載る。
-- さらに roji_resolve_identity を link の連結成分まで広げる — 広げないと、
-- 「LINE で消してくれ」と言われたときに link の向こう側の主体が残る。
--
-- ⚠ 040 / 041 / 042 が先に当たっていること。
-- ─ 冪等性 ─ CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS + CREATE TRIGGER。
--            何度当てても同じ。
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認（順序を間違えると消去がまるごと落ちる）
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.subjects') IS NULL OR to_regclass('public.identity_edges') IS NULL THEN
    RAISE EXCEPTION '043: subjects / identity_edges がまだ無い。040 を先に当てること。';
  END IF;
  IF to_regclass('public.customer_events') IS NULL THEN
    RAISE EXCEPTION '043: customer_events がまだ無い。041 を先に当てること。';
  END IF;
  IF to_regproc('public.roji_person_key_map') IS NULL THEN
    RAISE EXCEPTION
      '043: roji_person_key_map が無い。042 を先に当てること'
      '（本 migration はこの列挙に subject_a / subject_b を足す形で消去に載せる）。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. subject_links — 「同じ人だと判定した」の追記だけ
-- ===================================================================
CREATE TABLE IF NOT EXISTS subject_links (
  link_seq    bigserial PRIMARY KEY,
  -- 無向の辺を 1 行に正規化する（下の subject_links_ordered が a < b を強制）。
  -- 正規化しないと (A,B) と (B,A) が別行になり、「同じ判断が 2 回記録された」のか
  -- 「向きが違うだけ」なのかを区別できなくなる。
  subject_a   text NOT NULL REFERENCES subjects(subject_id),
  subject_b   text NOT NULL REFERENCES subjects(subject_id),
  -- なぜ同じ人だと判定したか。**ここに無い根拠では結べない**（下の CHECK）。
  basis       text NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  -- どの経路が判定したか（slug）。edges の observed_by と同じ規約。
  observed_by text NOT NULL,

  CONSTRAINT subject_links_basis_allowed CHECK (basis IN (
    -- LIFF: LINE 署名済み id_token の sub（LINE の verify API で検証済み）と、
    -- web-app のサーバ認証済み Shopify セッション（requireAuth）由来の顧客番号。
    'liff_id_token',
    -- LINE 純正 Account Link: single-use nonce を消費できた側だけが自社ユーザーを確定する。
    'line_account_link',
    -- 匿名 web セッションの昇格: 認証済みの本人が「このセッションは自分だ」と申告した経路。
    'anonymous_promotion'
    --
    -- ⚠ 'email_equality' はここに **無い**（SEC-1）。メール等値で人を結ぶのは
    --   乗っ取り経路であり（identity.ts の [SEC-1] が実例を書いている）、
    --   コードの作法ではなく型で不可能にしてある。足すことは決定そのものである。
  )),
  -- 無向辺の正規化。等しい主体を自分自身に結ぶ行（a = b）もこれで入らない。
  --
  -- ⚠ COLLATE "C" を明示するのは、並べ替えの規則を **呼び出し側（TypeScript の
  --   orderPair）と一致させる**ため。DB 既定のロケール照合（en_US.UTF-8 等）は
  --   大文字小文字や記号の扱いが JS の比較（UTF-16 コード単位順）と一致する保証が無い。
  --   ULID は [0-9A-Z] だけなので現状はどちらでも同じ順になるが、「たまたま同じ」に
  --   依存すると、照合順序を変えた日に **正規化の向きが 2 つになる**（同じ 2 主体が
  --   2 行入る）。C 照合はバイト順で環境に依存しないので、そこを固定する。
  CONSTRAINT subject_links_ordered CHECK (subject_a COLLATE "C" < subject_b COLLATE "C"),
  CONSTRAINT subject_links_observed_by_slug CHECK (observed_by ~ '^[a-z0-9_.\-]{1,64}$')
);

-- 同じ 2 主体を同じ根拠で 2 回記録しても 1 行に収まる。
-- **根拠が違えば別の行**（LIFF で結んだ人が後で Account Link も通した、は 2 つの事実）。
-- ⚠ 呼び出し側は ON CONFLICT DO NOTHING を使うこと。DO UPDATE は既存行の UPDATE なので
--   E4 のトリガに掛かって落ちる。
CREATE UNIQUE INDEX IF NOT EXISTS subject_links_uniq
  ON subject_links (subject_a, subject_b, basis);

-- 連結成分を解くときに両方向から引く。
CREATE INDEX IF NOT EXISTS subject_links_a ON subject_links (subject_a);
CREATE INDEX IF NOT EXISTS subject_links_b ON subject_links (subject_b);

COMMENT ON TABLE subject_links IS
  '「この主体とこの主体は同じ人だ」という判断の追記だけを持つ台帳。'
  ' 既存行の書き換えは行わない（E4: UPDATE/DELETE はトリガで拒否。例外は GDPR 消去経路のみ）。'
  ' basis はホワイトリストで閉じており email_equality を型で拒否する（SEC-1）。'
  ' 向きは持たない（subject_a < subject_b に正規化）。';

COMMENT ON COLUMN subject_links.basis IS
  'なぜ同じ人だと判定したか。CHECK で閉じている。'
  ' ここに値を足すことは「その根拠で人を結んでよい」という決定であり、'
  ' email_equality を足すことは SEC-1 を取り消すことを意味する。';

-- ===================================================================
-- 2. E4 — 追記専用（040 のガードをそのまま付ける。例外表は増やさない）
-- ===================================================================
DROP TRIGGER IF EXISTS subject_links_append_only ON subject_links;
CREATE TRIGGER subject_links_append_only
  BEFORE UPDATE OR DELETE ON subject_links
  FOR EACH ROW EXECUTE FUNCTION cdp_append_only_guard();

-- 主体が retire 済み（消去済み）なら新しい link は結べない。
-- 041 の cdp_reject_retired_subject は NEW.subject_id を見るので、こちらは 2 列版を作る。
CREATE OR REPLACE FUNCTION cdp_reject_retired_link() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM subjects
     WHERE subject_id IN (NEW.subject_a, NEW.subject_b)
       AND retired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'retired subject: 消去済みの主体を結び直すことはできない'
      '（消去後に同じ鍵で再来訪した人には、新しい主体が発行される）。';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subject_links_no_retired ON subject_links;
CREATE TRIGGER subject_links_no_retired
  BEFORE INSERT ON subject_links
  FOR EACH ROW EXECUTE FUNCTION cdp_reject_retired_link();

-- ===================================================================
-- 3. 連結成分（canonical 解決）
--
--    「この主体と同じ人だと判定された主体の全部」を返す。追記された link を
--    無向グラフとして辿るだけで、materialize（作り置き）は持たない。
--
--    ⚠ 作り置きを置かない理由（設計 §9 の materialize 遅延への回答）:
--      設計は「materialize + 連携完了時の即時再解決」を緩和策として挙げているが、
--      作り置きは (a) 古くなる窓ができる (b) 読み手がいないうちは E7（読み手ゼロの
--      データを作れない）に触れる、の 2 つを同時に抱える。毎回辿る形なら
--      **窓そのものが存在しない**（＝「連携完了時の即時再解決」は構造的に常に成立）。
--      本番連携 0 件・連結成分は数個という現在の規模では毎回辿るほうが安く、
--      速さが問題になったときに作り置きを足す余地は残る（読み口の形は変わらない）。
--      規模の監視は日次の突合ジョブ（src/lib/cdp/stage2-parity.ts）が
--      最大連結成分サイズを毎日 1 行ログに出すことで行う。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_subject_component(p_subject_id text)
RETURNS text[] AS $$
DECLARE
  v_members text[];
BEGIN
  IF p_subject_id IS NULL OR p_subject_id = '' THEN
    RETURN ARRAY[]::text[];
  END IF;

  -- UNION（UNION ALL ではない）なので、閉路があっても必ず止まる。
  WITH RECURSIVE walk(subject_id) AS (
    SELECT p_subject_id
    UNION
    SELECT CASE WHEN l.subject_a = w.subject_id THEN l.subject_b ELSE l.subject_a END
      FROM walk w
      JOIN subject_links l
        ON l.subject_a = w.subject_id OR l.subject_b = w.subject_id
  )
  SELECT coalesce(array_agg(DISTINCT subject_id), ARRAY[]::text[])
    INTO v_members
    FROM walk;

  -- 連結成分がここまで大きいのは、まず link が間違っている（J-4 ガードは LINE を
  -- 1 本に抑えるが、匿名セッションの昇格は積み上がりうる）。黙って重くならないよう
  -- 気づける形にする。返り値は削らない（削ると「消えた」と区別がつかなくなる）。
  IF coalesce(array_length(v_members, 1), 0) > 500 THEN
    RAISE WARNING 'cdp_subject_component: 連結成分が % 件に達している（link を疑うこと）',
      array_length(v_members, 1);
  END IF;

  RETURN v_members;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_subject_component(text) IS
  '追記された subject_links を無向グラフとして辿り、同じ人と判定された主体を全部返す。'
  ' 作り置きを持たないので、link を足した次の読み出しから必ず反映される。';

-- 連結成分の代表（= 一番小さい subject_id）。ULID は時刻順なので「最初に発行された主体」。
-- 代表を決め打ちで持つのは、突合や台帳で「1 人を 1 つの文字列で言う」ときだけに使う。
-- 読み出しは代表ではなく **成分そのもの**を使う（代表 1 つでは会話が引けない）。
CREATE OR REPLACE FUNCTION cdp_canonical_subject(p_subject_id text)
RETURNS text AS $$
  SELECT min(m) FROM unnest(cdp_subject_component(p_subject_id)) AS m;
$$ LANGUAGE sql STABLE;

-- ===================================================================
-- 4. 読み口 — 「この鍵の人」の識別子を全部返す（★11 の恒久解の中心）
--
--    会話（conversations.user_id）は LINE の userId / web の session_id /
--    Shopify の顧客番号のいずれかで保存されている。だから「同じ人の会話」を引くには
--    連結成分に属する **識別子の生値** が要る。
--
--    ⚠ email_hash は返さない（SEC-1）。会話の user_id になることも無い。
-- ===================================================================
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
  -- SEC-1: メールの hash から人を引く経路はここにも無い。
  IF p_kind = 'email_hash' THEN
    RETURN jsonb_build_object('found', false, 'reason', 'identifier_kind_not_resolvable');
  END IF;

  SELECT e.subject_id INTO v_seed
    FROM identity_edges e
   WHERE e.identifier_kind = p_kind AND e.identifier_value = p_value
   LIMIT 1;

  IF v_seed IS NULL THEN
    -- まだ主体が発行されていない（= Stage 1 の gateway をまだ通っていない人）。
    -- 呼び出し側は旧 join だけで読む（フォールバック）。
    RETURN jsonb_build_object('found', false, 'reason', 'subject_not_found');
  END IF;

  v_members := cdp_subject_component(v_seed);

  SELECT count(*) INTO v_links
    FROM subject_links l
   WHERE l.subject_a = ANY (v_members) OR l.subject_b = ANY (v_members);

  SELECT count(*) INTO v_total
    FROM identity_edges e
   WHERE e.subject_id = ANY (v_members)
     AND e.identifier_kind <> 'email_hash';

  -- 新しく観測されたものから順に上限まで。上限に当たったことは truncated で言う
  -- （黙って削らない）。
  SELECT coalesce(array_agg(v ORDER BY t DESC), ARRAY[]::text[]) INTO v_refs FROM (
    SELECT e.identifier_value AS v, max(e.observed_at) AS t
      FROM identity_edges e
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

COMMENT ON FUNCTION cdp_canonical_identifiers(text, text, integer) IS
  '横断読み出しの読み口。鍵 1 つから、同じ人と判定された主体群の識別子の生値を返す。'
  ' link が 1 本も無ければ member_count=1・link_count=0 が返り、'
  ' 呼び出し側の挙動は連携前と変わらない（Stage 2 の完了条件）。'
  ' email_hash は決して返さない（SEC-1）。';

-- ===================================================================
-- 5. J-4 — 1 つの連結成分に LINE トーク ID は 1 つまで
--
--    現行 routes/identity.ts は customer_linkages の UNIQUE 衝突を 409 に倒して
--    これを守っている。link 側でも同じ不変条件を **DB で** 保つ。
--    ⚠ J-4 が覆ったらこのトリガを落とすだけでよい（スキーマは触っていない）。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_subject_links_j4_guard() RETURNS trigger AS $$
DECLARE
  v_members text[];
  v_line    integer;
BEGIN
  -- 挿入後の連結成分（BEFORE INSERT なので NEW の行はまだ見えない。両端の成分を足す）。
  v_members := cdp_subject_component(NEW.subject_a) || cdp_subject_component(NEW.subject_b);

  SELECT count(DISTINCT e.identifier_value) INTO v_line
    FROM identity_edges e
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

DROP TRIGGER IF EXISTS subject_links_j4 ON subject_links;
CREATE TRIGGER subject_links_j4
  BEFORE INSERT ON subject_links
  FOR EACH ROW EXECUTE FUNCTION cdp_subject_links_j4_guard();

-- ===================================================================
-- 6. delivery_identity — 生 LINE userId の置き場（E5 の行き先）
--
--    Stage 2 では **派生**（customer_linkages から作られる写し）で、唯一化は Stage 5。
--    ここに置く目的は「生 ID の置き場を 1 つに寄せる先」を先に作っておくことで、
--    Stage 4（セグメント配信の SQL 化）が customer_linkages を直接引かなくて済む形に
--    しておくこと。
--
--    ⚠ この表は追記専用ではない（E4 を付けない）。連携先の付け替え・友だち解除の
--      反映で更新される **派生**であり、いつでも customer_linkages と link から
--      作り直せる。E4 が守るのは事実（L0）と同一性（edges / links）であって、
--      そこから導いた投影ではない。
--
--    @reader src/lib/cdp/stage2-parity.ts（日次の突合。連携済み台帳との差分を数える）
-- ===================================================================
CREATE TABLE IF NOT EXISTS delivery_identity (
  subject_id   text PRIMARY KEY REFERENCES subjects(subject_id),
  -- 生値。E5 の最終形ではこの 1 列だけが生 LINE userId を持つ。
  line_user_id text NOT NULL,
  -- どの経路が派生させたか（slug）。
  source       text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_identity_line_uid_form CHECK (line_user_id ~ '^U[0-9a-f]{32}$'),
  CONSTRAINT delivery_identity_source_slug   CHECK (source ~ '^[a-z0-9_.\-]{1,64}$')
);

-- 1 つの LINE は 1 つの主体にしか属さない（identity_edges_uniq と同じ不変条件の写し）。
CREATE UNIQUE INDEX IF NOT EXISTS delivery_identity_line_uid
  ON delivery_identity (line_user_id);

COMMENT ON TABLE delivery_identity IS
  '生の LINE userId（配信の宛先）の置き場。E5 の最終形ではここだけが生値を持つ。'
  ' Stage 2 では customer_linkages からの派生で、唯一化（customer_linkages の'
  ' 台帳機能の撤去）は Stage 5 / T-7。追記専用ではない（派生なので作り直せる）。';

ALTER TABLE subject_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_identity ENABLE ROW LEVEL SECURITY;

-- ===================================================================
-- 7. 消去の語彙に subject_a / subject_b を足す（042 の差し替え）
--
--    1 つの表が複数の鍵の列を持つときは列ごとに 1 回ずつ消す（042 の loop）。
--    subject_links はどちら側に居ても消える。
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
      -- 043: subject_links は主体を 2 列で持つ。両方を 'subject' として列挙する
      --      （どちら側に居ても消える。列ごとに 1 回ずつ消せば OR と同じ結果）。
      WHEN 'subject_a'           THEN 'subject'
      WHEN 'subject_b'           THEN 'subject'
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
      'subject_id',
      'subject_a',
      'subject_b'
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
      'subjects'
    );
$$ LANGUAGE sql STABLE;

-- ===================================================================
-- 8. 解決を link の連結成分まで広げる（042 の差し替え）
--
--    広げないと「LINE で消してくれ」と言われたときに、link の向こう側の主体
--    （その人の Shopify 側・web セッション側）が残る。台帳（customer_linkages /
--    user_identity_map）経由でも届くことは多いが、**それは Stage 5 で消える台帳**
--    なので、いま link 側の経路を通しておく。
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
    -- 043: さらに **link の連結成分** まで広げる（同じ人だと判定した向こう側）。
    SELECT coalesce(array_agg(DISTINCT sj), ARRAY[]::text[]) INTO v_subjects FROM (
      SELECT unnest(v_subjects) AS sj
      UNION
      SELECT e.subject_id FROM identity_edges e
        WHERE (e.identifier_kind = 'shopify_customer_id' AND e.identifier_value = ANY (v_shopify))
           OR (e.identifier_kind IN ('line_messaging_uid', 'line_login_uid')
               AND e.identifier_value = ANY (v_line))
           OR (e.identifier_kind IN ('web_session_id', 'web_anonymous_id')
               AND e.identifier_value = ANY (v_web))
      UNION
      SELECT m FROM unnest(v_subjects) AS x, LATERAL unnest(cdp_subject_component(x)) AS m
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
-- 9. 検算に subject_links / delivery_identity を載せる（042 の差し替え）
--
--    列挙（roji_person_key_map）経由の数え方は 7. でもう載っている。ここで足すのは
--    **辿らずに数える孤児検査**のほう: edges が消えて辿れなくなっても、
--    「retire 済みの主体を指す行」が残っていれば取りこぼしとして数える。
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

  -- 043: 消去と同じ広さで数える（消去は link の向こう側まで消すので、検算も広げる）。
  SELECT coalesce(array_agg(DISTINCT sj), ARRAY[]::text[]) INTO v_subjects FROM (
    SELECT unnest(v_subjects) AS sj
    UNION
    SELECT m FROM unnest(v_subjects) AS x, LATERAL unnest(cdp_subject_component(x)) AS m
  ) q WHERE sj IS NOT NULL AND sj <> '';

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
  --   043: subject_links（両端）と delivery_identity を足した。
  SELECT
    coalesce((SELECT count(*) FROM customer_events ce
                JOIN subjects s ON s.subject_id = ce.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM identity_edges ie
                JOIN subjects s ON s.subject_id = ie.subject_id
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM subject_links sl
                JOIN subjects s ON s.subject_id IN (sl.subject_a, sl.subject_b)
               WHERE s.retired_at IS NOT NULL), 0)
  + coalesce((SELECT count(*) FROM delivery_identity di
                JOIN subjects s ON s.subject_id = di.subject_id
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

-- ===================================================================
-- 10. 突合（読み取り専用）— 新旧の解決が食い違っていないかを毎日 1 行で言う
--
--     Stage 2 の完了条件は「新旧解決の一致率 100% を 5 営業日観測」。その観測に
--     必要な数だけをここで数える。**新規 cron は作らない** — 既存の日次 tick
--     （wrangler.toml の "0 18 * * *"）に相乗りする（src/index.ts の runDailySync）。
--
--     数えるもの:
--       linked_ledger_rows       … 旧台帳（customer_linkages）で連携済みの人数
--       linked_without_link      … 旧台帳では連携済みなのに subject_links が無い人数
--                                  **これが 0 でない日は一致していない**（＝観測の主指標）
--       identity_map_linked_rows … もう 1 冊の旧台帳（user_identity_map）の連携済み行
--       identity_map_without_link… 同上で subject_links が無い行
--       delivery_identity_rows   … 派生（E5 の行き先）の行数
--       delivery_identity_missing… 連携済みなのに派生が無い人数
--       links_total / links_by_basis … 追記された判断の数と内訳
--       max_component_size       … 最大の連結成分（作り置きを持たない判断の見張り）
--       multi_line_components    … 1 成分に LINE が 2 本以上（J-4 破れ。常に 0）
--
--     @reader src/lib/cdp/stage2-parity.ts
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_stage2_parity()
RETURNS jsonb AS $$
DECLARE
  v_linked_rows        bigint := 0;
  v_linked_without     bigint := 0;
  v_map_rows           bigint := 0;
  v_map_without        bigint := 0;
  v_delivery_rows      bigint := 0;
  v_delivery_missing   bigint := 0;
  v_links_total        bigint := 0;
  v_by_basis           jsonb  := '{}'::jsonb;
  v_max_component      integer := 0;
  v_multi_line         bigint := 0;
BEGIN
  SELECT count(*) INTO v_linked_rows
    FROM customer_linkages
   WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL;

  -- 旧台帳で連携済みなのに、追記型の link が無い人。
  -- 「両方の主体が発行済みで、かつ同じ連結成分に居る」ことを一致とみなす。
  SELECT count(*) INTO v_linked_without
    FROM customer_linkages cl
   WHERE cl.line_user_id IS NOT NULL
     AND cl.shopify_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM identity_edges le
         JOIN identity_edges se
           ON se.identifier_kind = 'shopify_customer_id'
          AND se.identifier_value = cl.shopify_customer_id
        WHERE le.identifier_kind = 'line_messaging_uid'
          AND le.identifier_value = cl.line_user_id
          AND se.subject_id = ANY (cdp_subject_component(le.subject_id))
     );

  SELECT count(*) INTO v_map_rows
    FROM user_identity_map
   WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL;

  SELECT count(*) INTO v_map_without
    FROM user_identity_map m
   WHERE m.line_user_id IS NOT NULL
     AND m.shopify_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM identity_edges le
         JOIN identity_edges se
           ON se.identifier_kind = 'shopify_customer_id'
          AND se.identifier_value = m.shopify_customer_id
        WHERE le.identifier_kind = 'line_messaging_uid'
          AND le.identifier_value = m.line_user_id
          AND se.subject_id = ANY (cdp_subject_component(le.subject_id))
     );

  SELECT count(*) INTO v_delivery_rows FROM delivery_identity;

  SELECT count(*) INTO v_delivery_missing
    FROM customer_linkages cl
   WHERE cl.line_user_id IS NOT NULL
     AND cl.shopify_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM delivery_identity di WHERE di.line_user_id = cl.line_user_id
     );

  SELECT count(*) INTO v_links_total FROM subject_links;

  SELECT coalesce(jsonb_object_agg(basis, n), '{}'::jsonb) INTO v_by_basis
    FROM (SELECT basis, count(*) AS n FROM subject_links GROUP BY basis) q;

  -- 連結成分の大きさ。link を持つ主体だけを見れば足りる（持たない人は必ず 1）。
  SELECT coalesce(max(sz), 0) INTO v_max_component FROM (
    SELECT coalesce(array_length(cdp_subject_component(s), 1), 1) AS sz
      FROM (SELECT DISTINCT subject_a AS s FROM subject_links
             UNION SELECT DISTINCT subject_b FROM subject_links) m
  ) q;

  -- J-4 の破れ（常に 0 であるべき。トリガが効いていれば入らない）。
  SELECT count(*) INTO v_multi_line FROM (
    SELECT m.s
      FROM (SELECT DISTINCT subject_a AS s FROM subject_links
             UNION SELECT DISTINCT subject_b FROM subject_links) m
     WHERE (SELECT count(DISTINCT e.identifier_value)
              FROM identity_edges e
             WHERE e.subject_id = ANY (cdp_subject_component(m.s))
               AND e.identifier_kind = 'line_messaging_uid') > 1
  ) q;

  RETURN jsonb_build_object(
    'linked_ledger_rows',        v_linked_rows,
    'linked_without_link',       v_linked_without,
    'identity_map_linked_rows',  v_map_rows,
    'identity_map_without_link', v_map_without,
    'delivery_identity_rows',    v_delivery_rows,
    'delivery_identity_missing', v_delivery_missing,
    'links_total',               v_links_total,
    'links_by_basis',            v_by_basis,
    'max_component_size',        v_max_component,
    'multi_line_components',     v_multi_line,
    -- 一致しているか（この 3 つが 0 の日が「一致 100%」の 1 日）。
    'in_agreement',              (v_linked_without = 0 AND v_delivery_missing = 0 AND v_multi_line = 0)
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_stage2_parity() IS
  'Stage 2 の並走突合（読み取り専用）。旧台帳と追記型 link の解決が食い違っていないかを'
  ' 1 回の呼び出しで数える。日次 tick から呼ばれ、1 行の JSON ログとして残る。';
