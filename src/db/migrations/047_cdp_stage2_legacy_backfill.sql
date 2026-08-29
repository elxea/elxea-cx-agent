-- ===================================================================
-- 047: Stage 2 より前に成立していた連携を、追記 1 行として **記録できる** ようにする
--      （CDP 統合 Stage 2 / §6-1 Stage 2 の完了条件 / 044 の「永久に false」の解消）
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）§6-1 Stage 2 の完了条件 /
--   §3-1 ID 体系 / §5 E4・E5 / §4 C-1（★11）/ 決裁 J-4
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ 何が起きているか（実測・2026-08-29）─
--
-- 本番 cdp_stage2_parity():
--     linked_without_link = 1 / delivery_identity_missing = 1 / in_agreement = false
--
-- その 1 件は customer_linkages の 1 行（source='liff'・linked_at 2026-08-25）である。
-- Stage 2 のコードが本番に載ったのは 2026-08-28 で、この人はその **前** に連携した。
--
-- ─ なぜ「待っていても」緑にならないか（実コードで確認した）─
--
-- subject_links に行が入る経路は 2 本しか無い:
--
--   src/routes/identity.ts   identityLinkLiffHandler → recordLinkAndDelivery
--                            （upsertCustomerLinkage が ok を返した **後**）
--   src/lib/account-link.ts  handleAccountLinkEvent → appendSubjectLink
--                            （single-use nonce を **消費できた後**）
--
-- どちらも「新しく連携する」という出来事の中にしか無い。既に連携済みの人に対して
-- これを再度起こす経路は 1 本も無い:
--
--   - 日次の照合 src/lib/linkage-reconcile.ts は web-app へ通知を再送するだけで、
--     subject_links にも delivery_identity にも触れない（実測: 参照ゼロ）。
--   - src/lib/karte-reconcile.ts も同様（Firestore 側の合流のみ）。
--   - Stage 1 の events gateway は主体（subjects / identity_edges）は発行しうるが、
--     「この 2 つは同じ人だ」という **判断** は作らない（設計どおり・Stage 2 の責務）。
--
-- つまり 044 が「意図した挙動」として書いた *永久に false になりうる* 状態に、
-- 本番は既に入っている。**5 営業日の観測は構造的に埋まらない。**
-- 観測を待つのではなく、旧台帳の実連携を新台帳へ 1 度だけ写す必要がある。
--
-- ─ この migration が「する」こと / 「しない」こと ─
--
--   する : 写すための **語彙**（basis）を 1 つ増やす。何が写せて何が写せないかを
--          読み取り専用で数える関数 cdp_stage2_backfill_candidates() を足す。
--   しない: **行を 1 つも書かない。** 実際の写し取りは
--          scripts/cdp-stage2-backfill.ts が Stage 2 の正規経路と同じ関数
--          （appendSubjectLink / resolveOrIssueSubject / upsertDeliveryIdentity）を
--          通して行う。SQL 側に 2 つ目の書き込み実装を作らない
--          （作れば「link とは何か」の定義が 2 つに割れる）。
--
-- ─ basis を 1 つ増やすことの意味（これは決定である・明示する）─
--
-- 043 は basis を「なぜ同じ人だと判定したか」と定義し、値を CHECK で閉じた。
-- ここに値を足すことは「その根拠で人を結んでよい」という決定そのものである、と
-- 043 自身が書いている。よって足す前に、何を足すのかを正確に言う。
--
--   足す値: 'legacy_ledger_backfill'
--   意味  : 「**旧台帳 customer_linkages（039 で SoT と確定した台帳）が既にそう
--           言っている**」ことを根拠に結ぶ。新しく検証したのではなく、前の正本を
--           そのまま引き継ぐ、という宣言である。
--
-- なぜ既存の値（liff_id_token / line_account_link）を流用しないか:
--
--   (a) 嘘になる。'liff_id_token' は「この処理が LINE 署名済み id_token を検証した」
--       ことを指す語であって、「昔どこかで検証されたはず」ではない。後から
--       「この人はどう結ばれたのか」を監査する読み手を誤らせる。
--   (b) customer_linkages.source は根拠として弱い。null 可・自由 text・026 で
--       後から足した列であり、upsert（onConflict=line_user_id）で後の書き手に
--       上書きされる。実測でも staging の 1 行は source=null である。
--       これを basis に昇格させるのは、記録されていない事実を発明することになる。
--   (c) 値を分けておけば、後で本人が実際に LIFF / Account Link を通ったときに
--       **別の行として真正な根拠が記録される**（043 の「根拠が違えば別の行」）。
--       流用すると、その真正な追記が重複として黙って落ちる。
--
-- SEC-1 との関係（これは緩和ではない）:
--
--   'email_equality' を拒む理由は「メールが一致するだけで **他人が** 人を結べる」
--   ことにある。'legacy_ledger_backfill' で結べるのは、customer_linkages に
--   **既に存在する行** だけである。行を増やせる経路は従来どおり LIFF（id_token 検証）/
--   Account Link（single-use nonce）/ 運用者スクリプト（staging 専用の owner_kit）に
--   限られ、この migration はそこを 1 つも広げない。外から新しい結び付きを
--   作れるようにはならない。
--
-- ─ 不変条件はすべて据え置き ─
--
--   E4  … subject_links の UPDATE / DELETE 拒否トリガ（043 §2）はそのまま。
--          backfill は INSERT しかしない。
--   J-4 … 1 連結成分に LINE は 1 本まで（043 §5 のトリガ）はそのまま。
--          写せない行（世帯共有 N:1）は **写らずに残り、parity が false のまま数える** —
--          これは正しい（J-4 に反する連携は人が判断すべきもので、黙って通さない）。
--   SEC-1 … basis に email_equality は無いまま。
--
-- ─ 043 / 044 を書き換えない理由 ─ 044 と同じ。適用済み migration の中身を後から
--   書き換えると、schema_migrations の「適用済み」記録と実際に当たった SQL が食い違う。
--
-- ⚠ 040 / 041 / 042 / 043 が先に当たっていること。
-- ─ 冪等性 ─ DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT / CREATE OR REPLACE FUNCTION。
--            何度当てても同じ。行は 1 つも書かない。
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認
-- ===================================================================
DO $$
BEGIN
  IF to_regclass('public.subject_links') IS NULL THEN
    RAISE EXCEPTION '047: subject_links が無い。043 を先に当てること。';
  END IF;
  IF to_regclass('public.delivery_identity') IS NULL THEN
    RAISE EXCEPTION '047: delivery_identity が無い。043 を先に当てること。';
  END IF;
  IF to_regproc('public.cdp_subject_component') IS NULL THEN
    RAISE EXCEPTION '047: cdp_subject_component が無い。043 を先に当てること。';
  END IF;
  IF to_regclass('public.customer_linkages') IS NULL THEN
    RAISE EXCEPTION '047: customer_linkages が無い。002 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. basis の語彙に 'legacy_ledger_backfill' を足す
