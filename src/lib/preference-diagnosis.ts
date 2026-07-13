/**
 * 好み診断（リッチメニュー②）— 3 問・全タップ・状態レス・LLM 不使用。
 *
 * 設計仕様（オーナー確定 2026-07-13・Spec: Notion 39c70c9d-064c-81bc-aa53-f95733ccee97）:
 *   - Q1(3択・動機/+3 アンカー) → Q2(4択・味/refiner) → Q3(3択・選び方/refiner) → 結果。
 *   - 会話状態を持たない。回答履歴を quick reply の message テキストに全角縦棒 `｜` で
 *     埋め込んで引き回す（tea-menu.ts と同じ state レス方式）。
 *   - AI/LLM 生成を一切挟まず、加点表と tiebreak で 3 ペルソナ
 *     (serenity / explorer / sensory) の 1 つに確定する（創作ゼロ・費用ゼロ）。
 *   - tiebreak は既存 `mergePersonaScores` の先勝ち順（serenity → explorer → sensory）と
 *     一致させ、表示タイプと記録 primary の乖離を構造的に防ぐ。
 *
 * 表示=記録の一致に関する注記（Spec 実装前レビュー指摘1 反映）:
 *   新規ユーザー（scores=0 起点）は winner への weight 加算だけで必ず primary になるため
 *   「表示タイプ = 記録 primary」が保証される。既存ユーザーは累積履歴（購入等）を尊重するため、
 *   weight=3 でも既存スコアが上回れば primary は履歴側のまま＝画面表示と乖離しうる（仕様として許容）。
 *
 * 記録:
 *   結果確定時、winner を既存 `mergePersonaScores` に weight=3（購入と同格・Boss 確定値）で
 *   加算し Firestore の persona に反映する。未連携（LINE userId ↔ Shopify 顧客 ID 未解決）や
 *   Firebase 未設定・取得失敗時は skip（フロー自体は完結・エラーで止めない fail-safe）。
 *
 * 送信は LineResponder 経由（reply 優先・無料化）。
 */

import type { Env } from "../index";
import { type QuickReplyItem, type LineResponder } from "./line";
import { createSupabaseClient } from "./supabase";
import { resolveCallerShopifyCustomerId } from "./shopify";
import {
  getFirestoreEnv,
  getCustomerProfile,
  updateCustomerProfile,
  mergePersonaScores,
  type PersonaType,
  type PersonaScores,
} from "./firestore";

// ---------------------------------------------------------------------------
// 定数（トークン方式・tea-menu.ts と同一の SEP）
// ---------------------------------------------------------------------------

/** message テキストのトークン区切り（ユーザー入力にまず現れない全角縦棒）。 */
const SEP = "｜";

/** 診断トークンのプレフィックス（quick reply の message テキストに埋め込む）。 */
const DIAG_PREFIX = "診断";

/**
 * 起動トリガー（リッチメニュー②のメッセージ文字列と完全一致）。
 * `scripts/setup-rich-menu.ts` の②好み診断で確定済みの文言。
 */
export const DIAGNOSIS_TRIGGER = "好みに合うお茶を診断してほしいです";

/** 「もっと相談する」導線が送る発話（既存③相談の入口テキスト・menu-actions 経由で AI 会話へ）。 */
const CONSULT_MORE_TEXT = "お茶選びを相談したいです";

/** 記録 weight（Boss 確定値=3。会話 1 / 購入 3 に対し「購入と同格」）。 */
export const DIAGNOSIS_WEIGHT = 3;

/** 各問の選択肢数（範囲外・欠損を安全側で弾くための検証に使う）。 */
const Q_CHOICES = { q1: 3, q2: 4, q3: 3 } as const;

// ---------------------------------------------------------------------------
// アクション解析（純粋・状態レス）
// ---------------------------------------------------------------------------

type Action =
  | { kind: "start" } // トリガー発話 → イントロ + Q1
  | { kind: "q2"; q1: number } // Q1 回答済み → Q2
  | { kind: "q3"; q1: number; q2: number } // Q2 回答済み → Q3
  | { kind: "result"; q1: number; q2: number; q3: number } // Q3 回答済み → 採点
  | { kind: "invalid" }; // 診断トークンだが範囲外/欠損 → 安全側で再提示

