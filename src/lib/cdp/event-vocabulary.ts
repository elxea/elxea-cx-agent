/**
 * @layer CDP
 *
 * L0 の語彙登録簿（open registry）— CDP 統合 Stage 1 / 設計 §5 E1 / 欠陥 D3・D4。
 *
 * ─ いま何が壊れているか ─
 *
 * 「その人に何が起きたか」を表す語彙が経路ごとに違う。
 *
 *   行動語彙（D3・三分裂）
 *     - cx-agent  `BehaviorAction`（src/lib/firestore.ts）… 14 値
 *     - web-app   `BehaviorAction`（lib/firebase/types.ts）… 10 値
 *     - web-app   `BehaviorActionSchema`（lib/validation/behavior-schema.ts・zod）… 7 値
 *   channel（D4・4 者食い違い）
 *     - zod は 3 値（web / line / shopify）を受理
 *     - TS の型は 2 値（line / web）
 *     - web の route は "web" 固定
 *     - 注文 webhook は route を迂回して channel:"shopify" を実書込
 *
 * 語彙が合わないと、合わない側の出来事が **捨てられる**（cx-agent 側は
 * src/routes/web.ts の VALID_WEB_EVENTS が 400 を返す 1 か所）。
 *
 * ─ ここが何をするか ─
 *
 * L0（customer_events）に載せる語彙を **1 か所に集める**。ただし閉じない:
 *
 *   既知の語彙   … ここに載っている。schema_ok = true で保存される。
 *   未知の語彙   … 弾かない。schema_ok = false を立てて **保存する**（E1）。
 *
 * 「知らない出来事が起きた」を「無かったこと」に変えないための非対称である。
 * 未知が積み上がったら、語彙を足すか送り手を直すかを人が決める（部分 index
 * customer_events_unknown_type がその窓）。
 *
 * ─ 型で drift を捕まえる ─
 *
 * 既存の 2 つの語彙（BehaviorAction / FlowEventName）は **型として取り込み**、
 * 網羅していなければ tsc が落ちる。片方に値を足して登録簿に足し忘れる、が起きない。
 * 値そのものはここに列挙する（import した union を実行時に展開できないため）。
 */

import type { BehaviorAction } from "../firestore";
import type { FlowEventName } from "../flow-events";
import { isTasteAxis, isTastePole } from "./taste-axes";

/** 型レベルの網羅アサート。false になると tsc が落ちる。 */
type Assert<T extends true> = T;

// ---------------------------------------------------------------------------
// 行動語彙（Firestore behaviorLog 由来）
// ---------------------------------------------------------------------------

/**
 * cx-agent の `BehaviorAction` 全 14 値 + web-app 側にしか無い `audio_play`。
 *
 * web-app の 10 値・zod の 7 値はいずれもこの集合の部分集合になる
 * （唯一 cx-agent に無かったのが audio_play で、ここで合流させる）。
 */
export const BEHAVIOR_ACTIONS = [
  "tap_button",
  "view_content",
  "view_product",
  "purchase",
  "line_message",
  "search",
  "tea_mention",
  "flavor_preference",
  "topic_interest",
  "chat_started",
  "product_viewed",
  "cart_link_clicked",
  "feedback_given",
  "survey_completed",
  // web-app 側にだけ存在した値（記事内の音声の再生開始）。
  "audio_play",
] as const;

/** cx-agent の BehaviorAction を 1 つも取りこぼしていないこと。 */
type _BehaviorCoverage = Assert<
  BehaviorAction extends (typeof BEHAVIOR_ACTIONS)[number] ? true : false
>;

// ---------------------------------------------------------------------------
// フロー語彙（Supabase flow_events 由来）
// ---------------------------------------------------------------------------

/** `FlowEventName` の全値。足したらここにも足す（足し忘れは下の Assert が落とす）。 */
export const FLOW_EVENT_NAMES = [
  "menu.tap",
  "welcome.tap",
  "welcome.source",
  "tea.list_view",
  "tea.card_view",
  "tea.item_view",
  "tea.number_miss",
  "diag.start",
  "diag.answer",
  "diag.invalid",
  "diag.result",
  "consult.entry",
  "optout.request",
  "optout.confirm",
  "link.invite_shown",
  "link.completed",
  "link.unlinked",
  "next_cup_shown",
  "onboarding.complete",
  "read.completed",
  "feedback.shown",
  "nextmonth.shown",
  "survey.start",
  "survey.decline",
  "survey.answer",
  "survey.end",
  "survey.confirm",
  "survey.estimate_shown",
  "survey.estimate_corrected",
  "survey.words_prompt",
  "survey.words_saved",
  "survey.quote_consent",
  "survey.finished",
] as const;

