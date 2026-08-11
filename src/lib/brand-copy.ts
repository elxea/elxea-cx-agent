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

/**
 * お便り（配信）の頻度を伝える 1 行（ウェルカム共通・静けさの約束）。
 * SoT 一本化: 従来 welcome-onboarding.ts / menu-actions.ts に同一文がベタ書きされていた（drift 源）ため
 *   本定数へ集約。文面はブランドの配信ポリシー（月に1〜2回・季節の節目）を伝える既存文言のまま。
 */
export const WELCOME_DELIVERY_FREQUENCY =
  "お便りをお送りするのは月に1〜2回、季節の節目だけです。";

/**
 * QR 同梱物（マルシェ/オンライン購入の袋）から友だち追加した方への商品固有ウェルカム。
 *
 * ⚠ 監査 #3（コンテンツ/High）是正: 旧 routes/line.ts buildProductWelcomeMessage は
 *   「こんにちは！elxea へようこそ」をベタ書きし、読み仮名（エルクシア）・シングルオリジン・
 *   配信頻度を欠き、禁止語リグレッションも迂回していた。最大流入（QR 同梱）の第一印象を
 *   ブランド正本（SoT）に一本化するため、WELCOME_INTRO + 配信頻度 + 商品名差し込みで再構成する。
 *   新たなブランド文言をベタ書きしない（差し込む商品名だけが可変）。
 */
export function buildProductWelcome(productName: string): string {
  return (
    `${WELCOME_INTRO}\n\n` +
    `${WELCOME_DELIVERY_FREQUENCY}\n\n` +
    `${productName} をお届けしましたね。お楽しみいただけていますか。`
  );
}

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

/**
 * 休眠一通の「個別最適版」本文ビルダー（純粋・監査 punch-list #②-3）。
 *
 * 体験原則（統合設計書 §B / リポ CLAUDE.md・DORMANT_REENGAGEMENT_MESSAGE と同一）: 静かで丁寧・
 *   押し売り禁止・プッシュを増やさない・本文絵文字禁止・1メッセージ100文字目安。個別最適版でも
 *   売り込み・クーポン・緊急性の演出（限定/今だけ/セール等）は書かない。
 *
 * 設計: generic 版（DORMANT_REENGAGEMENT_MESSAGE）と骨格・トーンを完全に共有し、真ん中の
 *   「新しいお茶も少しずつ増えています」の 1 文だけを、その人のカルテ由来の参照句
 *   （referencePhrase・末尾が「お茶」で終わる名詞句）に差し替える。差し替えは 1 文だけなので
 *   「なぜこの文面か」が説明可能（explainable）で、挨拶・誘い（お茶の一覧へ）の構造は不変。
 *
 * @param referencePhrase カルテ由来の参照句（例: 「以前お好みだった青茶に近いお茶」）。
 *   null / 空はカルテの手がかり無し → generic 版（DORMANT_REENGAGEMENT_MESSAGE）へ倒す（無回帰）。
 * SoT: brand-copy 定数（ブランド名・読み仮名は本ファイル冒頭の正本参照）。参照句の語彙は
 *   dormant-reengagement.ts が next-cup の CATEGORY_FAMILY / persona 傾き（#2 / #②-2 と同一）から導く。
 */
export function buildDormantReengagementMessage(referencePhrase: string | null): string {
  if (!referencePhrase || referencePhrase.trim().length === 0) {
    return DORMANT_REENGAGEMENT_MESSAGE;
  }
  return (
    `こんにちは、${BRAND_NAME}（${BRAND_NAME_READING}）です。お変わりありませんか。` +
    `${referencePhrase}も、少しずつ増えています。よろしければ、お茶の一覧から今の気分に合う一杯を探してみてくださいね。`
  );
}

/**
 * カルテの「好きなカテゴリ」を、休眠一通の参照句（名詞句）に整える（純粋・#②-3）。
 * @param categoryLabel 日本語カテゴリラベル（緑茶 / 青茶 / 紅茶。next-cup.categoryLabelForPreferred 由来）。
 */