--
--     ⚠ 既存 3 値は 1 つも消さない（**狭めない**）。足すだけなので、既存行は
--       すべてそのまま新しい CHECK を満たす（ADD CONSTRAINT の検証は必ず通る）。
--     ⚠ 'email_equality' はここにも無い（SEC-1）。
-- ===================================================================
ALTER TABLE subject_links DROP CONSTRAINT IF EXISTS subject_links_basis_allowed;
ALTER TABLE subject_links ADD CONSTRAINT subject_links_basis_allowed CHECK (basis IN (
  -- ここまでは 043 と同一（順序も変えない）。
  'liff_id_token',
  'line_account_link',
  'anonymous_promotion',
  -- 047 で追加。旧台帳 customer_linkages（039 で SoT と確定）が既に「同じ人だ」と
  -- 言っていることを根拠に結ぶ。新規に検証したのではなく、前の正本を引き継ぐ宣言。
  -- 書き手は scripts/cdp-stage2-backfill.ts の 1 本だけ（ランタイムの route は使わない）。
  'legacy_ledger_backfill'
));

COMMENT ON COLUMN subject_links.basis IS
  'なぜ同じ人だと判定したか。CHECK で閉じている。'
  ' ここに値を足すことは「その根拠で人を結んでよい」という決定であり、'
  ' email_equality を足すことは SEC-1 を取り消すことを意味する。'
  ' 047 で legacy_ledger_backfill を追加した: Stage 2 より前に旧台帳'
  ' customer_linkages で成立していた連携を写し取るための語彙で、'
  ' 「前の正本がそう言っている」以上の根拠を主張しない'
  '（既存の liff_id_token / line_account_link に混ぜると監査の読み手を誤らせる）。';

-- ===================================================================
-- 2. 写せるもの / 写せないものを数える（読み取り専用）
--
--     backfill を回す **前** に何が起きるかを言えるようにする。実行後に
--     「なぜ 1 件残ったのか」を探しに行かなくて済む形にするのが目的。
--
--     母数は cdp_stage2_parity() の linked_without_link と **同じ述語** にする
--     （line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL）。
--     ここがずれると「全部写したのに parity が緑にならない」が起きる。
--
--     @reader scripts/cdp-stage2-backfill.ts
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_stage2_backfill_candidates()
RETURNS jsonb AS $$
DECLARE
  v_total          bigint := 0;
  v_already        bigint := 0;
  v_pending        bigint := 0;
  v_bad_line_form  bigint := 0;
  v_j4_blocked     bigint := 0;
  v_retired        bigint := 0;
  v_delivery_miss  bigint := 0;
