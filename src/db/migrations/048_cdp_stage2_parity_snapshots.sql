-- ===================================================================
-- 048: 「5 営業日一致」を数えられるようにする — 観測の結果を日ごとに残す
--      （CDP 統合 Stage 2 / §6-1 Stage 2 の完了条件 / 043・044 の続き）
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）§6-1 Stage 2 の完了条件
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ 何が足りていないか ─
--
-- Stage 2 の完了条件は「**新旧解決の一致率 100% を 5 営業日**観測」である。
-- ところが 043 / 044 が作った cdp_stage2_parity() は **その瞬間の 1 時点** を返す
-- 関数でしかない。日次 tick（src/index.ts の runDailySync）はそれを呼んで
-- console.log に 1 行落とすだけで、DB には何も残らない。
--
-- つまり「5 営業日連続で一致したか」を問い合わせる先が **どこにも無い**。
-- Worker のログは保持期間が短く（Cloudflare の既定では数日）、しかも
-- 「連続した営業日か」「その日は本当に観測が走ったのか」を後から機械で言えない。
-- 5 営業日グリーンの判定は、現状の作りでは原理的に不能である。
--
-- ─ この migration が「する」こと / 「しない」こと ─
--
--   する : 観測結果を 1 日 1 行で残す表と、その 1 行を書く関数、
--          連続営業日を数える読み口を置く。
--   しない: **判定の定義を作り直さない。** 一致しているかどうかの定義は 044 の
--          cdp_stage2_parity() が正本であり、ここはそれを呼んで結果を写すだけ。
--          突合の SQL をこちらに書き写さない（写せば定義が 2 つに割れる）。
--   しない: **既存の関数を書き換えない。** 043 / 044 は本番適用済みなので触らない。
--   しない: 外部に何も送らない。行を直しにいかない（読んで記録するだけ）。
--
-- ─ compared_count を必ず持つ理由（この migration の芯）─
--
-- 044 の in_agreement は「4 つの数がすべて 0」である。ここには落とし穴がある:
--
--     **比べる相手が 1 人も居ない日も、4 つの数はすべて 0 になる。**
--
-- 本番の旧台帳は実測で連携ごく少数（2026-08-25 時点で customer_linkages に 1 行、
-- 047 の写し取り前は subject_links 0 行）である。ここが 0 件になった日は
-- in_agreement=true が立つが、それは「一致した」のではなく「**何も比べていない**」。
-- 一致率 100% の分母が 0 の日を 5 日並べても、Stage 2 の完了条件は満たされない。
--
-- よって観測の 1 行は必ず compared_count（＝その日いくつの旧台帳の行を突き合わせたか）
-- を持ち、グリーンの定義を
--
--     is_green = in_agreement AND compared_count > 0
--
-- とする。この式は表の生成列 1 か所にしか無く、読み口（cdp_stage2_parity_streak）も
-- そこを読む。「0 件の日を緑に数えない」を人の運用規律ではなく **表の定義** にする。
--
-- compared_count に何を数えるか（数えないものを明示する）:
--
--   数える : linked_ledger_rows       … customer_linkages の連携済み行
--            identity_map_linked_rows … user_identity_map の連携済み行
--            ＝ 044 が「旧」として突き合わせている 2 冊の母集団そのもの。
--   数えない: links_total / delivery_identity_rows
--            これは「新」側と派生の件数であって、新旧一致の母集団ではない。
--            ここを足すと、旧が 0 件でも新側の行数で分母が立ってしまい、
--            上の落とし穴がそのまま復活する。raw には残すので後から読める。
--
-- ─ 追記専用（E4 の考え方をこの表にも通す）─
--
-- 観測の履歴は後から書き換えられてはならない（書き換えられるなら証跡ではない）。
-- ただし同じ日に 2 回走ったときは 2 行目を増やすのではなく上書きしたい
-- （tick の再実行・手動確認で日が二重に数えられると連続日数が狂う）。よって:
--
--   DELETE            … 常に禁止
--   UPDATE            … **その行が「今日（JST）」のときだけ** 許す
--   snapshot_date     … 不変（付け替え禁止）
--
-- 「同じ日は上書き・過ぎた日は不変」を DB 側で強制する。呼び出し側の作法に依存しない。
--
-- ─ 営業日の扱い ─
--
-- 土日（JST）は営業日から除く。**祝日は除かない**（この DB に祝日表を持たせると
-- 毎年の保守が要る二重管理になる）。読み口は営業日ごとの内訳を days で返すので、
-- 祝日を飛ばした数え直しは呼び出し側が同じ配列からできる。この境界は意図的である。
--
-- ⚠ 043 / 044 が先に当たっていること（cdp_stage2_parity が必要）。
-- ─ 冪等性 ─ CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
--            DROP TRIGGER IF EXISTS → CREATE TRIGGER のみ。何度当てても同じ。
--            表・関数を新しく作るので sentinel を持てる（migrate.ts 側に登録する）。
-- ===================================================================