export function dormantCategoryReferencePhrase(categoryLabel: string): string {
  return `以前お好みだった${categoryLabel}に近いお茶`;
}

/**
 * persona=serenity（穏やか・まろやかな甘み寄り／診断 Q2-1）の参照句。
 * 明示カテゴリが無いときの弱い prior（persona 傾き・next-cup の personaAromaLean と同じ根拠）。
 */
export const DORMANT_TASTE_REFERENCE_SERENITY = "まろやかな甘みのあるお茶";

/**
 * persona=sensory（コク・余韻がしっかり寄り／診断 Q2-3）の参照句。
 * 明示カテゴリが無いときの弱い prior（persona 傾き・next-cup の personaBodyLean と同じ根拠）。
 */
export const DORMANT_TASTE_REFERENCE_SENSORY = "しっかりとしたコクのあるお茶";

// --- マルシェ入口「番号未送信」活性化ナッジ（spec drift #1）---

/**
 * マルシェ入口で友だち追加したが、袋の 5 桁番号を送らずに（＝お茶カード未到達で）
 * 静かになった方への、短期ホライズンの活性化ナッジ本文（spec drift #1・監査 #1）。
 *
 * 設計背景（personalization-spec §6 優先2 / Table B #1）: ジャーニーマップ §17:334 は
 *   マルシェを「最大の入口」と名指すが、番号未送信の drop-off に短期の再喚起が無かった
 *   （唯一の再エンゲージ = 休眠 60 日・本番 OFF では day-1..数日の離脱を拾えない）。ここを埋める。
 *
 * 体験原則（統合設計書 §B / リポ CLAUDE.md・DORMANT_REENGAGEMENT_MESSAGE と同一）: 静かで丁寧・
 *   押し売り禁止・プッシュを増やさない・本文絵文字禁止・1メッセージ100文字目安。売り込み・クーポン・
 *   緊急性の演出（限定/今だけ/セール等）は書かない。方向性は「挨拶」＋「5桁番号を送るとどうなるか」の
 *   静かな案内 1 文のみ（強要しない・"よろしければ" で相手の余白を残す）。
 *
 * SoT: brand-copy 定数（ブランド名・読み仮名は本ファイル冒頭の正本参照）。ウェルカムの
 *   buildMarcheResponse（welcome-onboarding.ts）と同じ「5桁の番号 → 淹れ方の案内」の約束を、
 *   時間をおいた 1 通で静かに思い出してもらう文面。
 */
export const MARCHE_ACTIVATION_MESSAGE =
  `こんにちは、${BRAND_NAME}（${BRAND_NAME_READING}）です。先日はありがとうございました。` +
  "お手元のお茶の袋に5桁の番号がありましたら、送っていただくと、そのお茶の淹れ方の目安をお伝えします。" +
  "よろしければ、いつでもどうぞ。";

// --- アカウント連携導線（定期便客限定・ブロック4）---
//
// 体験原則（統合設計書 §B / リポ CLAUDE.md）: 静かで丁寧・押し売り禁止・絵文字禁止・
//   1メッセージ100文字目安。連携そのものはご購入時のアカウント（Shopify）とこの LINE を
//   結び付ける手続きで、実際の本人確認は web-app 側のログイン（マイページ）で行う。
//   cx-agent 側は「定期便のお客さまに限って」その案内・完了・お断りの文言だけを担う。
// SoT: brand-copy 定数（ブランド名・読み仮名は上記正本を参照）。文面案からの再創作ではなく、
//   正本のブランド識別に体験原則に沿う最小限の文を足す。URL は builder が付す（本定数は素の文）。

/**
 * 未連携のお客さまが「アカウント連携」に触れたときの案内文（定期便の確認は連携が前提）。
 * URL は builder（subscriber-linkage.ts の buildLinkageInviteMessage）が末尾に付す。
 * 着地先（体験重大3対応・2026-07-17）: LIFF_LINKAGE_URL が設定されていれば LIFF（マイページ相当）へ、
 *   未設定（prod・fail-safe）は従来どおり elxea.com/ja へ。builder が env を見て URL を選ぶ。
 */
