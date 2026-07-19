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
 *   加算し Firestore の persona に反映する。
 *   - 連携済み（Shopify 顧客 ID 解決可）: users/{shopifyId} に加算（従来どおり）。
 *   - 未連携（LINE userId ↔ Shopify 未解決）: lineUsers/{lineUserId} に加算（UX レビュー指摘 #2）。
 *     → 結果文面の「記録した」という約束と実データの乖離を解消。将来 Shopify 連携が成立したら
 *       この LINE カルテを users へマージできる構造（自動マージは今回スコープ外・TODO）。
 *   - Firebase 未設定・取得/更新失敗時は skip（フロー自体は完結・エラーで止めない fail-safe）。
 *
 * 送信は LineResponder 経由（reply 優先・無料化）。
 */

import type { Env } from "../index";
import { type QuickReplyItem, type LineResponder } from "./line";
import { createSupabaseClient } from "./supabase";
import { logFlowEvent, type FlowEventInput } from "./flow-events";
import { diagnosisCardToken, fetchSellingTeas, type TeaItem } from "./tea-menu";
import { karteAffinity, type NextCupKarte } from "./next-cup";
import { resolveCallerShopifyCustomerId } from "./shopify";
import {
  getFirestoreEnv,
  getCustomerProfile,
  updateCustomerProfile,
  getLineUserProfile,
  updateLineUserProfile,
  mergePersonaScores,
  type PersonaType,
  type PersonaScores,
  type TasteProfile,
  type CustomerProfile,
  type LineUserProfile,
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


// ---------------------------------------------------------------------------
// 結果おすすめ（動的解決・監査 #6）: persona/味の好み × 販売中カタログ → おすすめ銘柄
// ---------------------------------------------------------------------------

/**
 * タイプ別の受け止め文（persona reveal・純粋）。おすすめ銘柄はここに書かず、販売中カタログから動的解決する。
 * 監査 #6 是正: 旧実装は 5 桁番号をハードコードしており、販売終了・番号変更で「見つかりません」化した。
 *   受け止め（あなたは〇〇な人）はブランド体験の核なので定数として保持し、銘柄だけを動的化する。
 */
const PERSONA_INTRO: Record<PersonaType, string> = {
  serenity:
    "あなたは【静けさを愉しむ人】。\n" +
    "一日のあわいに、そっと心をほどく時間を大切にされる方ですね。\n" +
    "まろやかな甘みと穏やかな香りのお茶が、よく似合います。",
  explorer:
    "あなたは【お茶の世界を旅する人】。\n" +
    "一杯ごとの違いや、つくり手の物語に心が動く方ですね。\n" +
    "珍しい品種や、ひと手間かけた製法のお茶を、ぜひ。",
  sensory:
    "あなたは【味わいを深く愉しむ人】。\n" +
    "甘み、渋み、コク、余韻——その輪郭をじっくり味わう方ですね。\n" +
    "味の芯がはっきりしたお茶と、食べ合わせがよく合います。",
};

/** おすすめ提示件数（販売中カタログから上位 N 件）。 */
const DIAGNOSIS_RECOMMEND_COUNT = 3;

/** LINE quick reply ラベル上限（20 文字・tea-menu.QR_LABEL_MAX と同値）。 */
const QR_LABEL_MAX = 20;

/** ラベルを 20 文字に収める（超過は末尾を … に置換）。 */
function truncateLabel(s: string): string {
  return s.length > QR_LABEL_MAX ? s.slice(0, QR_LABEL_MAX - 1) + "…" : s;
}

/**
 * 診断の味の問い（Q2）を「次の一杯」と同じ flavor 語彙へ写す（純粋）。軸解決は next-cup.karteAffinity に委譲。
 * これで診断結果（persona + 味の好み）が販売中カタログの銘柄選定に反映される（reuse・一貫性）。
 *   Q2-1 まろやかな甘み → rich 香り / Q2-3 コク・余韻 → full ボディ / Q2-4 すっきり軽やか → light ボディ。
 *   Q2-2「香り高く個性」は 2 軸へ一意に写せないため null（persona 傾きのみで並べる）。
 */
export function tasteFromDiagnosisQ2(q2: number): TasteProfile | null {
  switch (q2) {
    case 1:
      return { preferredCategories: [], flavorPreferences: ["sweet", "mellow"], scenePref: null };
    case 3:
      return { preferredCategories: [], flavorPreferences: ["rich"], scenePref: null };
    case 4:
      return { preferredCategories: [], flavorPreferences: ["refreshing"], scenePref: null };
    default:
      return null;
  }
}

/**
 * 診断結果（winner persona [+ 味の好み Q2]）を「次の一杯」と同じカルテ表現へ束ねる（純粋）。
 * karteAffinity がこの persona / tasteProfile を軸親和度へ写して銘柄を並べ替える（会話/次の一杯と同一源）。
 */
export function diagnosisRecommendationKarte(winner: PersonaType, q2?: number): NextCupKarte {
  return { persona: winner, tasteProfile: q2 !== undefined ? tasteFromDiagnosisQ2(q2) : null };
}

/**
 * 販売中カタログからカルテ親和度の高い順（同点は番号昇順・決定的）に上位 n 件を選ぶ（純粋・reuse next-cup）。
 * カタログが空・不足なら在るだけ返す（graceful・ハードコード番号に依存しない）。
 */
export function pickDiagnosisRecommendations(
  teas: TeaItem[],
  karte: NextCupKarte,
  n: number = DIAGNOSIS_RECOMMEND_COUNT,
): TeaItem[] {
  return [...teas]
    .sort((a, b) => {
      const d = karteAffinity(b, karte) - karteAffinity(a, karte);
      return d !== 0 ? d : a.number.localeCompare(b.number);
    })
    .slice(0, Math.max(0, n));
}

/**
 * おすすめ銘柄が 1 件も無いとき（カタログ取得失敗・在庫ゼロ）の graceful フォールバック（純粋）。
 * persona の受け止めは必ず届け、行き止まりの 5 桁ボタンは出さず会話導線だけ添える（#6・静か）。
 */
export function buildResultFallback(winner: PersonaType): OutMessage {
  return {
    text: `${PERSONA_INTRO[winner]}\n\n今おすすめできるお茶を、会話でもお選びしますね。`,
    quickReplies: [qr("お茶選びを相談する", CONSULT_MORE_TEXT)],
  };
}

/**
 * 結果メッセージ（winner の受け止め + 販売中カタログから動的に選んだおすすめ）（純粋）。
 *
 * 監査 #6 是正: おすすめ銘柄はハードコード 5 桁ではなく、fetchSellingTeas の販売中カタログから
 *   カルテ親和度（next-cup.karteAffinity・会話/次の一杯と同じ persona/taste 重み）で動的抽出する。
 *   販売終了・番号変更で欠番になっても「見つかりません」化せず、在るお茶から必ず提案が組める。
 *   1 件も無ければ buildResultFallback（persona の受け止め + 相談導線）へ倒す（graceful）。
 * おすすめボタンは diagnosisCardToken（`このお茶｜{番号}｜診断`）で「診断出所」を継承する（従来どおり）:
 *   到達カードは tea.card_view value=diagnosis を記録し、感想タップは product_ratings source=diagnosis。
 */
export function buildResultWithTeas(
  winner: PersonaType,
  teas: TeaItem[],
  karte?: NextCupKarte | null,
): OutMessage {
  const picks = pickDiagnosisRecommendations(teas, karte ?? diagnosisRecommendationKarte(winner));
  if (picks.length === 0) return buildResultFallback(winner);

  const lines = picks.map((t) => {
    const desc = t.descShort.trim() ? `／${t.descShort.trim()}` : "";
    return `${t.number} ${t.name}${desc}`;
  });
  const text =
    `${PERSONA_INTRO[winner]}\n\n` +
    `おすすめは、この${picks.length}つ。\n` +
    `${lines.join("\n")}\n\n` +
    `気になるお茶は、下のボタンか、番号（例 ${picks[0].number}）を送ってくださいね。`;

  const quickReplies: QuickReplyItem[] = picks.map((t) =>
    qr(truncateLabel(`${t.number} ${t.name}`), diagnosisCardToken(t.number)),
  );
  quickReplies.push(qr("もっと相談する", CONSULT_MORE_TEXT));
  return { text, quickReplies };
}

// ---------------------------------------------------------------------------
// プラン（純粋・状態レス）: アクション → 送信メッセージ（+ 記録すべき winner）
// ---------------------------------------------------------------------------

export function planPreferenceFlow(
  userMessage: string,
  teas: TeaItem[] = [],
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
      // 監査 #6: おすすめは販売中カタログ（teas）から persona + 味の好み(Q2) で動的解決する。
      //   teas 未指定・空（呼び出し側の取得失敗含む）は buildResultWithTeas 内で graceful フォールバック。
      const karte = diagnosisRecommendationKarte(winner, action.q2);
      return { message: buildResultWithTeas(winner, teas, karte), winner };
    }
    case "invalid":
      // 範囲外・欠損は安全側で最初からやり直し（イントロ + Q1 を再提示）。
      return { message: buildIntroAndQ1(), winner: null };
  }
}