type _FlowCoverage = Assert<
  FlowEventName extends (typeof FLOW_EVENT_NAMES)[number] ? true : false
>;

// ---------------------------------------------------------------------------
// L0 の event_type
// ---------------------------------------------------------------------------

/**
 * L0 の型名は `<領域>.<出来事>` に揃える。領域を前置するのは、3 つの語彙が
 * 同じ平面に載ったときに由来が消えないようにするため（`purchase` が
 * 行動語彙の 1 値なのか購入そのものなのかを、名前だけで言えるようにする）。
 */
export const EVENT_TYPE_PREFIX = {
  behavior: "behavior.",
  flow: "flow.",
} as const;

/** 行動語彙の 1 値を L0 の event_type にする。 */
export function behaviorEventType(action: string): string {
  return `${EVENT_TYPE_PREFIX.behavior}${action}`;
}

/** フロー語彙の 1 値を L0 の event_type にする（`.` は `_` へ畳む）。 */
export function flowEventType(name: string): string {
  return `${EVENT_TYPE_PREFIX.flow}${name.replace(/\./g, "_")}`;
}

/**
 * 「誰に・いつ・どのお茶を・どの号を送ったか」を L0 に載せる型名。
 *
 * ─ purchase.order_paid と何が違うのか（別の出来事である理由）─
 *   購入は「注文が成立した」、送付は「手元に届いた」。ずれることがある
 *   （欠品・変更・返品・マルシェの手渡し・EC 開店前の実配送）。roji の正本も
 *   決めたこと（migration 033）と届いたこと（038）を別の事実として分けている。
 *   同じ型名に畳むと、届いていない注文が「送った」として数えられる。
 *
 * ─ 数の正本はどこか ─
 *   詳しい正本は台帳 `tea_delivery_ledger`（038）の側に残す。L0 に積むのは
 *   「その主体の身に送付が 1 回起きた」という時系列の事実で、payload の形と
 *   読み口は `src/lib/cdp/shipment.ts` が持つ。
 */
export const SHIPMENT_SENT_EVENT_TYPE = "shipment.sent";

/**
 * 領域名を前置しない、独立した出来事。
 *
 * `diagnosis.answer` は設計 §4 の #14（茶葉診断 Web 入口）の「口」にあたる。
 * 画面は Stage 4 だが、受け口だけ先に開けておく（口を先に・画面は後）。
 */
export const STANDALONE_EVENT_TYPES = [
  "purchase.order_paid",
  "survey.answer_recorded",
  "diagnosis.answer",
  SHIPMENT_SENT_EVENT_TYPE,
] as const;

// 注: `rating.submitted` は 2026-09-01 に STANDALONE から PROFILE_EVENT_TYPES へ移した
//   （顧客プロファイル 第1段 ①）。届いた後の評価が L1 の材料になったので、payload の形を
//   見る側（＝解釈に使う側）に入れる必要が出たため。語彙名は変えていないので、
//   既に積まれている行の event_type はそのまま読める。

// ---------------------------------------------------------------------------
// Stage 4: 解釈（L1）を動かす出来事
// ---------------------------------------------------------------------------

