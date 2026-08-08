/**
 * roji 最初のアンケート — 答えを器に入れる（カルテ / 出来事の置き場 / 言葉の置き場）。
 *
 * 一次入力: roji 最初のアンケート Spec 第7章「答えが器に収まるか — 突き合わせ」
 *   https://www.notion.so/3b570c9d064c81e6b0fcf19356e65406
 * 器の定義: rojiカルテの項目 — 最終形の定義
 *   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 *
 * ─ 使う器は、すでに在るものだけ ─
 *   カルテ         : Firestore users/{shopifyCustomerId} と lineUsers/{lineUserId}（RojiKarteFields）
 *   出来事の置き場 : Supabase flow_events（migration 021 / 035）
 *   言葉の置き場   : Supabase roji_words + roji_word_persons + roji_word_person_refs（migration 032）
 *   **新しいテーブル・新しいカルテ項目を 1 つも作らない。** 足りないものは作らずに報告する。
 *
 * ─ 突き合わせ（Spec 第7章の表）─
 *   問い1 → 項目11（飲む場面・時間帯 = tasteProfile.scenePref）＋ 項目31
 *   問い2 → 項目12（窓への傾き = windowAffinity）      ＋ 項目31
 *   問い3 → 項目7 （3つのタイプへの傾き = persona）    ＋ 項目31
 *   問い4 → 項目9 （好きなカテゴリ = preferredCategories）＋ 項目31
 *   問い5 → 項目6 （安全に関する申告 = safety.tags）   ＋ 項目31
 *   問い6 → 項目14（イベントへの関心 = eventInterest） ＋ 項目31
 *   1行   → 項目19（estimateLine）／ 項目29（表示した・訂正した = flow_events）
 *   訂正  → 項目20（estimateCorrection）＋ 項目7 の上書き
 *   ひとこと → 項目34〜41（roji_words・出所 = survey_free_text）
 *   引用の許可 → 項目18（quoteConsent。既定は「引用しない」）
 *
 * ─ 器の側の不足（作らずに報告した）─
 *   (a) 項目11 は「選択肢（複数可）」だが、器 `tasteProfile.scenePref` は **単一の文字列**。
 *       よって **1つ目のタップ（＝確定した答え）だけをカルテに入れ**、押し足した分は
 *       項目31（flow_events）にすべて残す。カルテ側で複数を持つには器の変更が要る。
 *   (b) 項目9 の「決まっていない」は、器 `preferredCategories`（お茶の族の照合に使う配列）に
 *       入れると照合語彙を汚すため **カルテには入れず**、項目31 にのみ残す。
 *       同じ理由で項目12 の「いまは特に」も傾きには足さず、`lastUpdated` だけを更新して
 *       「答えたが、いまは特に」と「まだ答えていない」を見分けられるようにしてある。
 *
 * ─ PII 最小化 ─
 *   言葉の置き場に入れるのは原文と内部の連番だけ。LINE の userId は
 *   roji_word_person_refs（逆引き）にしか置かない。flow_events には自由文を一切入れない。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mergePersonaScores,
  type CustomerProfile,
  type LineUserProfile,
  type PersonaType,
  type RojiKarteFields,
  type SafetyDeclarationTag,
  type TasteProfile,
  type EventInterest,
} from "./firestore";
import { choiceOf, type KarteWrite, type StepId, type WordsContext } from "./roji-survey";

/**
 * 問い3（気持ち）の重み。好み診断（DIAGNOSIS_WEIGHT = 3・購入と同格）と揃える。
 * アンケートも診断と同じ「本人の自己申告 1 回」なので、別の重みを作らない。
 */
export const SURVEY_PERSONA_WEIGHT = 3;

/** 言葉の置き場に入れるときの出所（項目37・10種のうちの1つ）。 */
export const SURVEY_WORD_SOURCE = "survey_free_text";

/** 聞いた契機（項目31）。申込 / アンケート / ときどき1問 のうちの「アンケート」。 */
export const SURVEY_OCCASION = "survey";

/** カルテ（本カルテ・未連携カルテの共通部分）。 */
type Karte = RojiKarteFields & {
  persona?: CustomerProfile["persona"];
  tasteProfile?: TasteProfile;
};

function emptyTaste(): TasteProfile {
  return { preferredCategories: [], flavorPreferences: [], scenePref: null };
}

/**
 * 1 つの操作から、カルテに書く差分を作る（純粋・I/O なし）。
 *
 * `isFirstTap` は複数選べる問いの「1つ目のタップ」か（＝その場で答えが確定する）。
 * 既存の値は壊さない（配列は union・傾きは加算）。**消す方向の統合を絶対にしない。**
 */