// 便益コピーの過大約束を是正（QA S-1 / CX S2・2026-07-18）: 未購入・マルシェ客にも成立しない
//   「ご注文/定期便の状況を確認できる」という約束を外し、persona で誰にでも成立する
//   「好みに合わせたご案内」だけを残す。
export const LINKAGE_INVITE_BODY =
  "ご購入時のアカウントとこのトークを連携すると、あなたの好みに合わせたご案内を、このトークで受け取れるようになります。" +
  "お手数ですが、マイページからアカウント連携をお願いします。";

/**
 * 連携の便益を伝える 1 行（トーク内入り口 = 完全一致トリガー / ④定期便の未連携分岐で共通・ブロック4）。
 * 体験原則（統合設計書 §B / リポ CLAUDE.md）: 静か・絵文字/感嘆符なし・押し売りなし。
 *   連携で「何ができるようになるか」を 1 文で伝えるにとどめ、緊急性・お得さの演出はしない。
 * SoT: 本定数。文面は正本のブランド識別に、体験原則に沿う便益 1 文を足したもの。
 */
export const LINKAGE_BENEFIT_LINE =
  "連携すると、あなたの好みに合わせたご案内を、このトークで受け取れるようになります。";

/** 連携ボタンのラベル（LIFF を開く URI アクション・トリガー LINKAGE_TRIGGER と同一表記）。 */
export const LINKAGE_BUTTON_LABEL = "アカウントを連携する";

/**
 * 連携ボタンの有効期限を添える一文（linkToken の TTL 失効の UX 手当・ブロック4）。
 * linkToken はお客さまごとに毎回新規発行され有効期限（およそ 10 分）を持つため、時間が経つと
 *   ボタンが開けなくなる。開けなくなったお客さまが自力で再発行に戻れるよう、静かに再送手順を添える。
 * 体験原則: 静か・絵文字/感嘆符なし・押し売りなし。再送トリガーは LINKAGE_BUTTON_LABEL と同一表記。
 */
export const LINKAGE_TOKEN_EXPIRY_NOTE =
  `このボタンは10分ほど有効です。うまく開けないときは、お手数ですが、もう一度「${LINKAGE_BUTTON_LABEL}」とお送りください。`;

/**
 * マルシェ・イベント流入（welcome.source=marche）のお客さまが連携に触れたときの、静かな受け止め（CX S1/S2）。
 * マルシェ客はオンラインのご購入アカウントを持たないことが多く、連携を促すと LIFF→ログインの
 *   袋小路（空振り連携）になりやすい。連携ボタンは出さず、押し売りにならないよう静かに着地する。
 */
export const MARCHE_LINKAGE_SOFT_ACK =
  "elxea をマルシェで見つけてくださって、ありがとうございます。アカウント連携は、オンラインのご購入アカウントをお持ちの方へのご案内です。" +
  "まずはこのトークで、お茶えらびのご相談など、お気軽にお声がけくださいね。";

/**
 * 連携が完了し、定期便のご契約が確認できたお客さまへの応答（定期便客としての受け止め）。
 */
export const SUBSCRIBER_LINKED_BODY =
  "アカウントの連携が完了しました。いつも定期便をご利用いただきありがとうございます。" +
  "お届け中のプランやお届け日のご確認は、このままメッセージでお気軽にお尋ねくださいね。";

/**
 * 連携はできたが定期便のご契約が見当たらないお客さまへの、静かな着地（CX S1・突き放し感を減らす）。
 * 「定期便契約者にだけお届けしています」という線引き（角の立つ言い回し）はやめ、まず連携の便益
 *   （好みに合わせた案内）を受け止め、定期便は希望時のご案内に留める。URL は builder が付す。
 */
export const NON_SUBSCRIBER_DECLINE_BODY =
  "アカウントの連携が完了しました。これからは、あなたの好みに合わせたご案内を、このトークでお届けしますね。" +
  "定期便のご案内をご希望のときは、こちらからいつでもご覧いただけます。";