function parseChoice(raw: string | undefined, max: number): number | null {
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/**
 * ユーザー発話を診断アクションに解釈する。
 * 診断と無関係なら null（＝インターセプトせず既存フローへ素通り）。
 * 診断トークンだが不正（範囲外・欠損）なら "invalid"（＝横取りして再提示する）。
 */
export function parsePreferenceAction(raw: string): Action | null {
  const t = raw.trim();
  if (!t) return null;

  // 起動トリガー（完全一致）→ イントロ + Q1
  if (t === DIAGNOSIS_TRIGGER) return { kind: "start" };

  // 診断トークン（タップ由来）: `診断｜{q1}[｜{q2}[｜{q3}]]`
  if (t.startsWith(DIAG_PREFIX + SEP)) {
    const parts = t.split(SEP);
    // parts[0] === "診断"、以降が回答セグメント
    const segs = parts.slice(1);
    const q1 = parseChoice(segs[0], Q_CHOICES.q1);
    if (segs.length === 1) {
      return q1 !== null ? { kind: "q2", q1 } : { kind: "invalid" };
    }
    if (segs.length === 2) {
      const q2 = parseChoice(segs[1], Q_CHOICES.q2);
      return q1 !== null && q2 !== null ? { kind: "q3", q1, q2 } : { kind: "invalid" };
    }
    if (segs.length === 3) {
      const q2 = parseChoice(segs[1], Q_CHOICES.q2);
      const q3 = parseChoice(segs[2], Q_CHOICES.q3);
      return q1 !== null && q2 !== null && q3 !== null
        ? { kind: "result", q1, q2, q3 }
        : { kind: "invalid" };
    }
    // セグメント過多・欠損 → 安全側で再提示
    return { kind: "invalid" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 採点（確定ロジック・AI 不使用）
// ---------------------------------------------------------------------------

/** 加点表（Spec §5-1）。S=serenity, E=explorer, G=sensory。 */
const SCORE_TABLE: Record<"q1" | "q2" | "q3", Record<number, Partial<PersonaScores>>> = {
  q1: {
    1: { serenity: 3 }, // やすらぎ
    2: { explorer: 3 }, // 新しい出会い
    3: { sensory: 3 }, // 確かな味わい
  },
  q2: {
    1: { serenity: 2 }, // まろやかな甘み
    2: { explorer: 1, sensory: 1 }, // 香り高く個性
    3: { sensory: 2 }, // コク・余韻
    4: { serenity: 1, explorer: 1 }, // すっきり軽やか
  },
  q3: {
    1: { serenity: 2 }, // 寄り添う一杯
    2: { explorer: 2 }, // 試したい一杯
    3: { sensory: 2 }, // 合わせたい一杯
  },
};

/**
 * 3 問の回答からペルソナを確定する（純粋）。
 * 合計最大軸で確定。同点は固定優先順 serenity → explorer → sensory の先勝ち
 * （既存 `mergePersonaScores` の primary 再計算と同一の tiebreak）。
 */
export function scoreDiagnosis(q1: number, q2: number, q3: number): PersonaType {
  // キー挿入順が先勝ちの優先順（serenity → explorer → sensory）を決める。
  const scores: PersonaScores = { serenity: 0, explorer: 0, sensory: 0 };
  const apply = (delta: Partial<PersonaScores>) => {
    for (const [k, v] of Object.entries(delta) as Array<[PersonaType, number]>) {
      scores[k] += v;
    }
  };
  apply(SCORE_TABLE.q1[q1] ?? {});
  apply(SCORE_TABLE.q2[q2] ?? {});
  apply(SCORE_TABLE.q3[q3] ?? {});

  // 先勝ち（strict >）で最大軸を選ぶ = mergePersonaScores と同一挙動。
  return (Object.entries(scores) as Array<[PersonaType, number]>).reduce((a, b) =>
    b[1] > a[1] ? b : a,
  )[0];
}

// ---------------------------------------------------------------------------
// 純粋ビルダー（メッセージ + quick reply）
// ---------------------------------------------------------------------------

/** 送信 1 通分（テキスト + quick reply）。 */
export interface OutMessage {
  text: string;
  quickReplies: QuickReplyItem[];
}

function qr(label: string, text: string): QuickReplyItem {
  return { type: "action", action: { type: "message", label, text } };
}

/** ②タップ直後: イントロ + Q1（動機・3択）。 */
export function buildIntroAndQ1(): OutMessage {
  const text =
    "あなたにそっと寄り添う一杯を、お選びします。\n" +
    "3つの問いに、直感でお答えくださいね。\n\n" +
    "お茶の時間に、いちばん求めているものは？";
  return {
    text,
    quickReplies: [
      qr("ほっと落ち着く、やすらぎ", `${DIAG_PREFIX}${SEP}1`),
      qr("知らない味や香りとの出会い", `${DIAG_PREFIX}${SEP}2`),
      qr("「おいしい」と感じる味わい", `${DIAG_PREFIX}${SEP}3`),
    ],
  };
}

/** Q2（味の好み・4択）。 */
export function buildQ2(q1: number): OutMessage {
  const base = `${DIAG_PREFIX}${SEP}${q1}${SEP}`;
  return {
    text: "どんな味わいだと、うれしいですか？",
    quickReplies: [
      qr("やさしく、まろやかな甘み", `${base}1`),
      qr("香り高く、個性を感じる", `${base}2`),
      qr("コクや余韻がしっかり", `${base}3`),
      qr("すっきり軽やか、飲みやすい", `${base}4`),
    ],
  };
}

/** Q3（選び方・3択）。 */
export function buildQ3(q1: number, q2: number): OutMessage {
  const base = `${DIAG_PREFIX}${SEP}${q1}${SEP}${q2}${SEP}`;
  return {
    text: "お茶を選ぶとき、いちばん心が動くのは？",
    quickReplies: [
      qr("ずっと寄り添う、落ち着く一杯", `${base}1`),
      qr("試したくなる、気になる一杯", `${base}2`),
      qr("料理やお菓子に合わせたい一杯", `${base}3`),
    ],
  };
}

/** タイプ別おすすめ（採用 3 種・番号は Tea Menu DB Status=販売中 の title を SoT とする）。 */
const RESULTS: Record<PersonaType, OutMessage> = {
  serenity: {
    text:
      "あなたは【静けさを愉しむ人】。\n" +
      "一日のあわいに、そっと心をほどく時間を大切にされる方ですね。\n" +
      "まろやかな甘みと穏やかな香りのお茶が、よく似合います。\n\n" +
      "おすすめは、この3つ。\n" +
      "40101 春摘み香駿の和烏龍茶／ミルキーな香りと柔らかな甘み\n" +
      "40601 さやまかおりの和烏龍茶／重なる香りと上品な甘みの余韻\n" +
      "10501 みなみさやかの萎凋釜炒り茶／花と蜜のような、静かな一杯\n\n" +
      "気になるお茶は、下のボタンか、番号（例 40101）を送ってくださいね。",
    quickReplies: [
      qr("40101 香駿の和烏龍茶", "このお茶｜40101"),
      qr("40601 さやまかおりの烏龍", "このお茶｜40601"),
      qr("10501 みなみさやか", "このお茶｜10501"),
      qr("もっと相談する", CONSULT_MORE_TEXT),
    ],
  },
  explorer: {
    text:
      "あなたは【お茶の世界を旅する人】。\n" +
      "一杯ごとの違いや、つくり手の物語に心が動く方ですね。\n" +
      "珍しい品種や、ひと手間かけた製法のお茶を、ぜひ。\n\n" +
      "おすすめは、この3つ。\n" +
      "10201 静七一三二の萎凋煎茶／珍しい品種を萎凋させた、桜のような香り\n" +
      "40201 香駿の和烏龍茶／黄桃のような香り、何煎も変わる表情\n" +
      "11501 うんかいの萎凋釜炒り茶／白い小花の香りと釜炒りの滋味\n\n" +
      "気になるお茶は、下のボタンか、番号（例 10201）を送ってくださいね。",
    quickReplies: [
      qr("10201 静七一三二の萎凋煎茶", "このお茶｜10201"),
      qr("40201 香駿の和烏龍茶", "このお茶｜40201"),
      qr("11501 うんかいの釜炒り茶", "このお茶｜11501"),
      qr("もっと相談する", CONSULT_MORE_TEXT),
    ],
  },
  sensory: {
    text:
      "あなたは【味わいを深く愉しむ人】。\n" +
      "甘み、渋み、コク、余韻——その輪郭をじっくり味わう方ですね。\n" +
      "味の芯がはっきりしたお茶と、食べ合わせがよく合います。\n\n" +
      "おすすめは、この3つ。\n" +
      "50401 春摘みべにふうきの和紅茶／フルーティな甘みと渋みが一体に\n" +
      "10801 みらいの上煎茶／クリアな味わいに、美しい渋みとコク\n" +
      "11601 さえみどりの上煎茶／上品な旨みと奥ゆかしい渋み、食後にも\n\n" +
      "気になるお茶は、下のボタンか、番号（例 50401）を送ってくださいね。",
    quickReplies: [
      qr("50401 春摘みべにふうき紅茶", "このお茶｜50401"),
      qr("10801 みらいの上煎茶", "このお茶｜10801"),
      qr("11601 さえみどりの上煎茶", "このお茶｜11601"),
      qr("もっと相談する", CONSULT_MORE_TEXT),
    ],
  },
};

/** 結果メッセージ（winner タイプの文面 + おすすめ 4 ボタン）。 */
export function buildResult(winner: PersonaType): OutMessage {
  return RESULTS[winner];
}

// ---------------------------------------------------------------------------
// プラン（純粋・状態レス）: アクション → 送信メッセージ（+ 記録すべき winner）
// ---------------------------------------------------------------------------

export function planPreferenceFlow(
  userMessage: string,
): { message: OutMessage; winner: PersonaType | null } | null {
  const action = parsePreferenceAction(userMessage);
  if (!action) return null;

  switch (action.kind) {
    case "start":
      return { message: buildIntroAndQ1(), winner: null };
    case "q2":
      return { message: buildQ2(action.q1), winner: null };
    case "q3":
      return { message: buildQ3(action.q1, action.q2), winner: null };
    case "result": {
      const winner = scoreDiagnosis(action.q1, action.q2, action.q3);
      return { message: buildResult(winner), winner };
    }
    case "invalid":
      // 範囲外・欠損は安全側で最初からやり直し（イントロ + Q1 を再提示）。
      return { message: buildIntroAndQ1(), winner: null };
  }
}

// ---------------------------------------------------------------------------
// 記録（既存ペルソナ機構への反映・fail-safe）
// ---------------------------------------------------------------------------

/**
 * 診断結果を既存 persona.scores に weight=3 で加算して Firestore に記録する。
 *
 * fail-safe: 未連携（Shopify 顧客 ID 未解決）・Firebase 未設定・取得/更新失敗は
 * すべて silent skip（例外を投げない＝診断フローを止めない）。
 */
export async function recordDiagnosisPersona(
  lineUserId: string,
  winner: PersonaType,
  env: Env,
): Promise<void> {
  try {
    // Firebase 未設定ならスキップ
    let fsEnv;
    try {
      fsEnv = getFirestoreEnv(env);
    } catch {
      return;
    }

    const supabase = createSupabaseClient(env);
    const shopifyId = await resolveCallerShopifyCustomerId(lineUserId, "line", supabase);
    if (!shopifyId) {
      // 未連携ユーザー — プロファイル更新不可（フローは完結済み）
      console.log("[preference-diagnosis] No linkage found, skipping persona record");
      return;
    }

    const existing = await getCustomerProfile(shopifyId, fsEnv);
    const existingScores: PersonaScores =
      existing?.persona?.scores ?? { serenity: 0, explorer: 0, sensory: 0 };

    // 上書きせず別軸に累積加算（属性整合の要）。winner に +DIAGNOSIS_WEIGHT。
    const { scores, primary } = mergePersonaScores(existingScores, [winner], DIAGNOSIS_WEIGHT);

    const now = new Date().toISOString();
    await updateCustomerProfile(
      shopifyId,
      {
        persona: { primary, scores, lastUpdated: now },
        lastActiveAt: now,
      },
      fsEnv,
    );

    console.log(
      `[preference-diagnosis] persona recorded for ${shopifyId}: ` +
        `winner=${winner} weight=${DIAGNOSIS_WEIGHT} primary=${primary}`,
    );
  } catch (err) {
    // fail-safe: フローを止めない
    console.warn(
      "[preference-diagnosis] persona record failed (non-blocking):",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// オーケストレーション（インターセプタ本体）
// ---------------------------------------------------------------------------

/**
 * 好み診断（リッチメニュー②）の決定的応答インターセプタ。
 *
 * @returns 処理したら true（＝ここで応答完結）。診断と無関係なら false
 *          （＝呼び出し側は既存の AI 会話フローへ素通りさせる）。
 *
 * 挙動:
 *   - トリガー発話 `好みに合うお茶を診断してほしいです` と `診断｜*` トークンのみ横取り。
 *   - Q1→Q2→Q3 の各段は quick reply を返すだけ（state レス）。
 *   - 結果段は winner を採点 → 結果メッセージを返し → persona を記録（fail-safe・非ブロッキング）。
 */
export async function handlePreferenceDiagnosis(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
): Promise<boolean> {
  const plan = planPreferenceFlow(userMessage);
  if (!plan) return false;

  // 先に応答を返す（記録の成否に関わらずユーザー体験を完結させる）。
  await responder.text(plan.message.text, plan.message.quickReplies);

  // 結果確定時のみ persona を記録（fail-safe: 例外を投げない）。
  if (plan.winner) {
    await recordDiagnosisPersona(lineUserId, plan.winner, env);
  }

  return true;
}
