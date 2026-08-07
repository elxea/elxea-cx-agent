-- 035: flow_events の受け入れ経路を web にも広げる（項目26・27・28 の置き場を作る）
--
-- 一次入力（仕様の正本）:
--   rojiカルテの項目 — 最終形の定義  https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
--     項目26 読み終わりまで到達したか / 項目27 感想の操作が表示されたか / 項目28 翌月反映の1行を見たか
--     第9章「これら3つは Web の roji ページで起きる出来事だが、いまの出来事の置き場には
--            そのままでは入らない。器を作る前に経路をどうするかの設計判断が要る」
--
-- ■ 判断（2026-08-08・Boss 確定）: 経路を広げる。出来事の置き場を 2 つに割らない。
--   021 の I-4 は「web を足す場合は CHECK 拡張でなく再設計判断を経る」と書いている。
--   本 migration はその**再設計判断を経た上での CHECK 拡張**であり、安易な多チャネル化ではない。
--   理由: 項目26・27・28 は「出来事」であり、既存の 出来事 = flow_events と役割が完全に同じ。
--   置き場を分けると同じ性質のデータが 2 か所に散り、保持期間・PII ガード・読み手を二重管理になる。
--
-- ■ 広げてよいことの確認（着手前チェック・実ファイルで確認済み）
--   021_flow_events.sql の列に「LINE 前提の意味を必須にしている列」は無い:
--     - user_ref  … NOT NULL だが定義は「unified id（conversations.user_id と同一規約:
--                    LINE userId / web session）」。**設計時から web を織り込んだ汎用キー**。
--     - channel   … 'line' のみを許す CHECK。これが唯一の LINE 前提であり、本 migration の対象。
--     - 他（event_name / step / value / product_no / metadata）… チャネル非依存。
--   よって「LINE 固有の識別子が NOT NULL」は存在せず、広げるのは筋が通る。
--
-- ■ 何を変えるか（追加のみ・破壊的操作ゼロ）
--   channel の CHECK を IN ('line') → IN ('line','web') に**緩める**だけ。
--     - 列の追加・削除・型変更なし。DEFAULT 'line' は据え置き（既存の呼び出しは一切変わらない）。
--     - 既存行は 1 行も書き換えない（緩める方向なので既存行はすべて新 CHECK を満たす）。
--     - DROP TABLE / DELETE / TRUNCATE / 自動削除ジョブは一切含まない。
--
-- 冪等性: 制約名を動的に特定して張り替えるため再実行安全（027 と同じ流儀）。
-- 適用順序: staging に先行適用 → 本番は Setaka 承認後に同一 SQL を適用。既存行は不変。

DO $$
DECLARE
  cname text;
BEGIN
  -- channel 列に掛かっている単一列 CHECK 制約を動的に特定する（制約名の環境差を吸収）。
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'flow_events'
    AND con.contype = 'c'                  -- CHECK 制約のみ
    AND att.attname = 'channel'
    AND array_length(con.conkey, 1) = 1     -- 単一列制約のみ
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.flow_events DROP CONSTRAINT %I', cname);
    RAISE NOTICE '035: dropped channel CHECK % on flow_events', cname;
  ELSE
    RAISE NOTICE '035: no single-column CHECK on flow_events.channel (already widened / idempotent)';
  END IF;

  -- 広げた CHECK を張り直す（既に同名で存在する場合に備え、上で必ず落としてから追加する）。
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'flow_events'
      AND con.conname = 'flow_events_channel_check'
  ) THEN
    ALTER TABLE public.flow_events
      ADD CONSTRAINT flow_events_channel_check CHECK (channel IN ('line', 'web'));
    RAISE NOTICE '035: added widened channel CHECK (line, web) on flow_events';
  END IF;
END $$;