// ---------------------------------------------------------------------------
// 記録（既存ペルソナ機構への反映・fail-safe）
// ---------------------------------------------------------------------------

/** ゼロ起点スコア（新規カルテの初期値）。 */
function zeroScores(): PersonaScores {
  return { serenity: 0, explorer: 0, sensory: 0 };
}

/** どちらのカルテに記録したか（テスト・ログ用）。 */
export type DiagnosisRecordPath = "shopify" | "line";

/**
 * 記録の I/O シーム（テストは fake を注入しネットワーク非接触にする）。
 */
export interface RecordDiagnosisDeps {
  /** LINE userId → Shopify 顧客 ID（未連携は null）。 */
  resolveShopifyId: (lineUserId: string) => Promise<string | null>;
  /** 連携済みカルテ取得（users/{shopifyId}）。 */
  getShopifyProfile: (shopifyId: string) => Promise<CustomerProfile | null>;
  /** 連携済みカルテ更新。 */
  updateShopifyProfile: (
    shopifyId: string,
    updates: Partial<CustomerProfile>,
  ) => Promise<void>;
  /** 未連携カルテ取得（lineUsers/{lineUserId}）。 */
  getLineProfile: (lineUserId: string) => Promise<LineUserProfile | null>;
  /** 未連携カルテ更新（不在なら upsert 作成）。 */
  updateLineProfile: (
    lineUserId: string,
    updates: Partial<LineUserProfile>,
  ) => Promise<void>;
}

