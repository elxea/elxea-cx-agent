/**
 * roji 出し分け S1 割当エンジン（M4-06）— 既にあるものを呼ぶだけの最小実装。
 *
 * 設計正本: roji出し分けの仕組み 設計書（S1シンプル版・Setaka 承認済み 2026-08-10）
 *   https://www.notion.so/3b870c9d064c8191b807c59c1c2a6e74  第3-1〜3-5節
 * 判断（2026-08-10 Setaka チャット回答）:
 *   判断1 = A（このまま着手） / 判断2 = A（既存スコア関数 `karteAffinity` の流用）
 *   追加 = **安全（アレルギー）の条件は S1 から除外**（販売はお茶のみでリスク実態がないため）。
 *          「もういらない」除外・直近 3 か月の重複回避・「また入れてほしい」優先（最大 2 本）は維持。
 *
 * ─ 決め方（設計 3-1・この順番で、必ずこの順番）─
 *   1. 外す（絶対条件）: 「もういらない」に入っているお茶
 *   2. 先に入れる: 「また入れてほしい」を最大 2 本（**直近 3 か月に送っていても入れる**）
 *   3. 残りから外す: 直近 3 か月に送ったお茶
 *   4. 点をつけて並べる: 既存 `karteAffinity` をそのまま呼ぶ（新しい軸を 1 つも足さない）
 *   5. 上から取って 6 本にする: 同点は銘柄番号の昇順。同じ種類が 4 本を超えたら次点の別の種類へ譲る
 *   6. 凍結して記録する: 本モジュールは**結果オブジェクトを返すところまで**。
 *      台帳への書き込み・凍結スナップショットの永続化は月次パイプライン側（次 PR）の責務。
 *
 * ─ 優先順位（2026-08-10 QA 指摘を受けて設計書 3-1 / 3-6 で確定）─
 *   **「もういらない」 > 「また入れてほしい」 > 直近 3 か月の重複回避**
 *   - 「もういらない」は点数でも別の希望でも覆らない（同じ銘柄が両方に入っていたら「もういらない」が勝つ）
 *   - 本人が名指しで希望したものは重複回避に勝つ。そうしないと運用初期の 3 か月は
 *     「言っておけば効く」という唯一の約束が一度も発火しない
 *   - 希望が 3 本以上残っているときは**依頼の新しい順に 2 本**（`moreOf` は追記順 = 末尾が最新。
 *     同着は銘柄番号の昇順）。同じ入力なら必ず同じ出力になる決定則を置く
 *
 * ─ 守る 3 条件（設計 3-5）─
 *   純粋関数（I/O なし）／同じ入力なら同じ出力（乱数・時刻を読まない）／外した理由を必ず返す。
 */

import { karteAffinity } from "../../next-cup";
import { pickArticles, type ArticleItem } from "../../journal";
import type { TeaItem } from "../../tea-menu";
import type {
  ArticleRef,
  AssignmentEngine,
  AssignmentInput,
  AssignmentResult,
  Excluded,
  LedgerRow,
  ReasonKey,
  RojiKarte,
  ScoreBreakdown,
  ShortageNote,
  TeaRef,
} from "./types";

// ---------------------------------------------------------------------------
// S1 の定数（設計 3-6「本設計書で新しく決めたこと」。正本には規定が無い値）
// ---------------------------------------------------------------------------

/** 1 人 1 月に決めるお茶の本数。 */
export const S1_TEA_COUNT = 6;
/** 「また入れてほしい」を点数を見ずに先取りする上限。 */
export const S1_MORE_OF_MAX = 2;
/** 重複回避の期間（月）。 */
export const S1_RECENT_MONTHS = 3;
/** 候補が足りないときに緩める重複回避の期間（月）。設計 3-2 の段階(1)。 */
export const S1_RECENT_MONTHS_RELAXED = 1;
/** 同じ種類（緑茶など）の上限。 */
export const S1_SAME_CATEGORY_MAX = 4;
/** 決める読みものの本数（S1 は号 1 本）。 */
export const S1_ARTICLE_COUNT = 1;