export function surveyKarteUpdates(
  write: KarteWrite,
  existing: Karte,
  opts: { isFirstTap: boolean; now?: string },
): Partial<Karte> {
  const now = opts.now ?? new Date().toISOString();
  const out: Partial<Karte> = {};

  if (write.step && write.slug) {
    const choice = choiceOf(write.step, write.slug);
    if (!choice) return out;

    switch (write.step) {
      case "q1": {
        // 項目11。器が単一値のため、1つ目のタップ（確定した答え）だけを入れる（上の不足(a)）。
        if (!opts.isFirstTap) break;
        out.tasteProfile = { ...(existing.tasteProfile ?? emptyTaste()), scenePref: choice.label };
        break;
      }
      case "q2": {
        // 項目12。答えたことは必ず残す（lastUpdated）。「いまは特に」は傾きを足さない。
        const cur = existing.windowAffinity ?? {};
        const next: Record<string, unknown> = { ...cur, lastUpdated: now };
        if (!choice.undecided) {
          const key = choice.slug as keyof typeof cur;
          next[key] = ((cur[key] as number | undefined) ?? 0) + 1;
        }
        out.windowAffinity = next as RojiKarteFields["windowAffinity"];
        break;
      }
      case "q3": {
        // 項目7。「どれとも言えない」は傾きを動かさない。
        if (choice.undecided) break;
        const base = existing.persona?.scores ?? { serenity: 0, explorer: 0, sensory: 0 };
        const { scores, primary } = mergePersonaScores(
          base,
          [choice.slug as PersonaType],
          SURVEY_PERSONA_WEIGHT,
        );
        out.persona = { primary, scores, lastUpdated: now };
        break;
      }
      case "q4": {
        // 項目9。「決まっていない」は照合語彙を汚すためカルテに入れない（上の不足(b)）。
        if (choice.undecided) break;
        const taste = existing.tasteProfile ?? emptyTaste();
        if (taste.preferredCategories.includes(choice.slug)) break;
        out.tasteProfile = {
          ...taste,
          preferredCategories: [...taste.preferredCategories, choice.slug],
        };
        break;
      }
      case "q5": {
        // 項目6。〔特にない〕も本人の意思として入れる（未回答＝空欄とは別の値）。
        const tags = existing.safety?.tags ?? [];
        const tag = choice.slug as SafetyDeclarationTag;
        if (tags.includes(tag)) break;
        out.safety = { ...(existing.safety ?? {}), tags: [...tags, tag], updatedAt: now };
        break;
      }
      case "q6": {
        // 項目14。〔いまは出ない〕は本人の意思（空欄と同じに扱わない）。
        out.eventInterest = choice.slug as EventInterest;
        break;
      }
    }
  }

  // 項目20（訂正）＋ 項目7 の上書き。
  if (write.fixChoice !== undefined) {
    out.estimateCorrection = {
      ...(existing.estimateCorrection ?? {}),
      choice: write.fixChoice,
      correctedAt: now,
    };
    if (write.fixChoice) {
      // 「上書き」なので、直前にアンケートが足した分を戻してから足し直す（二重加算にしない）。
      // 戻す対象は「訂正の前に効いていた気持ち」= 問い3 の答え、または前回の訂正。
      const base = { ...(existing.persona?.scores ?? { serenity: 0, explorer: 0, sensory: 0 }) };
      const prev =
        write.fixUndo !== undefined ? write.fixUndo : (existing.estimateCorrection?.choice ?? null);
      const undo = (prev === write.fixChoice ? null : prev) as PersonaType | null;
      if (undo && undo in base) {
        base[undo] = Math.max(0, (base[undo] ?? 0) - SURVEY_PERSONA_WEIGHT);
      }
      const { scores, primary } = mergePersonaScores(
        base,
        [write.fixChoice as PersonaType],
        SURVEY_PERSONA_WEIGHT,
      );
      out.persona = { primary, scores, lastUpdated: now };
    }
  }

  // 項目19（1行の推定・いまの値）。
  if (write.estimateLine !== undefined) {
    out.estimateLine = write.estimateLine;
    out.estimateLineUpdatedAt = now;
  }

  // 項目18（言葉の引用の許可）。既定は「引用しない」。
  if (write.quoteConsent !== undefined) {
    out.quoteConsent = write.quoteConsent;
    out.quoteConsentAskedAt = now;
  }

  return out;
}

// ---------------------------------------------------------------------------
// カルテへの書き込み（I/O シーム。テストは fake を入れてネットワーク非接触にする）
// ---------------------------------------------------------------------------

export interface SurveyKarteDeps {
  resolveShopifyId: (lineUserId: string) => Promise<string | null>;
  getShopifyProfile: (shopifyId: string) => Promise<CustomerProfile | null>;
  updateShopifyProfile: (shopifyId: string, updates: Partial<CustomerProfile>) => Promise<void>;
  getLineProfile: (lineUserId: string) => Promise<LineUserProfile | null>;
  updateLineProfile: (lineUserId: string, updates: Partial<LineUserProfile>) => Promise<void>;
}