// --- アカウント連携（LINE 純正 Account Link）の完了・解除 ---
//
// LINE の必須義務（出典: https://developers.line.biz/ja/docs/messaging-api/linking-accounts/）:
//   「ユーザーがいつでもアカウントの連携を解除できるようにしておくこと。
//     ユーザーが連携するときに、解除できることを通知すること。」
//   → 完了文言（ACCOUNT_LINK_COMPLETED_BODY）に解除の手段を必ず書く。これは体験上の親切ではなく
//     仕様上の義務なので、文言を削るときも解除の一文だけは残すこと。
// 体験原則: 静かで丁寧・絵文字/感嘆符なし・押し売りなし。

/** 連携を解除するためのトリガー文（完全一致・ユーザーが送る言葉。文言と実装で共有する SoT）。 */
export const ACCOUNT_LINK_UNLINK_TRIGGER = "連携を解除する";

/**
 * 解除できる旨のご案内（1 文）。連携完了時の通知に必ず含める（LINE 必須義務）。
 * 解除完了の文言でも「また連携できる」ことを伝えるために再利用する。
 */
export const ACCOUNT_LINK_UNLINK_NOTE =
  `連携はいつでも解除できます。解除したいときは、このトークで「${ACCOUNT_LINK_UNLINK_TRIGGER}」とお送りください。`;

/** 連携が成立したときにお伝えする文言（accountLink イベント成功時）。解除の案内を含む。 */
export const ACCOUNT_LINK_COMPLETED_BODY =
  "アカウントの連携が完了しました。ご注文やお届けの状況を、このままメッセージでご確認いただけます。\n" +
  ACCOUNT_LINK_UNLINK_NOTE;

/** 連携解除が完了したときの文言（また連携できることを添える）。 */
export const ACCOUNT_LINK_UNLINKED_BODY =
  "アカウントの連携を解除しました。これまでのご案内はこのトークに残ります。" +
  `また連携されるときは、「${LINKAGE_BUTTON_LABEL}」とお送りください。`;

/** 連携していないお客さまが解除をご希望のときの文言（何も壊さずお伝えする）。 */
export const ACCOUNT_LINK_NOT_LINKED_BODY =
  "現在、連携されているアカウントはありません。" +
  `ご購入時のアカウントと連携されるときは、「${LINKAGE_BUTTON_LABEL}」とお送りください。`;

/** 解除の処理がうまくいかなかったときの文言（断定せず、もう一度をお願いする）。 */
export const ACCOUNT_LINK_UNLINK_FAILED_BODY =
  "解除の処理に少し時間がかかっているようです。恐れ入りますが、もう一度お送りいただけますか。";

// --- 評価後の「次の一杯」（A-2a・個別最適化 Phase A）---
//
// 体験原則（統合設計書 §B / リポ CLAUDE.md）: 静かで丁寧・押し売り禁止・本文絵文字禁止・
//   1メッセージ100文字目安。評価（+1/-1）への受け止めは、感謝や共感を短く伝えるにとどめ、
//   「買ってください」「今だけ」等の演出はしない。次の一杯の提案は「よろしければ」の一言添えで、
//   1件だけ・断りやすい形にする（押し売りにしない）。
// SoT: brand-copy 定数。文面案からの再創作ではなく、体験原則に沿う最小限の文を置く。

/**
 * 「おいしかった」(+1) を受け取ったお礼（A-2a）。お口に合った喜びを短く伝える。
 * この後に、候補があれば nextCupSuggestionSentence の一文を 1 件だけ添える（builder が付す）。
 */
export const NEXT_CUP_GOOD_THANKS =
  "ありがとうございます。お口に合ったようで、うれしいです。";

/**
 * 「好みと少し違った」(-1) の直後に返す、静かな受け止めの一文（A-2a）。
 * 設計 v2「-1 直後は提案ゼロ・静かに受け止める」。提案・誘導・演出をしない（引く挙動）。
 */
export const NEXT_CUP_DECLINE_MESSAGE =
  "好みは人それぞれですね。気が向いたら、また別のお茶ものぞいてみてくださいね。";

/**
 * 「次の一杯」の提案文（A-2a・候補が 1 件見つかったときのみ builder が付す）。
 * 押し売りにしない「よろしければ」添え・1 件のみ。銘柄は `番号｜名前`（formatTeaLabel）で差し込む。
 */