/**
 * L1（subject_profile）の値を動かす出来事の語彙（設計 §4 #18 / §6-1 Stage 4）。
 *
 * ─ なぜ「出来事」として置くのか ─
 *
 *   事前通知への変更・安全に関する申告・本人訂正には、いま**置き場が無い**（#18）。
 *   置き場を作るとき、L1 の列に直接書ける口を開けると「解釈を直接書き換える経路」が
 *   でき、L1 が L0 から再計算できなくなる（Stage 4 の不変条件が壊れる）。
 *   よって受け口は **L0 に 1 行積むだけ**にして、L1 はそれを畳んだ結果にする。
 *   畳み方の正本は cdp_l1_build_profile 1 か所（046 が置き、051 が差し替えた版）。
 *
 * ─ 一覧（畳まれ方は cdp_l1_build_profile の CASE と 1 対 1）─
 *
 *   persona.baseline_imported … 移行の起点。Firestore に既に貯まっていた点を 1 回だけ載せる
 *   persona.signal_applied    … 点が動いた 1 回分（出所と増減）
 *   exclusion.set / .cleared  … 「もういらない」（項目13 noneOf）。解除できる
 *   safety.declared           … 安全に関する申告（項目6）。**減らす方向に畳まない**
 *   notify.preference_set     … 事前通知の設定（key / value）
 *   notify.suppressed / .resumed … 配信を止める / 再開する
 *   profile.override          … 本人訂正（field / value）
 *
 * ─ 顧客プロファイル 第1段で足した 3 つ（2026-09-01 / 設計 rev.3.2 §6 第1段 ①⑤ / §7 #4）─
 *
 *   rating.submitted           … 届いた後の評価（①）。**5 段階**（択一 #4 の確定は (c)）。
 *                                旧来のお茶カード ±1 タップも同じ型で受ける（下記）
 *   taste.declared             … 本人が味の軸について言ったこと（会話 / じぶんのページ）
 *   purchase.recipient_declared … 「誰のために買ったか」（⑤ 自分用 / 贈りもの）
 *
 * ⚠ 第1段は「材料を取り始める」段である（設計 §6）。この 3 つは **事実を積むだけ**で、
 *   軸の位置の推論（減衰・窓・重み）は第3段 ⑯ に置く。L1 側も evidence を出所付きで
 *   持つところまでにしてある（migration 048）。
 */
export const PROFILE_EVENT_TYPES = [
  "persona.baseline_imported",
  "persona.signal_applied",
  "exclusion.set",
  "exclusion.cleared",
  "safety.declared",
  "notify.preference_set",
  "notify.suppressed",
  "notify.resumed",
  "profile.override",
  "rating.submitted",
  "taste.declared",
  "purchase.recipient_declared",
] as const;

/**
 * 「誰のために買ったか」の語彙（設計 §3「自分用と贈答は別モデル」）。
 *
 * ⚠ 2 値に閉じている。自分用と贈答は **構造が違う**（Boncinelli et al. 2019: 同じ人でも
 *   属性の重みが有意に変わる）ので、後から 3 つ目を足す種類の語彙ではない。
 */
export const PURCHASE_SCENES = ["self", "gift"] as const;
export type PurchaseScene = (typeof PURCHASE_SCENES)[number];

/** 「合わなかった」ときに任意で聞く 1 問の選択肢（設計 §2「どこが」4 択）。 */
export const RATING_ASPECTS = ["aroma", "strength", "aftertaste", "amount"] as const;
export type RatingAspect = (typeof RATING_ASPECTS)[number];

export type ProfileEventType = (typeof PROFILE_EVENT_TYPES)[number];

const PROFILE_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(PROFILE_EVENT_TYPES);

/** L1 を動かす出来事か（＝ payload の形が意味を持つ出来事か）。 */
export function isProfileEventType(value: string): value is ProfileEventType {
  return PROFILE_EVENT_TYPE_SET.has(value);
}

/** 既知の event_type 全集合。ここに無い値も **保存される**（schema_ok = false）。 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...BEHAVIOR_ACTIONS.map(behaviorEventType),
  ...FLOW_EVENT_NAMES.map(flowEventType),
  ...STANDALONE_EVENT_TYPES,
  ...PROFILE_EVENT_TYPES,
]);

/** DB 側の CHECK（customer_events_type_form）と同じ形。 */
const EVENT_TYPE_FORM = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** 形として L0 に載せられるか（語彙の既知/未知とは別の話）。 */
export function isWellFormedEventType(value: string): boolean {
  return value.length > 0 && value.length <= 64 && EVENT_TYPE_FORM.test(value);
}

/** 既知の語彙か（未知でも捨てない。schema_ok にそのまま入る）。 */
export function isKnownEventType(value: string): boolean {
  return KNOWN_EVENT_TYPES.has(value);
}

// ---------------------------------------------------------------------------
// channel
// ---------------------------------------------------------------------------

/**
 * 既知の channel（D4 の 4 者を 1 つに合流させた集合）。
 *
 * "shopify" は TS の型（`BehaviorChannel = "line" | "web"`）には無いが、
 * 注文 webhook が実際に書いている値である。**実在するものを語彙から外すと、
 * 実在するほうが「未知」になるだけで何も直らない**ので、ここでは受け入れる。
 * 型のほうを合わせるのは Stage 5（旧語彙の撤去）。
 */
export const KNOWN_CHANNELS = ["line", "web", "shopify"] as const;
export type KnownChannel = (typeof KNOWN_CHANNELS)[number];

