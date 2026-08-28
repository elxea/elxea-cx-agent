-- ===================================================================
-- 041: 出来事の置き場を 1 本にする（L0 customer_events / CDP 統合 Stage 1 / §3-2）
-- ===================================================================
--
-- 一次入力（設計の正本）: 顧客データ統合 統合設計（最終案）§3-2 データ流路 / §5 E1・E2・E3
--   /Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md
--
-- ─ なぜ要るか ─
--
-- 「その人に何が起きたか」を書く先が 5 経路に散っている（flow_events / Firestore
-- behaviorLog / product_ratings / 購入 / roji アンケート）。散っているせいで:
--
--   * 同じ出来事が 2 か所から書かれても、二重かどうかを言う場所が無い
--     （persona 二重加算 = C-3 はこの形の事故）。
--   * 語彙が経路ごとに違う（行動語彙は 14 / 10 / 7 の三分裂、channel は 4 者食い違い）。
--     語彙が合わないだけで出来事が **400 で捨てられる**（cx-agent 側は
--     src/routes/web.ts の VALID_WEB_EVENTS がその 1 か所）。
--   * 未連携の人の出来事は無言で捨てられる（D1 / T-12）。捨てたことすら残らない。
--
-- L0 は「起きたことをそのまま 1 本の追記に積む」層で、解釈（カルテ・persona・
-- セグメント）は L1 が L0 から再計算する。積む側は判断しない。
--
-- ─ 3 つの設計上の芯 ─
--
--   (E1) 出来事は捨てない … event_type は **open enum**。未知の型でも保存し、
--        schema_ok = false を立てるだけにする。CHECK で語彙を閉じない。
--        閉じた語彙は「知らない出来事が起きた」を「無かったこと」に変えてしまう。
--   (E3) 事実行は subject_id NOT NULL + FK … 誰の出来事か分からない行を作らせない。
--   (冪等) idempotency_key に UNIQUE … 同じ出来事を 2 回書いても 2 行にならない。
--        persona 二重加算（C-3）の恒久解はここ。呼ぶ側の作法ではなく DB の制約で止める。
--
-- ─ 冪等性 ─ CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP TRIGGER IF EXISTS + CREATE TRIGGER。何度当てても同じ。
-- ─ 破壊性 ─ 新規オブジェクトの追加のみ。既存の表・関数・データに一切触れない。
--
-- ─ 適用手順 ─
--
--   MIGRATE_ONLY=041 bash scripts/deploy-prod.sh
--
-- ⚠ 040 が先に当たっていること（subjects への外部キーがある）。
-- ===================================================================

CREATE TABLE IF NOT EXISTS customer_events (
  event_seq   bigserial PRIMARY KEY,

  -- E3: 誰の出来事か。匿名の来訪者にも subject は発行されるので NULL は要らない。
  subject_id  text NOT NULL REFERENCES subjects(subject_id),

  -- E1: open enum。語彙は **コード側の登録簿**（src/lib/cdp/event-vocabulary.ts）が
  -- 持ち、DB は「形」だけを見る。未知の型は弾かずに schema_ok = false で受ける。
  event_type  text NOT NULL,

  -- 出来事のチャネル。ここも open（'line' / 'web' / 'shopify' が既知だが閉じない）。
  -- 現状 4 者食い違い（zod 3 値 / 型 2 値 / route は "web" 固定 / 注文 webhook は
  -- route を迂回して "shopify" を実書込）を、まずこの 1 列に集める。
  channel     text NOT NULL,

  -- 既知の語彙に無かった（= 後から語彙を足すか、送り手を直すかの判断材料）。
  -- false の行は捨てられていない。**捨てないための列**。
  schema_ok   boolean NOT NULL DEFAULT true,

  -- 出来事が起きた時刻（送り手が申告）と、置き場に載った時刻（DB 側）。
  -- 2 つ持つのは、遅れて届いた出来事を「遅れて届いた」と言えるようにするため。
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  -- どの経路が書いたか（slug）。「gateway を通っていない書き込み」を後から数えられる。
  source      text NOT NULL,

  -- 冪等キー。同じ出来事は何度書いても 1 行。仕様は
  -- docs/cdp-events-gateway-contract.md「冪等キーの作り方」が正本。
  idempotency_key text NOT NULL,

  -- 出来事の中身。PII を入れる場所ではない（生の LINE userId・メール・自由文の
  -- 本文は入れない。入れてよいのは slug・番号・短い属性まで）。
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 形だけの検査（語彙は閉じない）。
  CONSTRAINT customer_events_type_form
    CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(event_type) <= 64),
  CONSTRAINT customer_events_channel_form
    CHECK (channel ~ '^[a-z][a-z0-9_]*$' AND length(channel) <= 32),
  CONSTRAINT customer_events_source_form
    CHECK (source ~ '^[a-z0-9_.\-]{1,64}$'),
  CONSTRAINT customer_events_idem_form
    CHECK (length(idempotency_key) BETWEEN 8 AND 200)
);

