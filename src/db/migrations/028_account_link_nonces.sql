-- 028: account_link_nonces — LINE Account Link の nonce を一時保存する（one-time + TTL）
--
-- 背景・設計（一次情報）:
--   https://developers.line.biz/ja/docs/messaging-api/linking-accounts/
--   本番 OA（Messaging チャネル）と連携用 LIFF が別プロバイダのため、LIFF/LINE Login 由来の
--   id_token では「Messaging userId と同一の sub」を得られず本番化できなかった。
--   LINE 純正の Account Link は **LINE Login チャネル不要**で、Messaging チャネルだけで
--   「Bot が linkToken を発行 → 自社ログイン → nonce 付きで LINE の accountLink ダイアログへ →
--    Messaging チャネルの webhook に accountLink イベント（source.userId = Messaging userId）」
--   が成立する。プロバイダ統一が不要になる。
--
-- このテーブルが担うこと（唯一の役割）:
--   「自社側で本人確定した Shopify 顧客 ID」を、LINE から戻ってくるまでの数分間だけ
--   nonce をキーに預かる。accountLink イベントで nonce を消費して顧客 ID を引き当て、
--   customer_linkages に連携行を書く。**nonce は連携の唯一の橋渡し**であり、
--   予測されると他人の連携先を乗っ取れるため、以下を機械的に強制する。
--
-- 採番の根拠（衝突回避）:
--   026 は `026_customer_linkage_source.sql` と `026_marche_activation_log.sql` の 2 本が
--   既に master に存在する（採番衝突が発生済み）。027 は `027_customer_linkage_cardinality.sql`
--   が未マージ枝（feat/cx-review-fixes）で確保済み。よって衝突しない最小の番号は 028。
--
-- 安全設計（014_pending_follow_refs.sql の one-time + TTL + RLS service-role only に倣う）:
--   - nonce を主キーにする（同一 nonce の二重発行を DB が拒否する）。
--   - expires_at（短 TTL）を必須にし、期限切れは消費側が弾く。
--   - consumed_at で一度きりの消費を記録する（アプリ側は
--     `UPDATE ... WHERE nonce=? AND consumed_at IS NULL AND expires_at > now()` の
--     単一 UPDATE + RETURNING で消費する = 同時到達しても 1 回しか成立しない）。
--   - RLS を有効化しポリシーを 1 つも作らない（= service role 以外は読めない・書けない）。
--     nonce が漏れると連携を横取りできるため、anon/authenticated からの到達を構造的に断つ。
--
-- 冪等性: CREATE TABLE / INDEX とも IF NOT EXISTS。再実行安全。
-- 適用: staging に先行適用 → Setaka 承認後に本番（本ファイルが prod 用 SQL も兼ねる）。
--       ⚠ 本タスクでは適用しない（ファイル追加のみ）。

CREATE TABLE IF NOT EXISTS account_link_nonces (
  -- LINE 仕様: 予測困難・一度きり・10〜255 文字。アプリ側は CSPRNG 192bit を base64url 化した
  -- 32 文字を入れる（src/lib/account-link.ts の generateNonce）。
  nonce text PRIMARY KEY,
  -- 自社側で本人確定した Shopify 顧客 ID（数値文字列・customer_linkages と同じ表現）。
  shopify_customer_id text NOT NULL,
  -- 短 TTL（アプリ既定 5 分）。linkToken 自体が 10 分・1 回限りのため、これ以上長くしても意味がない。
  expires_at timestamptz NOT NULL,
  -- 消費済み時刻。NULL のときだけ消費できる（single-use の担保）。
  consumed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 期限切れレコードの掃除・消費時の絞り込み用。
CREATE INDEX IF NOT EXISTS idx_account_link_nonces_expires
  ON account_link_nonces (expires_at);

-- RLS: サービスロールのみアクセス可（ポリシーを作らない = service role 以外は全拒否）。
ALTER TABLE account_link_nonces ENABLE ROW LEVEL SECURITY;