-- ===================================================================
-- 0. 前提の確認
-- ===================================================================
DO $$
BEGIN
  IF to_regproc('public.cdp_stage2_parity') IS NULL THEN
    RAISE EXCEPTION '048: cdp_stage2_parity が無い。043 / 044 を先に当てること。';
  END IF;
END;
$$;

-- ===================================================================
-- 1. 営業日の定義（土日を除く。祝日は持たない — 上の「営業日の扱い」参照）
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_is_business_day(p_date date) RETURNS boolean AS $$
  SELECT extract(isodow FROM p_date) BETWEEN 1 AND 5;
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION cdp_is_business_day(date) IS
  '営業日か（ISO の月〜金なら true）。土日のみを除く。祝日は意図的に持たない'
  '（祝日表を DB に置くと毎年の保守が要る二重管理になる。祝日を飛ばした数え直しは'
  ' cdp_stage2_parity_streak が返す days 配列から呼び出し側が行う）。';

-- ===================================================================
-- 2. 観測の置き場 — 1 日 1 行
--
--    グリーンの定義は is_green の生成列 **1 か所** にしかない。
--    読み口も日次の書き手もここを読む（判定を 2 度書かない）。
-- ===================================================================
CREATE TABLE IF NOT EXISTS cdp_stage2_parity_snapshots (
  -- JST の暦日。PRIMARY KEY なので UNIQUE（同じ日は 1 行しか存在しない）。
  snapshot_date  date        NOT NULL,
  -- 044 の cdp_stage2_parity() が返した in_agreement をそのまま写す（作り直さない）。
  in_agreement   boolean     NOT NULL,
  -- その日いくつの旧台帳の行を突き合わせたか。0 の日は「一致した」ではなく
  -- 「何も比べていない」。ここが 5 営業日判定の分母になる。
  compared_count bigint      NOT NULL CHECK (compared_count >= 0),
  -- 食い違いの総数（内訳は raw に残る）。0 でない日がなぜ赤かを 1 目で言うため。
  mismatch_count bigint      NOT NULL CHECK (mismatch_count >= 0),
  -- **グリーンの定義はここだけ。** 比べる相手が 1 人も居ない日を緑に数えない。
  is_green       boolean     GENERATED ALWAYS AS (in_agreement AND compared_count > 0) STORED,
  -- cdp_stage2_parity() の戻りそのまま。内訳（in_agreement_by 等）を捨てない。
  raw            jsonb       NOT NULL,
  -- 初めてその日の行が立った時刻（同じ日の再観測では変えない）。
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- 最後にその日の行を書いた時刻（同じ日の再観測で更新される）。
  observed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cdp_stage2_parity_snapshots_pk PRIMARY KEY (snapshot_date)
);

-- 連続営業日を後ろから辿るときに引く（新しい日から順に読む）。
CREATE INDEX IF NOT EXISTS cdp_stage2_parity_snapshots_recent
  ON cdp_stage2_parity_snapshots (snapshot_date DESC);

COMMENT ON TABLE cdp_stage2_parity_snapshots IS
  'Stage 2 の並走突合の日次スナップショット（1 日 1 行・追記専用）。'
  ' §6-1 Stage 2 の完了条件「新旧解決の一致率 100% を 5 営業日観測」を'
  ' **問い合わせられる形** にするためだけの表。判定の定義は持たず、044 の'
  ' cdp_stage2_parity() の戻りを写す。ただし compared_count（突き合わせた旧台帳の'
  ' 行数）を必ず持ち、0 件の日を緑に数えない（is_green の生成列）。'
  ' 書き手は cdp_stage2_parity_snapshot()、読み口は cdp_stage2_parity_streak()。';

