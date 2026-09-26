/**
 * セグメント別配信メッセージテンプレート
 *
 * ペルソナ別にトーンを変えたメッセージテンプレートを管理する。
 * 配信制約: 購入事実を直接参照しない（「お茶はいかがでしたか」ではなく季節・シーン提案）
 *
 * テンプレート設計:
 * - serenity: 静かで短い。間を大切にする表現
 * - explorer: 科学的・歴史的。発見感のある情報提供
 * - sensory: 官能的・感覚的。味わいの描写を中心に
 */

import type { PersonaType } from "./firestore";
import { EC_SITE_OPEN, EC_STORE_URL } from "./storefront";

// ---------------------------------------------------------------------------
// テンプレート型定義
// ---------------------------------------------------------------------------

export type BroadcastTemplate = {
  /** テンプレート ID（配信ログ記録用） */
  id: string;
  /** テンプレート本文（改行含む） */
  text: string;
  /** 対象ペルソナ */
  persona: PersonaType;
  /** 季節タグ（配信時期に合うものを選択） */
  season: "spring" | "summer" | "autumn" | "winter" | "all";
};

// ---------------------------------------------------------------------------
// 季節判定
// ---------------------------------------------------------------------------

/**
 * 月から季節を判定する（日本の四季基準）。
 *
 * 3-5月: spring / 6-8月: summer / 9-11月: autumn / 12-2月: winter
 */