/**
 * 診断結果（winner）を既存 persona に weight=3 で「別軸に累積加算」して記録する（純粋な分岐 + 注入 I/O）。
 *
 * - 連携済み: users/{shopifyId} に加算（従来挙動を維持）。
 * - 未連携:   lineUsers/{lineUserId} に加算（指摘 #2）。新規なら createdAt を刻む。
 *
 * どちらも `mergePersonaScores` の流儀（上書きせず各軸独立に累積・primary は最大軸を再計算）を踏襲し、
 * 将来 Shopify 連携時に LINE カルテを users へマージできる同一構造にする。
 */
export async function recordDiagnosisPersonaWith(
  lineUserId: string,
  winner: PersonaType,
  deps: RecordDiagnosisDeps,
): Promise<DiagnosisRecordPath> {
  const now = new Date().toISOString();
  const shopifyId = await deps.resolveShopifyId(lineUserId);

  if (shopifyId) {
    const existing = await deps.getShopifyProfile(shopifyId);
    const existingScores = existing?.persona?.scores ?? zeroScores();
    const { scores, primary } = mergePersonaScores(existingScores, [winner], DIAGNOSIS_WEIGHT);
    await deps.updateShopifyProfile(shopifyId, {
      persona: { primary, scores, lastUpdated: now },
      lastActiveAt: now,
    });
    return "shopify";
  }

  // 未連携: LINE userId をキーにしたカルテへ（指摘 #2）。既存カルテと同種の persona のみ保持。
  const existingLine = await deps.getLineProfile(lineUserId);
  const existingScores = existingLine?.persona?.scores ?? zeroScores();
  const { scores, primary } = mergePersonaScores(existingScores, [winner], DIAGNOSIS_WEIGHT);
  const updates: Partial<LineUserProfile> = {
    lineUserId,
    persona: { primary, scores, lastUpdated: now },
    lastActiveAt: now,
  };
  if (!existingLine) {
    updates.createdAt = now;
    // TODO(将来マージ): 後日 Shopify 連携成立時に lineUsers/{lineUserId} を
    //   users/{shopifyId} へ mergePersonaScores 流儀で統合し mergedToShopify=true を立てる
    //   （or 削除）。自動マージ処理は今回スコープ外。
  }
  await deps.updateLineProfile(lineUserId, updates);
  return "line";
}

