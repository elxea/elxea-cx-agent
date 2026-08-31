-- ===================================================================
-- 050: 「誰からも辿れない主体」の数え方から偽陽性を取る
--      — 鍵が取り消されていても link で人に戻してあるなら、その主体は迷子ではない
--      （049 の是正。CDP 統合 Stage 2）
-- ===================================================================
--
-- 一次入力: https://app.notion.com/p/3cc70c9d064c814c8ba3d70f4812d199
--           （2026-08-31 の本番是正で発見された偽陽性）
--
-- ─ 何が壊れているか ─
--
-- 049 の cdp_retraction_summary() は subjects_without_live_edges を
-- 「live な identity_edges を 1 つも持たない、retired でない主体」と定義している。
-- 関数コメントは同じ指標を **「＝ 誰とも結ばれない主体になっていないか」** と説明し、
-- 「0 であるべき」と書いている。この 2 つは一致していない。
--
--   数えている条件 : live な **鍵** が無い
--   言っている意味 : **誰からも辿り着けない**
--
-- 049 が入れた仕組みそのものが、この 2 つを別物にした。取り消し
-- （identity_edge_retractions）は「その観測は誤りだった」を意味するだけで、
-- 「その主体は誰でもない」を意味しない。誤った鍵を取り消したうえで、
-- 正しい人へ subject_links で **戻す**（049 §B-2 の 'identifier_correction'）のが
-- 是正の完成形であり、そのとき当該主体は
--
--     live な鍵は 0 本 / live な link は 1 本 → 連結成分をたどれば正しい人に着く
--
-- という状態になる。これは迷子ではない。ところが旧定義は link を 1 本も見ないので、
-- **是正が正しく終わった主体をそのまま 1 と数える**。
--
-- ─ 実害 ─
--
-- 本番（2026-08-31 の是正適用後）では B-2 が当たっているため、この指標は
-- **恒常 1** を返す。cdp_retraction_summary() は日次 tick から 1 行ログに落とす
-- 監視値なので、「0 であるべき」と書かれた値が毎日 1 で鳴り続ける。
-- 鳴りっぱなしの警報は、やがて誰も見なくなる（＝ 本物の迷子が出ても気付けない）。
--
-- ─ 直し方 ─
--
-- 数える条件を、関数コメントが言っている意味のほうに揃える。
-- 「live な鍵も無く、**live な link も無い**」＝ 完全に孤立した主体だけを数える。
--
--   -- 049（偽陽性あり）
--   WHERE s.retired_at IS NULL
--     AND NOT EXISTS (SELECT 1 FROM identity_edges_live e WHERE e.subject_id = s.subject_id)
--
--   -- 050（本 migration）
--   WHERE s.retired_at IS NULL
--     AND NOT EXISTS (SELECT 1 FROM identity_edges_live e WHERE e.subject_id = s.subject_id)
--     AND NOT EXISTS (SELECT 1 FROM subject_links_live l
--                      WHERE l.subject_a = s.subject_id OR l.subject_b = s.subject_id)
--
-- 本番の姿に当てると: 是正済みの主体は link を 1 本持つので数から外れ、
-- 指標は **1 → 0** に戻る。取り消しだけして戻さなかった主体（049 §B-2 を採らない
-- 選択をした場合の姿）は link を持たないので **1 のまま鳴る**。つまり
-- 「鳴るべきときだけ鳴る」に戻る。
--
-- ─ 残る限界（意図して残す）─
--
-- 隣が 1 ホップで居ることしか見ていないので、「live な鍵を 1 つも持たない主体どうしが
-- 互いに link し合っているだけ」という状態は 0 と数える。これを厳密に排除するには
-- 連結成分（cdp_subject_component）を主体ごとに解く必要があり、主体数に対して
-- 再帰 CTE を毎回回す監視値になる。この歪みは
-- **multi_shopify_components と同じく成分単位の検査**で見るほうが筋がよく、
-- 現に「成分の中に live な鍵が 1 本も無い」状態は連結成分が空になるので
-- cdp_canonical_identifiers が found=false を返して別経路で顕在化する。
-- 監視値としてはここまでで足りると判断した（見つかっていない歪みを
-- 先回りで数えるより、鳴りっぱなしを止めるほうが先）。
--
-- ─ この migration が「する」こと / 「しない」こと ─
--
--   する : cdp_retraction_summary() を CREATE OR REPLACE で 1 本差し替える。
--   しない: **表も行も index もトリガも触らない。** 完全に読み取り専用の関数 1 本。
--   しない: **049 を書き換えない。** 049 は本番適用済みなので、是正は必ず
--          次の番号として足す（043 → 044 と同じ流儀）。
--   しない: 他の 3 つの値（edges_total / edges_retracted / links_total /
--          links_retracted / multi_shopify_components）の定義を変えない。
--          049 の定義をそのまま写している（差分は 1 か所だけであることを
--          tests/unit/cdp-identity-retraction.test.ts が固定する）。
--
-- ─ 冪等性 ─ CREATE OR REPLACE FUNCTION と COMMENT ON のみ。何度流しても同じ。
-- ─ 前提 ─ 049 が当たっていること（identity_edges_live / subject_links_live /
--          cdp_retraction_summary が実在すること）。
-- ===================================================================

CREATE OR REPLACE FUNCTION cdp_retraction_summary()
RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'edges_total',        (SELECT count(*) FROM identity_edges),
    'edges_retracted',    (SELECT count(*) FROM identity_edge_retractions),
    'links_total',        (SELECT count(*) FROM subject_links),
    'links_retracted',    (SELECT count(*) FROM subject_link_retractions),
    -- どこからも辿り着けなくなった主体。0 であるべき。
    --
    -- 050: 条件に「live な link も無い」を足した。049 は live な鍵だけを見ていたので、
    --   「誤った鍵を取り消し、正しい人へ link で戻した」主体（是正が正しく終わった姿）を
    --   迷子として数えていた。本番では B-2 適用後に恒常 1 を返し、日次ログで
    --   鳴りっぱなしになる偽陽性だった。
    --   鍵も link も無い主体だけが本当に迷子である。
    'subjects_without_live_edges', (
      SELECT count(*) FROM subjects s
       WHERE s.retired_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM identity_edges_live e
            WHERE e.subject_id = s.subject_id)
         AND NOT EXISTS (
           SELECT 1 FROM subject_links_live l
            WHERE l.subject_a = s.subject_id OR l.subject_b = s.subject_id)),
    -- 1 成分に Shopify 顧客 ID が 2 件以上 (人の取り違えの見張り)。
    -- 計上単位は成分 1 つにつき 1（049 のまま・変更なし）。
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
  '取り消しの数と、取り消した結果できた歪み (どこからも辿り着けない主体 /'
  ' 1 人に見えて Shopify 顧客が 2 件ある成分) を数える。読み取り専用。'
  ' 日次 tick から 1 行ログに残す。'
  ' 050: subjects_without_live_edges は「live な鍵も live な link も無い」主体だけを'
  ' 数える。鍵を取り消して link で正しい人に戻した主体は迷子ではない。';