COMMENT ON COLUMN cdp_stage2_parity_snapshots.compared_count IS
  'その日突き合わせた旧台帳の行数（linked_ledger_rows + identity_map_linked_rows）。'
  ' 一致率の分母。0 の日は「一致した」ではなく「何も比べていない」ので緑に数えない。'
  ' links_total / delivery_identity_rows は新側・派生の件数なので **足さない**'
  '（足すと旧が 0 件の日も分母が立ってしまう）。';

COMMENT ON COLUMN cdp_stage2_parity_snapshots.is_green IS
  'その日を「一致した 1 日」に数えてよいか。**この式がグリーンの唯一の定義**'
  '（in_agreement AND compared_count > 0）。読み口も TS 側もここを読む。';

-- ===================================================================
-- 3. 追記専用 — 同じ日は上書き・過ぎた日は不変・削除は不可
--
--    040 の cdp_append_only_guard は UPDATE を一切許さないので使えない
--    （同じ日の再観測を上書きにしたいため）。この表専用のガードを置く。
--    緩めているのは「今日の行だけ」であり、過ぎた日と DELETE は 040 と同じく閉じる。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_parity_snapshot_guard() RETURNS trigger AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'append-only violation: DELETE on public.% は許可されていない。'
      ' 観測の履歴は消さない（消せるなら 5 営業日の証跡にならない）。',
      TG_TABLE_NAME;
  END IF;

  IF NEW.snapshot_date IS DISTINCT FROM OLD.snapshot_date THEN
    RAISE EXCEPTION
      'cdp_stage2_parity_snapshots.snapshot_date は不変。観測日は付け替えない。';
  END IF;

  IF OLD.snapshot_date <> v_today THEN
    RAISE EXCEPTION
      '過ぎた日の観測は書き換えられない（対象 % / 今日 %）。'
      ' 上書きが許されるのは「同じ日にもう一度観測した」場合だけ。',
      OLD.snapshot_date, v_today;
  END IF;

  -- 初回に立った時刻は動かさない（再観測で「いつから見ているか」を失わない）。
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cdp_parity_snapshot_guard() IS
  'cdp_stage2_parity_snapshots の追記専用ガード。DELETE は常に禁止、UPDATE は'
  ' その行が今日（JST）のときだけ許す（同じ日の再観測を 2 行にしないため）。'
  ' snapshot_date と created_at は不変。';

DROP TRIGGER IF EXISTS cdp_stage2_parity_snapshots_append_only ON cdp_stage2_parity_snapshots;
CREATE TRIGGER cdp_stage2_parity_snapshots_append_only
  BEFORE UPDATE OR DELETE ON cdp_stage2_parity_snapshots
  FOR EACH ROW EXECUTE FUNCTION cdp_parity_snapshot_guard();

-- RLS — 017 で有効化した方針に揃える（service_role のみが触る。ポリシー無し = deny-all）。
ALTER TABLE cdp_stage2_parity_snapshots ENABLE ROW LEVEL SECURITY;

-- ===================================================================
-- 4. 書き手 — 突合を 1 回走らせて、その日の 1 行にする
--
--    引数を取らない。**観測日は呼び出し側が決めない**（決められると、
--    昨日の行を今日の観測で埋めるといった過去の作り直しが起きうる）。
--    同じ日に 2 回呼んでも 2 行にならない（ON CONFLICT で上書き＝冪等）。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_stage2_parity_snapshot()
RETURNS jsonb AS $$
DECLARE
  v_raw   jsonb;
  v_date  date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_cmp   bigint;
  v_mis   bigint;
  v_agree boolean;
  v_row   cdp_stage2_parity_snapshots%ROWTYPE;