const CHANNEL_FORM = /^[a-z][a-z0-9_]*$/;

export function isWellFormedChannel(value: string): boolean {
  return value.length > 0 && value.length <= 32 && CHANNEL_FORM.test(value);
}

export function isKnownChannel(value: string): boolean {
  return (KNOWN_CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 識別子の種類（040 の CHECK 制約と 1 対 1）
// ---------------------------------------------------------------------------

/**
 * identity_edges.identifier_kind の語彙。
 *
 * ⚠ ここは **閉じている**。出来事（何が起きたか）は観測の揺らぎがあるので開くが、
 *   識別子の種類が増えるのは設計判断であって揺らぎではない。
 */
export const IDENTIFIER_KINDS = [
  "line_messaging_uid",
  "line_login_uid",
  "shopify_customer_id",
  "web_anonymous_id",
  "web_session_id",
  /**
   * SEC-1: **観測の記録としてのみ**置く。同一 email を根拠に主体を結ぶ経路は
   * どこにも無い（042 の解決関数にも枝が無い / resolveSubject も拒否する）。
   * 生アドレスは決して入れない。渡す側が hash 済みの値だけを渡す。
   */
  "email_hash",
] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * 主体の解決に使ってよい種類。
 *
 * email_hash が入っていないことが SEC-1 の実体である。
 * ここに足すことは「メールが同じなら同じ人とみなす」という意味になる。
 */
export const RESOLVABLE_IDENTIFIER_KINDS: ReadonlySet<IdentifierKind> = new Set<IdentifierKind>([
  "line_messaging_uid",
  "line_login_uid",
  "shopify_customer_id",
  "web_anonymous_id",
  "web_session_id",
]);

export function isIdentifierKind(value: unknown): value is IdentifierKind {
  return typeof value === "string" && (IDENTIFIER_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// payload の形（L1 を動かす出来事だけ）
// ---------------------------------------------------------------------------

/**
 * L1 を動かす出来事の payload が読める形か（Stage 4）。
 *
 * ─ なぜ形を見るのか ─
 *
 *   L1 はこの payload を畳んで解釈を作る。形が壊れた行を畳むと、**壊れた入力が
 *   静かに解釈へ混ざる**（「もういらない」の銘柄番号が空文字で入る、点の増減が
 *   数値でない、など）。046 の畳み手は schema_ok = true の行だけを畳むので、
 *   ここで false を立てておけば L1 には入らない。
 *
 * ─ 捨てるのではない（E1）─
 *
 *   形が読めなくても **保存はする**。schema_ok = false が立ち、部分 index
 *   customer_events_unknown_type で数えられる。「読めない形で届いた」を
 *   「無かったこと」に変えないための非対称は、語彙のときと同じ。
 *
 * ─ L1 を動かさない出来事は常に true ─
 *   行動ログ・フロー・購入の payload は解釈に使わないので、形を問わない
 *   （問うと、既存 5 経路の payload を全部ここに写す羽目になる = 二重管理）。
 *
 * ─ 例外: shipment.sent ─
 *   送付は L1 の解釈（persona）を動かさないが、**月別の送付履歴という読み口が
 *   この payload をそのまま畳む**（src/lib/cdp/shipment.ts）。畳まれる payload は
 *   形を問う、という基準は persona と同じなのでここで一緒に見る。
 *   PROFILE_EVENT_TYPES に足さないのは、あの一覧が cdp_l1_build_profile の CASE と
 *   1 対 1 であるという約束を崩さないため（送付を畳む枝は 046 に無い）。
 */
export function isWellFormedPayload(
  eventType: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (eventType === SHIPMENT_SENT_EVENT_TYPE) {
    return isWellFormedShipmentPayload(payload);
  }
  if (!isProfileEventType(eventType)) return true;
  const p = payload ?? {};

  switch (eventType) {
    case "persona.baseline_imported":
      return isPersonaScoreBucket(p.scores);
    case "persona.signal_applied":
      return nonEmptyString(p.source) && isPersonaScoreBucket(p.delta);
    case "exclusion.set":
    case "exclusion.cleared":
      return nonEmptyString(p.ref);
    case "safety.declared":
      return (
        Array.isArray(p.tags) &&
        p.tags.length > 0 &&
        p.tags.every((t) => nonEmptyString(t))
      );
    case "notify.preference_set":
      return nonEmptyString(p.key) && "value" in p;
    case "notify.suppressed":
      return nonEmptyString(p.reason);
    case "notify.resumed":
      return true;
    case "profile.override":
      return nonEmptyString(p.field) && "value" in p;

    /**
     * 届いた後の評価（①）。**2 つの形を受ける**。
     *
     *   第1段の形 … `score` が 1〜5 の整数（択一 #4 = (c) 5 段階）
     *   旧来の形   … `rating` が +1 / -1（お茶カードの「感想ひとこと」1 タップ）
     *
     * 旧来の形を弾かないのは、既に本番の口（`recordProductRating`）がこの形で
     * 積んでいるからである。ここで弾くと **動いている経路の出来事が
     * schema_ok=false になり、L1 に入らなくなる**（E1 は保存するが解釈はしない）。
     * 2 つの形の区別は L1 側が出所タグで持つ（migration 048 / 設計 §6 第1段 ③）。
     *
     * ⚠ `score` を「星の数」として画面に出さないこと。択一 #4 の確定条件は
     *   **スコアは内部利用のみ・お客さんには星も数値も見せない**（R2 / バッジ非表示）。
     */
    case "rating.submitted":
      return isRatingPayload(p);

    /** 本人が味の軸について言ったこと。軸と極が語彙どおりであること。 */
    case "taste.declared":
      return (
        typeof p.axis === "string" &&
        isTasteAxis(p.axis) &&
        isTastePole(p.axis, p.pole)
      );

    /** 誰のために買ったか（⑤）。 */
    case "purchase.recipient_declared":
      return (
        typeof p.scene === "string" &&
        (PURCHASE_SCENES as readonly string[]).includes(p.scene)
      );

    default:
      return true;
  }
}

/** 届いた日の形（台帳 038 の delivered_on と同じ）。 */
const SHIPPED_ON_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `shipment.sent` の payload が読める形か。
 *
 * 求めるのは 2 つだけ: **いつ届いたか**（shipped_on）と **何が届いたか**（items）。
 * 号（issue_ref）は EC の注文には無いので必須にしない — 必須にすると、
 * 号が始まる前の送付が全部 schema_ok = false になり、履歴が空になる。
 */
export function isWellFormedShipmentPayload(
  payload: Record<string, unknown> | undefined,
): boolean {
  const p = payload ?? {};
  const shippedOn = p.shipped_on;
  if (typeof shippedOn !== "string" || !SHIPPED_ON_RE.test(shippedOn)) return false;
  const items = p.items;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const item = raw as Record<string, unknown>;
    if (typeof item.ref !== "string" || item.ref.trim() === "") return false;
    const q = item.quantity;
    return typeof q === "number" && Number.isInteger(q) && q > 0;
  });
}

/** Tea Menu の 5 桁番号。`product-ratings.ts` の PRODUCT_NO_RE と同じ形。 */
const PRODUCT_NO_FORM = /^\d{5}$/;

/**
 * 届いた後の評価の payload が読める形か。
 *
 * 必須: `product_no` が 5 桁。
 * どちらか一方: `score`（1-5 の整数）または `rating`（+1 / -1）。
 * 任意: `aspect`（あるなら語彙どおり）/ `delivery_ref`・`issue_ref`（あるなら非空文字列）。
 *
 * 両方あっても弾かない（移行期に両方載る経路が出たときに、出来事を落とさない）。
 */
function isRatingPayload(p: Record<string, unknown>): boolean {
  if (typeof p.product_no !== "string" || !PRODUCT_NO_FORM.test(p.product_no)) return false;

  const hasScore =
    typeof p.score === "number" &&
    Number.isInteger(p.score) &&
    p.score >= 1 &&
    p.score <= 5;
  const hasRating = p.rating === 1 || p.rating === -1;
  if (!hasScore && !hasRating) return false;

  if (p.aspect !== undefined && !(RATING_ASPECTS as readonly string[]).includes(p.aspect as string)) {
    return false;
  }
  for (const key of ["delivery_ref", "issue_ref"] as const) {
    if (p[key] !== undefined && !nonEmptyString(p[key])) return false;
  }
  return true;
}

/** 3 軸の数値バケツか（欠けた軸は許す。数値でない値が入っているものは弾く）。 */
function isPersonaScoreBucket(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const axes = ["serenity", "explorer", "sensory"] as const;
  let seen = 0;
  for (const axis of axes) {
    const v = (value as Record<string, unknown>)[axis];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    seen += 1;
  }
  return seen > 0;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