export type KarteRecordPath = "shopify" | "line" | "skipped";

/**
 * 答えを 1 件、カルテに書き込む（**その場で・1問ごとに独立して**）。
 *
 * 連携済みなら本カルテ、未連携なら未連携カルテ（3か所目を作らない）。
 * 差分が空のときは何も書かない（無駄な書き込みで lastActiveAt だけ動かさない）。
 */
export async function recordSurveyKarteWith(
  lineUserId: string,
  write: KarteWrite,
  opts: { isFirstTap: boolean; now?: string },
  deps: SurveyKarteDeps,
): Promise<KarteRecordPath> {
  const now = opts.now ?? new Date().toISOString();
  const shopifyId = await deps.resolveShopifyId(lineUserId);

  if (shopifyId) {
    const existing = (await deps.getShopifyProfile(shopifyId)) ?? {};
    const updates = surveyKarteUpdates(write, existing, { ...opts, now });
    if (Object.keys(updates).length === 0) return "skipped";
    await deps.updateShopifyProfile(shopifyId, { ...updates, lastActiveAt: now });
    return "shopify";
  }

  const existingLine = await deps.getLineProfile(lineUserId);
  const updates = surveyKarteUpdates(write, existingLine ?? {}, { ...opts, now });
  if (Object.keys(updates).length === 0) return "skipped";
  const payload: Partial<LineUserProfile> = { ...updates, lineUserId, lastActiveAt: now };
  if (!existingLine) payload.createdAt = now;
  await deps.updateLineProfile(lineUserId, payload);
  return "line";
}

// ---------------------------------------------------------------------------
// 言葉の置き場（項目34〜41）
// ---------------------------------------------------------------------------

export const ROJI_WORD_PERSONS = "roji_word_persons";
export const ROJI_WORD_PERSON_REFS = "roji_word_person_refs";
export const ROJI_WORDS = "roji_words";

/**
 * LINE の userId に対応する内部の連番を引く。無ければ作る（項目36）。
 * 名前は 1 文字も置かない。連番と実体の対応は refs にだけ持つ。
 */
export async function ensurePersonSeq(
  supabase: SupabaseClient,
  lineUserId: string,
): Promise<number | null> {
  const { data: found, error: findErr } = await supabase
    .from(ROJI_WORD_PERSON_REFS)
    .select("person_seq")
    .eq("subject_kind", "line")
    .eq("subject_id", lineUserId)
    .limit(1);
  if (findErr) {
    console.warn("[roji-survey] person ref lookup failed:", findErr.message);
    return null;
  }
  const hit = (found ?? [])[0] as { person_seq?: number } | undefined;
  if (hit?.person_seq != null) return Number(hit.person_seq);

  const { data: created, error: createErr } = await supabase
    .from(ROJI_WORD_PERSONS)
    .insert({})
    .select("person_seq")
    .limit(1);
  if (createErr) {
    console.warn("[roji-survey] person create failed:", createErr.message);
    return null;
  }
  const seq = ((created ?? [])[0] as { person_seq?: number } | undefined)?.person_seq;
  if (seq == null) return null;

  const { error: refErr } = await supabase
    .from(ROJI_WORD_PERSON_REFS)
    .insert({ person_seq: seq, subject_kind: "line", subject_id: lineUserId });
  if (refErr) {
    console.warn("[roji-survey] person ref create failed:", refErr.message);
    return null;
  }
  return Number(seq);
}

/**
 * ひとことを言葉の置き場に 1 件入れる（項目34〜41）。
 *
 * 原文はそのまま（項目34）。分類（項目40）は空で始める（空でも保存を止めない）。
 * 項目38（何についての言葉か）はこの時点で号も記事も無いので空。
 * 項目39（そのとき何が起きていたか）に、直前に押したものを入れる —— これが無いと、
 * 同じ一言が納得の言葉なのか違和感の言葉なのか、後から永久に分からない。
 *
 * 戻り値は成功したかどうかだけ（本文も ID もログに出さない）。
 */
export async function recordSurveyWord(
  supabase: SupabaseClient,
  lineUserId: string,
  body: string,
  context: WordsContext,
  now: string = new Date().toISOString(),
): Promise<boolean> {
  try {
    const personSeq = await ensurePersonSeq(supabase, lineUserId);
    if (personSeq == null) return false;
    const { error } = await supabase.from(ROJI_WORDS).insert({
      body,
      occurred_at: now,
      person_seq: personSeq,
      source: SURVEY_WORD_SOURCE,
      context_slug: context,
    });
    if (error) {
      console.warn("[roji-survey] word insert failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      "[roji-survey] word insert unexpected error:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
