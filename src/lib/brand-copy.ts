/**
 * ユーザー向けブランド文言の正本集約（single source of truth）。
 *
 * ⚠ 変更ルール（リポ CLAUDE.md にも明記）:
 *   ユーザー向けブランド文言を新規・変更するときは、必ず以下の正本に突合してから書く。
 *   Spec や設計書の「文面案」からの再創作は禁止（文面案は正本ではない）。
 *
 * 正本（SoT）:
 *   - elxea-brand-context skill:
 *     /Users/setaka/github/elxea/agents/_shared/skills/elxea-brand-context/SKILL.md
 *   - About elxea | elxeaについて: https://www.notion.so/154f0d9de112457c83c62fb5b56b1788
 *   - Corporate Info DB（会社基本情報の一次情報源）:
 *     https://www.notion.so/fc8c353f9650453c9707ae0a806ae484
 *
 * 監査経緯（2026-07-13）: 「エルシア」「鹿児島を中心」「スキンケア」「合同会社」「日常に静かな豊かさを」
 *   等の非正本文言がユーザー向けに混入していたため是正し、本ファイルに集約した。
 */

// --- ブランド識別（brand-context skill）---

/** ブランド名（英字表記）。 */
export const BRAND_NAME = "elxea";

/** ブランド名の読み仮名。「エルシア」ではない（brand-context skill）。 */
export const BRAND_NAME_READING = "エルクシア";

/** 法人名。「合同会社」ではない（brand-context skill / Corporate Info DB）。 */
export const COMPANY_NAME = "株式会社elxea";

/** スローガン / タグライン（About elxea「Slogan / Tagline」）。 */
export const BRAND_TAGLINE = "日常の中にきらめきを感じられる一杯をあなたにも。";

/**
 * ブランドステートメント（brand-context skill「ブランドステートメント（正本）」）。
 * 産地は日本各地に限定。「世界を巡って厳選」「鹿児島を中心」等の表現は使わない。
 */
export const BRAND_STATEMENT_SHORT =
  "日本各地のこだわりの小規模茶農家さんから厳選した、シングルオリジン茶葉によるクラフトティーのブランドです。";

/** 取扱カテゴリ（brand-context skill）。 */
export const TEA_CATEGORIES = "緑茶・烏龍茶・紅茶";

/** 問い合わせメール（brand-context skill / Corporate Info DB の一次情報）。 */
export const SUPPORT_EMAIL = "info@elxea.com";

/** 公式サイト（日本語）。 */
export const SITE_URL_JA = "https://elxea.com/ja";

// --- 再利用ブランド紹介ブロック（各メッセージビルダーが参照）---

/**
 * ⑤ elxea について のブランド紹介本文（末尾の AI 開示・配信頻度は各ビルダーが付す）。
 * 出典: brand-context skill（ブランドステートメント）+ About elxea（テロワール・産地の物語）。
 */
export const ABOUT_BLURB =
  `${BRAND_NAME}（${BRAND_NAME_READING}）は、${BRAND_STATEMENT_SHORT}\n\n` +
  "シングルオリジン（単一農園・単一品種）の茶葉は、それぞれの産地で小規模茶農家さんが大切に育てたもの。産地ごとの個性（テロワール）を、つくり手の物語とともにお届けしています。";

/** 友だち追加ウェルカムの導入文（brand-context ステートメント準拠）。 */
export const WELCOME_INTRO =
  `こんにちは！${BRAND_NAME}（${BRAND_NAME_READING}）へようこそ。\n\n` +
  "日本各地の小規模茶農家さんから厳選した、シングルオリジン（単一農園・単一品種）のお茶を、あなたにぴったりの一杯としてお届けします。";

/** オンボーディング「お茶を探す」導入文。 */
export const ONBOARDING_EXPLORE_INTRO =
  `${BRAND_NAME} では、日本各地の小規模茶農家さんから厳選したシングルオリジンのお茶を取り揃えています。`;

/** オンボーディング「elxea について」本文。 */
export const ONBOARDING_ABOUT_BODY =
  `${BRAND_NAME} は、${BRAND_STATEMENT_SHORT}\n\n` +
  "日本各地の小規模茶農家さんが大切に育てた茶葉を、生産者のストーリーと一緒にお届けしています。気になることがあれば、何でも聞いてくださいね。";

// --- 休眠検知の「静かな一通」（ブロック3-B）---

/**
 * 休眠中の友だちへの「静かな一通」本文（ブロック3-B）。
 *
 * 体験原則（統合設計書 §B / リポ CLAUDE.md）: 静かで丁寧・押し売り禁止・プッシュを増やさない・
 *   本文絵文字禁止・1メッセージ100文字目安。方向性は「挨拶」＋「お茶の一覧への静かな誘い 1 文」のみ。
 *   売り込み・クーポン・緊急性の演出（限定/今だけ/セール等）は書かない。
 *
 * SoT: brand-copy 定数（ブランド名・読み仮名は上記正本を参照）。文面は Spec の文面案からの
 *   再創作ではなく、正本のブランド識別（elxea／エルクシア）に、体験原則に沿う最小限の誘い 1 文を足す。
 */
export const DORMANT_REENGAGEMENT_MESSAGE =
  `こんにちは、${BRAND_NAME}（${BRAND_NAME_READING}）です。お変わりありませんか。` +
  "新しいお茶も少しずつ増えています。よろしければ、お茶の一覧から今の気分に合う一杯を探してみてくださいね。";