// ---------------------------------------------------------------------------
// 小さな純粋ヘルパ
// ---------------------------------------------------------------------------

/** 参照（銘柄番号）の正規化。カルテ・台帳は 5 桁番号で持つ（`TeaRequestList` の実データ準拠）。 */
function normRef(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "YYYY-MM" → 通し月番号。形式外は null（fail-safe に無視する）。 */
export function periodIndex(period: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec((period ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
}

/**
 * 直近 `months` か月に送ったお茶の番号（設計 3-1 順1）。
 *
 * 対象は**対象月より前の行だけ**。同じ月の行（= 再実行時に既に自分が書いた行）を数えると、
 * 2 回目の実行で自分の割当を全部除外してしまい「同じ入力なら同じ出力」が壊れるため。
 * 期間の形式が壊れている行は無視する（決定的・黙って落ちても結果は再現できる）。
 */
export function recentTeaNumbers(
  rows: LedgerRow[],
  period: string,
  months: number,
): Set<string> {
  const target = periodIndex(period);
  const out = new Set<string>();
  if (target === null) return out;
  for (const row of rows ?? []) {
    const idx = periodIndex(row?.period ?? "");
    if (idx === null) continue;
    const diff = target - idx;
    if (diff < 1 || diff > months) continue;
    for (const t of row.teas ?? []) {
      const n = normRef(t?.number);
      if (n) out.add(n);
    }
  }
  return out;
}

/** TeaItem → TeaRef（台帳・画面へ渡す最小の写し）。 */
function toRef(tea: TeaItem): TeaRef {
  return { number: tea.number, name: tea.name };
}

/** ArticleItem → ArticleRef。 */
function toArticleRef(a: ArticleItem): ArticleRef {
  return { id: a.id, title: a.title, url: a.url };
}

/** 決定的順序: 点の高い順 → 銘柄番号の昇順（乱数を使わない・設計 3-2）。 */
function byScoreThenNumber(
  a: { tea: TeaItem; score: number },
  b: { tea: TeaItem; score: number },
): number {
  const d = b.score - a.score;
  return d !== 0 ? d : a.tea.number.localeCompare(b.tea.number);
}

// ---------------------------------------------------------------------------
// S1Engine
// ---------------------------------------------------------------------------

/**
 * S1 の割当エンジン。**新しいスコア式を作らず、既存 `karteAffinity` をそのまま呼ぶ**。
 * S2 では本クラスを `S2Engine` に差し替えるだけでよい（入出力の形は `types.ts` で固定済み）。
 */
export class S1Engine implements AssignmentEngine {
  assign(input: AssignmentInput): AssignmentResult {
    const karte: RojiKarte = input?.karte ?? { persona: null, tasteProfile: null };
    const excluded: Excluded[] = [];

    // --- 候補を種別に分ける（お茶は番号で重複排除・先勝ち）。
    const teas: TeaItem[] = [];
    const articles: ArticleItem[] = [];
    const seen = new Set<string>();
    for (const c of input?.candidates ?? []) {
      if (c?.kind === "tea") {
        const n = normRef(c.tea?.number);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        teas.push(c.tea);
      } else if (c?.kind === "article") {
        articles.push(c.article);
      }
    }

    // --- 順1: 「もういらない」を外す（絶対条件。点数でも別の希望でも覆らない・決して緩めない）。
    //     同じ銘柄が「もういらない」と「また入れてほしい」の両方にあるときは、ここで落ちる
    //     ＝ **「もういらない」が勝つ**（設計 3-6）。
    const noneOf = new Set(
      (karte.teaRequests?.noneOf ?? []).map(normRef).filter((s) => s.length > 0),
    );
    const afterNoneOf: TeaItem[] = [];
    for (const t of teas) {
      if (noneOf.has(normRef(t.number))) {
        excluded.push({ ref: toRef(t), reason: "none_of" });
      } else {
        afterNoneOf.push(t);
      }
    }

    // --- 順2: 「また入れてほしい」を最大 2 本、点数を見ずに先取りする（本人へのただ一つの約束）。
    //     **重複回避（順3）より先に行う**。本人が名指しで希望したものは、直近 3 か月に送っていても入れる。
    //     選ぶ順は**依頼の新しい順**（`moreOf` は追記順で持ち、末尾が最新）。同着は銘柄番号の昇順
    //     ＝ 同じ入力なら必ず同じ 2 本になる（設計 3-6）。
    const moreOfRaw = (karte.teaRequests?.moreOf ?? []).map(normRef).filter((s) => s.length > 0);
    const seenMore = new Set<string>();
    const moreOfByRecency: Array<{ ref: string; order: number }> = [];
    for (let i = moreOfRaw.length - 1; i >= 0; i--) {
      const ref = moreOfRaw[i];
      if (seenMore.has(ref)) continue; // 同じ銘柄が複数回あれば新しい方（＝末尾側）を採る
      seenMore.add(ref);
      moreOfByRecency.push({ ref, order: i });
    }
    // 上の走査で既に「新しい順」だが、第2キー（銘柄番号の昇順）を明示して決定則を固定する。
    moreOfByRecency.sort((a, b) => b.order - a.order || a.ref.localeCompare(b.ref));

    const preselected: TeaItem[] = [];
    for (const { ref } of moreOfByRecency) {
      if (preselected.length >= S1_MORE_OF_MAX) break;
      const hit = afterNoneOf.find((t) => normRef(t.number) === ref);
      if (hit) preselected.push(hit);
    }
    const preselectedNums = new Set(preselected.map((t) => normRef(t.number)));

    // --- 順3: 残り（＝先取りしていないもの）から直近 N か月に送ったものを外す。
    //     足りなければ N を 1 か月に緩める（設計 3-2 段階(1)）。「もういらない」は緩めない。
    const remaining = afterNoneOf.filter((t) => !preselectedNums.has(normRef(t.number)));
    const recent = recentTeaNumbers(
      input?.recentLedger ?? [],
      input?.period ?? "",
      S1_RECENT_MONTHS,
    );
    let pool = remaining.filter((t) => !recent.has(normRef(t.number)));
    let relaxedRecentMonths: number | null = null;

    if (
      preselected.length + pool.length < S1_TEA_COUNT &&
      S1_RECENT_MONTHS_RELAXED < S1_RECENT_MONTHS
    ) {
      const relaxedRecent = recentTeaNumbers(
        input?.recentLedger ?? [],
        input?.period ?? "",
        S1_RECENT_MONTHS_RELAXED,
      );
      const relaxedPool = remaining.filter((t) => !relaxedRecent.has(normRef(t.number)));
      if (relaxedPool.length > pool.length) {
        pool = relaxedPool;
        relaxedRecentMonths = S1_RECENT_MONTHS_RELAXED;
      }
    }
    const inPool = new Set(pool.map((t) => normRef(t.number)));
    for (const t of remaining) {
      if (!inPool.has(normRef(t.number))) {
        excluded.push({ ref: toRef(t), reason: "recent_duplicate" });
      }
    }

    // --- 順4: 残りに点をつけて並べる（既存 `karteAffinity` をそのまま呼ぶ）。
    const scored = pool
      .map((tea) => ({ tea, score: karteAffinity(tea, karte) }))
      .sort(byScoreThenNumber);

    // --- 順5: 上から取って 6 本にする。同じ種類が 4 本を超えたら次点の別の種類へ譲る。
    //     譲られた候補は捨てず、最後に本数が足りなければ順位順に戻す（本数を優先する）。
    const picked: TeaItem[] = [...preselected];
    const categoryCount = new Map<string, number>();
    const bump = (tea: TeaItem) => {
      const key = tea.category ?? "";
      categoryCount.set(key, (categoryCount.get(key) ?? 0) + 1);
    };
    for (const t of preselected) bump(t);

    const deferred: Array<{ tea: TeaItem; score: number; rank: number }> = [];
    const notPicked: Array<{ tea: TeaItem; score: number; rank: number }> = [];
    scored.forEach((s, i) => {
      const rank = i + 1;
      if (picked.length >= S1_TEA_COUNT) {
        notPicked.push({ ...s, rank });
        return;
      }
      if ((categoryCount.get(s.tea.category ?? "") ?? 0) >= S1_SAME_CATEGORY_MAX) {
        deferred.push({ ...s, rank });
        return;
      }
      picked.push(s.tea);
      bump(s.tea);
    });
    // 種類の上限で譲った候補を、本数が足りない分だけ順位順に戻す。
    const restoredFromCap = new Set<string>();
    for (const d of deferred) {
      if (picked.length >= S1_TEA_COUNT) break;
      picked.push(d.tea);
      bump(d.tea);
      restoredFromCap.add(normRef(d.tea.number));
    }

    const pickedNums = new Set(picked.map((t) => normRef(t.number)));
    for (const d of deferred) {
      if (!restoredFromCap.has(normRef(d.tea.number))) {
        excluded.push({ ref: toRef(d.tea), reason: "category_cap" });
      }
    }
    for (const s of notPicked) {
      excluded.push({ ref: toRef(s.tea), reason: "score_rank" });
    }

    // --- 内訳（内部用・表に出さない）。先取り分は rank 0（点数で決めていないため）。
    const breakdown: ScoreBreakdown[] = [
      ...preselected.map((tea) => ({
        ref: toRef(tea),
        score: karteAffinity(tea, karte),
        rank: 0,
        picked: true,
        preselected: true,
      })),
      ...scored.map((s, i) => ({
        ref: toRef(s.tea),
        score: s.score,
        rank: i + 1,
        picked: pickedNums.has(normRef(s.tea.number)),
        preselected: false,
      })),
    ];

    // --- 理由 1 行の記号（設計 3-4 の優先順）。スコア・順位は表に出さない。
    const hasSignal = scored.some((s) => s.score > 0);
    const reasonKey: ReasonKey =
      preselected.length > 0 ? "requested_more" : hasSignal ? "taste_match" : "not_enough_signal";

    // --- 候補不足 / 重複回避を緩めたことの記録（設計 3-2「黙って埋めない」）。
    let shortage: ShortageNote | null = null;
    if (picked.length < S1_TEA_COUNT) {
      shortage = {
        code: "candidate_shortage",
        requested: S1_TEA_COUNT,
        delivered: picked.length,
        relaxedRecentMonths,
      };
    } else if (relaxedRecentMonths !== null) {
      shortage = {
        code: "recent_window_relaxed",
        requested: S1_TEA_COUNT,
        delivered: picked.length,
        relaxedRecentMonths,
      };
    }

    // --- 読みもの（設計 3-3）: 既存 `pickArticles` をそのまま呼ぶ。
    //     好みタイプで一次マッチ → 無ければ新しい順（行き止まりにしない）。
    //     6 つの窓への傾き（項目12）による並べ替えは **S1 では行わない**:
    //     記事側に「窓」の目印が無く（付いているのは content_persona だけ・第6-1節）、
    //     対応づけを本モジュールで発明すると設計に無い規則が増えるため。窓は S2 で扱う。
    const articleRefs = pickArticles(articles, { persona: karte.persona }, S1_ARTICLE_COUNT).map(
      toArticleRef,
    );

    return {
      teas: picked.map(toRef),
      articles: articleRefs,
      reasonKey,
      breakdown,
      excluded,
      shortage,
    };
  }
}

/** 既定のエンジン実体（呼び出し側はこれを使う。S2 でここだけ差し替える）。 */
export const s1Engine: AssignmentEngine = new S1Engine();