export function nextCupSuggestionSentence(name: string, number: string): string {
  return `よろしければ、次はこんな一杯もどうぞ。\n${formatTeaLabel({ name, number })}`;
}

// --- お茶の正準ラベル（UX① 番号｜名前の統一・SoT）---
//
// オーナー要望（2026-07 改訂）: ユーザーに見える全お茶参照を `番号｜名前`（例:
// `10101｜春摘みやぶきたの和紅茶`）に統一する。番号を先頭にし、全角パイプ `｜` で名前へ繋ぐ。
// 旧形は `名前（No.XXXXX）`。既存文面（nextCupSuggestionSentence / buildTeaCard / 診断結果 等）
// はこの正準関数を通しているため、本関数の変更だけで全サイトが新形へ追随する（表示・ラベル専用・挙動不変）。
//
// Notion「Tea Menu List」DB の対応（読み取り時の出所）:
//   - 番号 = `Menu Number`（formula・5 桁）/ 生データは `Menu No.`（text）。
//   - 名前 = `Menu Name`（title）。
//   - 参考: 既存の combined formula `Menu No. & Name` も存在するが、cx-agent は
//     同期済みデータ層の number/name を持つため、ここで `${番号}｜${名前}` を合成する。

/**
 * お茶の正準ラベル `番号｜名前`（UX① 統一の SoT・全角パイプ）。
 * name が空 / number と同一（表示名フォールバック時）は冗長回避で `番号` のみを返す
 *   （`11301｜11301` を防ぐ）。番号は決して落とさない。
 */
export function formatTeaLabel(tea: { name: string; number: string }): string {
  const name = tea.name.trim();
  if (!name || name === tea.number) return tea.number;
  return `${tea.number}｜${name}`;
}

/**
 * LINE quick reply ラベル用の正準ラベル（番号保全 truncate・UX①）。
 *
 * LINE の quick reply ラベルは表示上限（既定 20 字）がある。`番号｜名前` は**番号が先頭**なので、
 * 末尾 truncate すると切れるのは**名前側**（番号は温存される）。本関数は `番号｜`（＝番号部）を
 * 必ず丸ごと温存し、**名前側だけ**を `…` で詰めて max に収める（番号は絶対に切らない）。
 * name が空 / number と同一なら `番号` のみ（既に十分短い）。
 */
export function formatTeaQuickReplyLabel(
  tea: { name: string; number: string },
  max = 20,
): string {
  const name = tea.name.trim();
  if (!name || name === tea.number) return tea.number;
  const numberPrefix = `${tea.number}｜`; // 例: 10101｜ ＝ 5 桁+パイプで 6 字固定。絶対に切らない。
  const full = `${numberPrefix}${name}`;
  if (full.length <= max) return full;
  // 番号部は必ず残し、名前に使える字数だけを名前側から確保する（… の 1 字を見込む）。
  const room = max - numberPrefix.length;
  if (room <= 1) return tea.number; // max が極端に小さい場合でも番号だけは温存する。
  return `${numberPrefix}${name.slice(0, room - 1)}…`;
}

// --- 送客リンク（購入導線・Sales S-1・全チャネル最安の一手）---
//
// 体験原則（統合設計書 §B / リポ CLAUDE.md）: 静かで丁寧・押し売り禁止・絵文字/感嘆符なし。
//   高インテント地点（お茶カード末尾・評価後の次の一杯）に、断りやすい送客リンクを 1 本だけ添える。
//   連携不要・全チャネル（LINE/Web/マルシェ）に効く。送客先は既存の公式サイト URL を再利用（新設しない）。
// SoT: 本定数（URL は SITE_URL_JA を再利用）。

/**
 * お茶カード末尾・次の一杯に添える静かな送客リンク 1 行（Sales S-1）。
 * 「よろしければ」添えで断りやすく、緊急性・お得さの演出はしない。
 */
export const TEA_SHOP_REFERRAL_LINE =
  `よろしければ、こちらからもご覧いただけます。\n${SITE_URL_JA}`;