/**
 * 診断結果を Firestore に記録する（runtime 配線・fail-safe）。
 *
 * fail-safe: Firebase 未設定・取得/更新失敗はすべて silent skip（例外を投げない＝診断フローを止めない）。
 * 未連携でも lineUsers/{lineUserId} に記録するため、従来の「未連携は skip」は解消済み。
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
    const path = await recordDiagnosisPersonaWith(lineUserId, winner, {
      resolveShopifyId: (id) => resolveCallerShopifyCustomerId(id, "line", supabase),
      getShopifyProfile: (id) => getCustomerProfile(id, fsEnv!),
      updateShopifyProfile: (id, updates) => updateCustomerProfile(id, updates, fsEnv!),
      getLineProfile: (id) => getLineUserProfile(id, fsEnv!),
      updateLineProfile: (id, updates) => updateLineUserProfile(id, updates, fsEnv!),
    });

    console.log(
      `[preference-diagnosis] persona recorded (${path}): winner=${winner} weight=${DIAGNOSIS_WEIGHT}`,
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
// 診断ファネル記録（P0-2）: アクション → flow_events 入力（純粋・テスト可能）
// ---------------------------------------------------------------------------

/**
 * ユーザー発話（診断トークン）から記録すべき flow_events を導出する（純粋）。
 *
 * 設計 §B-5a のイベント名に対応。段の意味に注意（state レスのため「次に見せる画面」= 直前の回答）:
 *   - start  → diag.start（Q1 提示。entry は現状メニュー由来のため value="menu"）
 *   - q2     → 直前に Q1 を回答 → diag.answer(step=q1, value=q1_{n})
 *   - q3     → 直前に Q2 を回答 → diag.answer(step=q2, value=q2_{n})
 *   - result → 直前に Q3 を回答 → diag.answer(step=q3) + diag.result(value=winner)
 *   - invalid→ diag.invalid
 *
 * これで棚卸しの H1（診断ファネル start→q1→q2→q3→result）・H8（選択分布）が検証可能になる。
 */