BEGIN
  -- 判定の正本は 044 の関数。ここは呼ぶだけで、突合の SQL を書き写さない。
  v_raw := cdp_stage2_parity();

  -- 一致率の分母 = 044 が「旧」として突き合わせている 2 冊の母集団。
  v_cmp := coalesce((v_raw ->> 'linked_ledger_rows')::bigint, 0)
         + coalesce((v_raw ->> 'identity_map_linked_rows')::bigint, 0);

  -- 食い違いの総数（内訳は raw の in_agreement_by に残る）。
  v_mis := coalesce((v_raw ->> 'linked_without_link')::bigint, 0)
         + coalesce((v_raw ->> 'identity_map_without_link')::bigint, 0)
         + coalesce((v_raw ->> 'delivery_identity_missing')::bigint, 0)
         + coalesce((v_raw ->> 'multi_line_components')::bigint, 0);

  -- 044 の判定をそのまま写す（作り直さない）。欠けていたら false に倒す。
  v_agree := coalesce((v_raw ->> 'in_agreement')::boolean, false);

  INSERT INTO cdp_stage2_parity_snapshots
    (snapshot_date, in_agreement, compared_count, mismatch_count, raw, observed_at)
  VALUES
    (v_date, v_agree, v_cmp, v_mis, v_raw, now())
  ON CONFLICT (snapshot_date) DO UPDATE
    SET in_agreement   = EXCLUDED.in_agreement,
        compared_count = EXCLUDED.compared_count,
        mismatch_count = EXCLUDED.mismatch_count,
        raw            = EXCLUDED.raw,
        observed_at    = EXCLUDED.observed_at
  RETURNING * INTO v_row;

  -- 戻りは「044 の戻り + 保存の結果」。呼び出し側のログ 1 行が痩せないようにする
  -- （既存の日次ログの読み方を壊さず、保存できたことだけを足す）。
  RETURN v_raw || jsonb_build_object(
    'snapshot_date',   v_row.snapshot_date,
    'compared_count',  v_row.compared_count,
    'mismatch_count',  v_row.mismatch_count,
    'is_green',        v_row.is_green,
    'is_business_day', cdp_is_business_day(v_row.snapshot_date),
    'persisted',       true
  );
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMENT ON FUNCTION cdp_stage2_parity_snapshot() IS
  'Stage 2 の並走突合を 1 回走らせ、その日（JST）の 1 行として残す。'
  ' 判定は 044 の cdp_stage2_parity() が正本で、ここは写すだけ（定義を 2 つにしない）。'
  ' 観測日は引数に取らない（過去の作り直しを起こさないため）。同じ日に 2 回呼んでも'
  ' 2 行にならない（ON CONFLICT で上書き＝冪等）。戻りは 044 の戻り + 保存結果。';

-- ===================================================================
-- 5. 読み口 — 連続何営業日グリーンか
--
--    「観測が走らなかった営業日」は連続を切る。**観測していない日を
--    グリーンとみなさない**（Stage 2 の完了条件は観測できた日の話である）。
--    祝日は除かない（days を返すので、飛ばした数え直しは呼び出し側でできる）。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_stage2_parity_streak(
  p_target        integer DEFAULT 5,
  p_lookback_days integer DEFAULT 60
) RETURNS jsonb AS $$
DECLARE
  v_today        date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_latest_bd    date;
  v_anchor       date;
  v_d            date;
  v_row          cdp_stage2_parity_snapshots%ROWTYPE;
  v_found        boolean;
  v_status       text;
  v_streak       integer := 0;
  v_counting     boolean := true;
  v_days         jsonb   := '[]'::jsonb;
  v_break_date   date;
  v_break_reason text;
  v_is_stale     boolean;