BEGIN
  -- 母数（parity の linked_without_link と同じ述語）。
  SELECT count(*) INTO v_total
    FROM customer_linkages
   WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL;

  -- 既に新台帳で 1 人として解決できている行（parity が「一致」とみなす形）。
  SELECT count(*) INTO v_already
    FROM customer_linkages cl
   WHERE cl.line_user_id IS NOT NULL
     AND cl.shopify_customer_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM identity_edges le
         JOIN identity_edges se
           ON se.identifier_kind = 'shopify_customer_id'
          AND se.identifier_value = cl.shopify_customer_id
        WHERE le.identifier_kind = 'line_messaging_uid'
          AND le.identifier_value = cl.line_user_id
          AND se.subject_id = ANY (cdp_subject_component(le.subject_id))
     );

  v_pending := v_total - v_already;

  -- 配信の宛先を派生できない形（delivery_identity の CHECK と同じ正規表現）。
  -- Messaging userId でない値（LINE Login userId の取り違え等）がここに出る。
  -- link は張れるが delivery_identity は作れないので、parity は
  -- delivery_identity_missing の側で false のまま残る（黙って緑にしない）。
  SELECT count(*) INTO v_bad_line_form
    FROM customer_linkages
   WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL
     AND line_user_id !~ '^U[0-9a-f]{32}$';

  -- J-4 で写せない行: 同じ Shopify 顧客に 2 本以上の LINE がぶら下がっている
  -- （世帯共有 N:1。2026-08-24 決裁で恒久 deny）。**写さないのが正しい。**
  SELECT coalesce(sum(n - 1), 0) INTO v_j4_blocked FROM (
    SELECT count(DISTINCT line_user_id) AS n
      FROM customer_linkages
     WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL
     GROUP BY shopify_customer_id
    HAVING count(DISTINCT line_user_id) > 1
  ) q;

  -- 消去済みの主体を含む行（043 の cdp_reject_retired_link が拒む）。
  SELECT count(*) INTO v_retired
    FROM customer_linkages cl
   WHERE cl.line_user_id IS NOT NULL
     AND cl.shopify_customer_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM identity_edges e
         JOIN subjects s ON s.subject_id = e.subject_id
        WHERE s.retired_at IS NOT NULL
          AND ((e.identifier_kind = 'line_messaging_uid'  AND e.identifier_value = cl.line_user_id)
            OR (e.identifier_kind = 'shopify_customer_id' AND e.identifier_value = cl.shopify_customer_id))
     );

  SELECT count(*) INTO v_delivery_miss
    FROM customer_linkages cl
   WHERE cl.line_user_id IS NOT NULL
     AND cl.shopify_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM delivery_identity di WHERE di.line_user_id = cl.line_user_id
     );

  RETURN jsonb_build_object(
    'linked_ledger_rows',        v_total,
    -- 既に新台帳で 1 人として解決できている（写す必要が無い）。
    'already_resolved',          v_already,
    -- 写す対象（= parity の linked_without_link と同じ数）。
    'pending_link',              v_pending,
    -- 写せない・写してはいけない内訳。
    'blocked_bad_line_form',     v_bad_line_form,
    'blocked_j4_household',      v_j4_blocked,
    'blocked_retired_subject',   v_retired,
    -- 配信の宛先の派生が要る行数。
    'delivery_identity_missing', v_delivery_miss,
    -- backfill を回せば parity が緑になりうるか（回す前の見立て）。
    -- 阻害要因が 1 つも無いときだけ true。true でも実行結果は必ず parity で確かめる。
    'expect_green_after_backfill',
      (v_bad_line_form = 0 AND v_j4_blocked = 0 AND v_retired = 0)
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_stage2_backfill_candidates() IS
  'Stage 2 の写し取り（backfill）を回す前の見立て（読み取り専用・行を書かない）。'
  ' 母数は cdp_stage2_parity() の linked_without_link と同じ述語。'
  ' 写せない内訳（LINE userId の形 / J-4 の世帯共有 / 消去済み主体）を分けて返すので、'
  ' 「全部写したのに parity が緑にならない」を実行前に言える。'
  ' 実際の写し取りは scripts/cdp-stage2-backfill.ts が Stage 2 の正規経路と'
  ' 同じ関数を通して行う（SQL 側に 2 つ目の書き込み実装は作らない）。';