export function diagnosisFlowEvents(
  userMessage: string,
  userRef: string,
  winner: PersonaType | null,
): FlowEventInput[] {
  const action = parsePreferenceAction(userMessage);
  if (!action) return [];
  switch (action.kind) {
    case "start":
      return [{ eventName: "diag.start", userRef, value: "menu" }];
    case "q2":
      return [{ eventName: "diag.answer", userRef, step: "q1", value: `q1_${action.q1}` }];
    case "q3":
      return [{ eventName: "diag.answer", userRef, step: "q2", value: `q2_${action.q2}` }];
    case "result": {
      const evs: FlowEventInput[] = [
        { eventName: "diag.answer", userRef, step: "q3", value: `q3_${action.q3}` },
      ];
      if (winner) evs.push({ eventName: "diag.result", userRef, value: winner });
      return evs;
    }
    case "invalid":
      return [{ eventName: "diag.invalid", userRef }];
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
/**
 * 診断完了時の副作用（LINE 返信 / ファネル記録 / persona 記録）の実行順を担う純粋オーケストレーション。
 *
 * 堅牢化（ブロック1 修正 2026-07-16・QA 指摘②）:
 *   旧実装は `await responder.text()` を先に呼び、返信が throw（replyToken 無効等）すると
 *   後続の persona 記録に到達せず、結果文面の「記録した」約束が破れていた。
 *   本関数は返信失敗を捕捉し、ファネル記録と persona 記録を返信の成否と独立に必ず完遂してから、
 *   返信の例外を元の形で再送出する（呼び出し側の失敗可視化・既存挙動を保つ）。UX の返信内容は不変。
 */
export async function runDiagnosisSideEffects(deps: {
  /** LINE 返信（reply 優先・無料化）。失敗しても記録は道連れにしない。 */
  reply: () => Promise<void>;
  /** 診断ファネル記録（fire-and-forget・失敗は内部で握りつぶす前提）。 */
  logFlowEvents?: () => void;
  /** persona 記録（winner があるときのみ・fail-safe）。返信失敗と独立に必ず実行する。 */
  record?: (() => Promise<void>) | null;
  /** 返信失敗時のログ等（副作用なし・任意）。 */
  onReplyError?: (err: unknown) => void;
}): Promise<void> {
  let replyError: unknown = null;
  try {
    await deps.reply();
  } catch (err) {
    replyError = err;
    deps.onReplyError?.(err);
  }

  // 返信の成否に関わらずファネル記録（本番昇格前に必須・初期ファネルを失わない）。
  deps.logFlowEvents?.();

  // 返信失敗と独立に persona 記録を完遂（堅牢化の中核）。record 自体は fail-safe。
  if (deps.record) {
    await deps.record();
  }

  // 返信失敗は記録完遂後に元の例外として再送出（呼び出し側の挙動・失敗可視化を保つ）。
  if (replyError) throw replyError;
}

export async function handlePreferenceDiagnosis(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
): Promise<boolean> {
  // 監査 #6: 結果段のみ、おすすめを販売中カタログから動的解決する（ハードコード 5 桁を撤去）。
  //   取得失敗（Notion 不達等）は空配列に倒し、buildResultWithTeas 内で graceful フォールバックへ（fail-safe）。
  //   Q1〜Q3 の段では banner/quick-reply だけなのでカタログ取得はしない（余計な I/O と失敗面を増やさない）。
  const preAction = parsePreferenceAction(userMessage);
  if (!preAction) return false;
  let teas: TeaItem[] = [];
  if (preAction.kind === "result") {
    try {
      teas = await fetchSellingTeas(env);
    } catch (err) {
      console.warn(
        "[preference-diagnosis] selling-teas fetch failed (fallback to consult):",
        err instanceof Error ? err.message : err,
      );
      teas = [];
    }
  }

  const plan = planPreferenceFlow(userMessage, teas);
  if (!plan) return false;

  const supabase = createSupabaseClient(env);

  await runDiagnosisSideEffects({
    // 返信は先に試みる（UX: reply 優先）。失敗しても記録を道連れにしない。
    reply: () => responder.text(plan.message.text, plan.message.quickReplies),
    // 診断ファネル記録（P0-2・fire-and-forget・失敗は握りつぶし）。
    logFlowEvents: () => {
      for (const ev of diagnosisFlowEvents(userMessage, lineUserId, plan.winner)) {
        void logFlowEvent(supabase, ev);
      }
    },
    // 結果確定時のみ persona を記録（fail-safe: 例外を投げない）。
    record: plan.winner
      ? () => recordDiagnosisPersona(lineUserId, plan.winner as PersonaType, env)
      : null,
    onReplyError: (err) =>
      console.warn(
        "[preference-diagnosis] reply failed (persona 記録は続行):",
        err instanceof Error ? err.message : err,
      ),
  });

  return true;
}