BEGIN
  -- 今日から見た直近の営業日（今日が土日なら金曜まで戻る）。
  v_latest_bd := v_today;
  WHILE NOT cdp_is_business_day(v_latest_bd) LOOP
    v_latest_bd := v_latest_bd - 1;
  END LOOP;

  -- 数え始める日 = 観測が残っている最も新しい営業日。
  SELECT max(s.snapshot_date) INTO v_anchor
    FROM cdp_stage2_parity_snapshots s
   WHERE cdp_is_business_day(s.snapshot_date);

  IF v_anchor IS NULL THEN
    RETURN jsonb_build_object(
      'today_jst',            v_today,
      'latest_business_day',  v_latest_bd,
      'anchor_date',          NULL,
      'is_stale',             true,
      'streak_business_days', 0,
      'target_business_days', p_target,
      'meets_target',         false,
      'break_date',           NULL,
      'break_reason',         'no_snapshot',
      'holidays_excluded',    false,
      'days',                 '[]'::jsonb
    );
  END IF;

  -- 観測が直近の営業日まで来ているか。来ていなければ連続日数が何であれ古い。
  v_is_stale := v_anchor < v_latest_bd;

  v_d := v_anchor;
  WHILE v_d > v_anchor - p_lookback_days LOOP
    IF cdp_is_business_day(v_d) THEN
      SELECT * INTO v_row
        FROM cdp_stage2_parity_snapshots
       WHERE snapshot_date = v_d;
      v_found := FOUND;

      IF NOT v_found THEN
        -- 観測が走らなかった営業日。緑でも赤でもなく「見ていない」。
        v_status := 'missing';
        v_days := v_days || jsonb_build_object('date', v_d, 'status', v_status);
      ELSE
        v_status := CASE
          WHEN v_row.is_green            THEN 'green'
          -- 4 つの数は 0 だが比べる相手が居なかった日。ここを緑にしないのが 048 の芯。
          WHEN v_row.compared_count = 0  THEN 'nothing_compared'
          ELSE 'mismatch'
        END;
        v_days := v_days || jsonb_build_object(
          'date',           v_d,
          'status',         v_status,
          'in_agreement',   v_row.in_agreement,
          'compared_count', v_row.compared_count,
          'mismatch_count', v_row.mismatch_count
        );
      END IF;

      IF v_counting THEN
        IF v_status = 'green' THEN
          v_streak := v_streak + 1;
        ELSE
          v_counting     := false;
          v_break_date   := v_d;
          v_break_reason := v_status;
        END IF;
      END IF;
    END IF;
    v_d := v_d - 1;
  END LOOP;

  RETURN jsonb_build_object(
    'today_jst',            v_today,
    'latest_business_day',  v_latest_bd,
    'anchor_date',          v_anchor,
    -- 観測が直近の営業日に届いていない = 連続日数を「今」の話として読んではいけない。
    'is_stale',             v_is_stale,
    'streak_business_days', v_streak,
    'target_business_days', p_target,
    -- 目標に届いたと言えるのは、連続日数が足りていて **かつ** 観測が古くないとき。
    'meets_target',         (v_streak >= p_target AND NOT v_is_stale),
    'break_date',           v_break_date,
    'break_reason',         v_break_reason,
    -- 祝日はここでは除いていない、と戻り自身に明記する（読み手が取り違えないため）。
    'holidays_excluded',    false,
    'days',                 v_days
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cdp_stage2_parity_streak(integer, integer) IS
  '連続何営業日グリーンかを返す（Stage 2 の完了条件の読み口）。'
  ' 数え始めは観測が残る最も新しい営業日（anchor_date）で、そこから土日を飛ばして'
  ' 遡り、最初の非グリーンで止める。**観測が走らなかった営業日は連続を切る**'
  '（見ていない日を緑とみなさない）。祝日は除かない（holidays_excluded=false）ので、'
  ' 祝日を飛ばした数え直しは days 配列から呼び出し側が行う。'
  ' 観測が直近の営業日に届いていなければ is_stale=true で meets_target は立たない。';

-- ===================================================================
-- 6. 書き手を匿名の呼び出しから閉じる
--
--    cdp_stage2_parity_snapshot() は **書く** 関数である。PostgREST は public
--    スキーマの関数を anon にも露出するため、既定のままだと anon 鍵（公開値）で
--    書き込みを起こせる。読み口（parity / streak / is_business_day）は読むだけ
--    なので従来どおりに置き、書き手だけを service_role に絞る。
--
--    ロールが無い環境（Supabase 以外の Postgres）でも当たるように存在確認してから行う。
-- ===================================================================
DO $$
BEGIN
  REVOKE ALL ON FUNCTION cdp_stage2_parity_snapshot() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION cdp_stage2_parity_snapshot() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION cdp_stage2_parity_snapshot() FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION cdp_stage2_parity_snapshot() TO service_role;
  END IF;
  -- 所有者（migration を当てている接続）は REVOKE FROM PUBLIC の影響を受けない。
END;
$$;