export function getCurrentSeason(
  month?: number,
): "spring" | "summer" | "autumn" | "winter" {
  const m = month ?? new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

// ---------------------------------------------------------------------------
// テンプレートデータ
// ---------------------------------------------------------------------------

/**
 * C-16（文言 v2）: 季節の配信テンプレートの本文末尾に付けるサイトの URL（開店時だけ）。
 *
 * 開店時は master の各本文と同じ `本文 + "\n\n" + https://elxea.com/ja`（1 文字も変えない）。
 * 公式 EC が閉じている間は末尾の URL 部分だけを付けない（本文はそのまま）。季節のお便りで商品の
 * おすすめではないため、Amazon へは向けない（roji の決めごと: 勧誘しない）。15 件をこの 1 つの関数で切り替える。
 * @param siteOpen 公式 EC が開店しているか（既定 EC_SITE_OPEN。テストは両方を渡して固定する）
 */
export function withBroadcastSiteLink(body: string, siteOpen: boolean = EC_SITE_OPEN): string {
  return siteOpen ? `${body}\n\n${EC_STORE_URL}` : body;
}

/**
 * 全テンプレート。ペルソナ x 季節の組み合わせで用意。
 *
 * 配信時は現在の季節 + "all" にマッチするテンプレートから
 * ランダムに1つ選択する。
 */
export const BROADCAST_TEMPLATES: BroadcastTemplate[] = [
  // ---- serenity: 静かで短い ----
  {
    id: "serenity-spring-01",
    persona: "serenity",
    season: "spring",
    text: withBroadcastSiteLink("桜の季節ですね。\n\n温かいお茶を片手に、窓の外をぼんやり眺める時間も悪くないですよ。"),
  },
  {
    id: "serenity-summer-01",
    persona: "serenity",
    season: "summer",
    text: withBroadcastSiteLink("暑い日が続きますね。\n\n水出しのお茶を冷蔵庫に忍ばせておくと、ふとした瞬間にほっとします。"),
  },
  {
    id: "serenity-autumn-01",
    persona: "serenity",
    season: "autumn",
    text: withBroadcastSiteLink("少し涼しくなってきましたね。\n\n温かいほうじ茶の香りが、秋の夜にそっと寄り添います。"),
  },
  {
    id: "serenity-winter-01",
    persona: "serenity",
    season: "winter",
    text: withBroadcastSiteLink("寒い日は、手のひらを温めるように湯呑みを包んでみてください。\n\nそれだけで少し、心がゆるみます。"),
  },
  {
    id: "serenity-all-01",
    persona: "serenity",
    season: "all",
    text: withBroadcastSiteLink("お茶の時間は、何もしなくていい時間。\n\n今日も、静かなひとときを。"),
  },

  // ---- explorer: 科学的・歴史的 ----
  {
    id: "explorer-spring-01",
    persona: "explorer",
    season: "spring",
    text: withBroadcastSiteLink("春は新茶の季節。\n\n冬の間じっくり蓄えた旨味成分が、一番茶にぎゅっと凝縮されています。製法によって生まれる味の違い、探ってみませんか。"),
  },
  {
    id: "explorer-summer-01",
    persona: "explorer",
    season: "summer",
    text: withBroadcastSiteLink("実は、水出し緑茶にはテアニンが多く溶け出すことをご存知ですか。\n\n低温でじっくり抽出すると、旨味が際立ちます。夏は実験にぴったりの季節です。"),
  },
  {
    id: "explorer-autumn-01",
    persona: "explorer",
    season: "autumn",
    text: withBroadcastSiteLink("秋摘みの茶葉は、春とはまた違う味わいを持っています。\n\n日照時間や気温の変化が、茶葉の化学組成にどう影響するか。飲み比べてみると面白いですよ。"),
  },
  {
    id: "explorer-winter-01",
    persona: "explorer",
    season: "winter",
    text: withBroadcastSiteLink("日本各地の茶畑では、冬の間も生産者さんが土づくりに励んでいます。\n\nその手間が、来春の一番茶に結実します。産地を訪ねるような気持ちで、一杯いかがですか。"),
  },
  {
    id: "explorer-all-01",
    persona: "explorer",
    season: "all",
    text: withBroadcastSiteLink("同じ品種でも、産地や製法で味がまったく変わるのがお茶の面白さ。\n\n新しい発見があるかもしれません。"),
  },

  // ---- sensory: 官能的・感覚的 ----
  {
    id: "sensory-spring-01",
    persona: "sensory",
    season: "spring",
    text: withBroadcastSiteLink("春の新茶は、若葉のような青々しい香りと、ふわっと広がる甘み。\n\n口に含んだ瞬間の鮮やかさを、ぜひ味わってみてください。"),
  },
  {
    id: "sensory-summer-01",
    persona: "sensory",
    season: "summer",
    text: withBroadcastSiteLink("氷を浮かべた冷茶、ひと口目のすっきりとした清涼感。\n\n暑い日にこそ、味わいの輪郭がくっきり際立ちます。"),
  },
  {
    id: "sensory-autumn-01",
    persona: "sensory",
    season: "autumn",
    text: withBroadcastSiteLink("ほうじ茶を淹れた瞬間に立ち上る、香ばしくて甘い香り。\n\nまろやかなコクと、すっと消える余韻。秋の夜長にぴったりの一杯です。"),
  },
  {
    id: "sensory-winter-01",
    persona: "sensory",
    season: "winter",
    text: withBroadcastSiteLink("熱めのお湯で淹れた玉露の、とろりとした旨味。\n\n舌の上でゆっくり転がすと、甘みの奥に海苔のような香りが。冬の贅沢です。"),
  },
  {
    id: "sensory-all-01",
    persona: "sensory",
    season: "all",
    text: withBroadcastSiteLink("お茶の味わいは「甘み・渋み・苦み・旨味」のバランスで決まります。\n\n今の気分にぴったりの一杯、見つけてみませんか。"),
  },
];

// ---------------------------------------------------------------------------
// テンプレート選択
// ---------------------------------------------------------------------------

/** デフォルトのランダムセレクタ（配列からランダムに1つ選択） */
function defaultSelector<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * 指定ペルソナ + 現在の季節に合うテンプレートを1つ返す。
 *
 * 該当テンプレートがない場合は "all" 季節のものから選択する。
 *
 * @param persona 対象ペルソナ
 * @param season 季節（省略時は現在の季節）
 * @param options.selector 配列から1つを選択する関数（テスト時に注入可能、デフォルトは Math.random ベース）
 */
export function selectTemplate(
  persona: PersonaType,
  season?: "spring" | "summer" | "autumn" | "winter",
  options?: { selector?: <T>(items: T[]) => T },
): BroadcastTemplate {
  const currentSeason = season ?? getCurrentSeason();
  const pick = options?.selector ?? defaultSelector;

  // 対象ペルソナのテンプレートを季節でフィルタ
  const seasonalMatch = BROADCAST_TEMPLATES.filter(
    (t) =>
      t.persona === persona &&
      (t.season === currentSeason || t.season === "all"),
  );

  if (seasonalMatch.length === 0) {
    // フォールバック: ペルソナだけでフィルタ
    const personaMatch = BROADCAST_TEMPLATES.filter(
      (t) => t.persona === persona,
    );
    return pick(personaMatch);
  }

  return pick(seasonalMatch);
}