-- 冪等の本体。二重加算を「呼ぶ側が気をつける」ではなく制約で止める。
CREATE UNIQUE INDEX IF NOT EXISTS customer_events_idempotency
  ON customer_events (idempotency_key);

-- 「この人に何が起きたか」を時系列で引く（L1 の再計算・接客文脈の主経路）。
CREATE INDEX IF NOT EXISTS customer_events_subject_time
  ON customer_events (subject_id, occurred_at DESC);

-- 「この種類の出来事が何件あったか」（分析・入口別 CVR）。
CREATE INDEX IF NOT EXISTS customer_events_type_time
  ON customer_events (event_type, occurred_at DESC);

-- E1 の見張り。未知の型だけを安く数えられるようにする（部分 index）。
-- 「語彙から漏れた出来事が積み上がっている」を運用で気づくための唯一の窓。
CREATE INDEX IF NOT EXISTS customer_events_unknown_type
  ON customer_events (recorded_at DESC)
  WHERE schema_ok = false;

COMMENT ON TABLE customer_events IS
  'L0。顧客に起きた出来事の追記専用 1 本。解釈は持たない（persona / カルテ / セグメントは'
  ' L1 が この表から再計算する）。event_type と channel は open enum で、未知の値も'
  ' schema_ok = false として保存する（E1: 出来事は捨てない）。'
  ' 二重加算は idempotency_key の UNIQUE が構造的に止める。'
  ' ⚠ PII を入れない（生 LINE userId / メール / 会話本文は payload に載せない）。';

COMMENT ON COLUMN customer_events.schema_ok IS
  'false = 既知の語彙に無い event_type だった。**捨てた印ではなく、受け取った印**。'
  ' 部分 index customer_events_unknown_type で安く数えられる。';

COMMENT ON COLUMN customer_events.idempotency_key IS
  '同じ出来事の二重記録を止める鍵。作り方の正本は docs/cdp-events-gateway-contract.md。'
  ' 送り手が決定的に組み立てる（同じ出来事なら何度計算しても同じ文字列になる）。';

-- E4: 追記専用（トリガ関数は 040 が定義済み。例外は GDPR 消去経路のみ）。
DROP TRIGGER IF EXISTS customer_events_append_only ON customer_events;
CREATE TRIGGER customer_events_append_only
  BEFORE UPDATE OR DELETE ON customer_events
  FOR EACH ROW EXECUTE FUNCTION cdp_append_only_guard();

-- ===================================================================
-- 消した人の記録は **復活しない**
--
-- ─ なぜ要るか ─
--   消去は 1 つのトランザクションだが、その最中や直後に「消える前に投げられた
--   出来事」が届くことはありうる（gateway は fire-and-forget で、応答を待たない
--   経路から呼ばれる）。何も止めなければ、消したはずの主体に行が 1 本生えて
--   そのまま残る — 消去の約束が破れているのに、誰にも見えない形で。
--
--   検算（042 の cdp_retired_subject_orphans）はこれを **後から数える**が、
--   数えられるだけでは「消せます」を守ったことにならない。入口で止める。
--
-- ─ 例外なし ─
--   消去経路そのものは INSERT しないので、app.erasure_context の例外は要らない。
--   retire 済みの主体に行を足してよい経路は 1 つも無い。
-- ===================================================================
CREATE OR REPLACE FUNCTION cdp_reject_retired_subject() RETURNS trigger AS $$
DECLARE
  v_retired timestamptz;
BEGIN
  SELECT retired_at INTO v_retired FROM subjects WHERE subject_id = NEW.subject_id;
  IF v_retired IS NOT NULL THEN
    RAISE EXCEPTION
      'retired subject: % は消去済みの主体なので、public.% に行を足せない。'
      ' 消した人の記録は復活しない（GDPR）。新しい観測は新しい主体として発行すること。',
      NEW.subject_id, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_events_no_retired ON customer_events;
CREATE TRIGGER customer_events_no_retired
  BEFORE INSERT ON customer_events
  FOR EACH ROW EXECUTE FUNCTION cdp_reject_retired_subject();

DROP TRIGGER IF EXISTS identity_edges_no_retired ON identity_edges;
CREATE TRIGGER identity_edges_no_retired
  BEFORE INSERT ON identity_edges
  FOR EACH ROW EXECUTE FUNCTION cdp_reject_retired_subject();

-- 017 の方針に揃える（service_role のみが触る）。
ALTER TABLE customer_events ENABLE ROW LEVEL SECURITY;
