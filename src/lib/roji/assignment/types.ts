/**
 * roji 出し分け（割当）— 段階を跨いで変えない「入口と出口」の形（M4-03）。
 *
 * 設計正本: roji出し分けの仕組み 設計書（S1シンプル版・Setaka 承認済み 2026-08-10）
 *   https://www.notion.so/3b870c9d064c8191b807c59c1c2a6e74  第3-5節
 * 上位の正本: roji マスタースペック https://www.notion.so/3af70c9d064c81a08be5eab8027dc2f4
 *
 * ─ この形を置く理由（設計 3-5）─
 *   割当のロジックは 1 モジュールに閉じ、呼び出す側（月次パイプライン・台帳・画面）は中身を知らない。
 *   S2 でロジックを丸ごと入れ替えても、外側は 1 行も変わらない。守る条件は 3 つだけ:
 *     (1) 入出力に I/O を含めない（テストできなくなる）
 *     (2) 同じ入力なら必ず同じ出力（再実行で結果が変わらない・乱数と時刻を読まない）
 *     (3) 外した理由を必ず返す（あとから検証できなくなる）
 *
 * ─ S1 の範囲（2026-08-10 Setaka 判断）─
 *   安全（アレルギー）の申告による除外は S1 では行わない（販売はお茶のみでリスク実態がないため）。
 *   維持するのは「もういらない」の除外・直近 3 か月の重複回避・「また入れてほしい」の優先（最大 2 本）。
 *   カルテの safety は従来どおり記録され続ける（読まないだけ）。S2 で条件として使う。
 *
 * ─ 優先順位（設計 3-1 / 3-6・2026-08-10 QA 指摘を受けて確定）─
 *   **「もういらない」 > 「また入れてほしい」 > 直近 3 か月の重複回避**
 *   希望が 3 本以上あるときは依頼の新しい順に 2 本（`moreOf` は追記順 = 末尾が最新。同着は銘柄番号昇順）。
 */

import type { PersonaType, TasteProfile, TeaRequestList, WindowAffinity } from "../../firestore";
import type { TeaItem } from "../../tea-menu";
import type { ArticleItem } from "../../journal";

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

/**
 * 割当が読むカルテの面（既存の型をそのまま使う・新しいカルテ項目を作らない）。
 *
 * `persona` / `tasteProfile` は既存スコア関数 `karteAffinity` がそのまま受ける面
 * （= 会話側・次の一杯と同じ面を読む。読む面を揃えて一貫性を保つ）。
 * `teaRequests` は項目13（また入れてほしい / もういらない）、`windowAffinity` は項目12。
 * `teaRequests.moreOf` は**追記順（末尾が最新）**で持つ。割当は新しい希望から順に 2 本を採るため、
 * 書き込む側は必ず末尾に足すこと（先頭に差し込むと「新しい順」の決定則が壊れる）。
 * すべて null / 未設定を許す（カルテは空のまま始められる。設計 3-2 のフォールバックへ落ちる）。
 */
export interface RojiKarte {
  persona: PersonaType | null;
  tasteProfile: TasteProfile | null;
  teaRequests?: TeaRequestList | null;
  windowAffinity?: WindowAffinity | null;
  /**
   * L1（CDP `subject_profile.exclusions`）由来のハード制約（統合設計 §3-2 / §6-1 Stage 4）。
   *
   * ─ なぜカルテと別に受けるのか ─
   *   Stage 4 は並走の段で、「もういらない」の書き手が Firestore のカルテ（項目13
   *   `teaRequests.noneOf`）と L0 の出来事（`exclusion.set`）の両方に居る。片方だけを
   *   読むと、もう片方に申告した人の「もういらない」が黙って無視される。
   *   よって **両方受けて和を採る**（除外は消す方向に畳まない、が原則）。
   *   Stage 5 で書き手が L0 1 本になったら `teaRequests` 側が落ちる。
   *
   * ─ 依存の向き ─
   *   CDP の型を import せず、必要な形だけをここに置く（割当エンジンは CDP を知らない）。
   */
  exclusions?: KarteHardExclusions | null;
}

/** 点数では絶対に覆らない制約（L1 由来）。 */
export interface KarteHardExclusions {
  /** 「もういらない」お茶の銘柄番号。`teaRequests.noneOf` と同じ意味・同じ扱い。 */
  teaRefs: string[];
  /**
   * 安全に関する申告のタグ（項目6）。
   *
   * ⚠ **S1 は割当の条件として読まない**（2026-08-10 Setaka 判断: 販売はお茶のみで
   *   リスク実態がないため）。ここに運ぶのは、S2 が条件として使うときに「カルテには
   *   あるが割当まで届いていない」状態を作らないため — 運ぶことと使うことは別で、
   *   使い始めるのは S2 でお茶側の属性が揃ってから。
   */
  safetyTags: string[];
}

/**
 * 今月出せる候補（お茶と読みもの）。1 本の配列で受け、エンジン側で種別に分ける。
 * 候補プールの解決（Set Menu List から Active/TB を抽出する等）は呼び出し側の責務（M2-11）。
 */
export type Candidate =
  | { kind: "tea"; tea: TeaItem }
  | { kind: "article"; article: ArticleItem };

/**
 * 送った記録の台帳の 1 行（重複回避に使う面だけ）。
 * 実体は Supabase `roji_delivery_ledger`（migration 033・適用済み）。読み出しは呼び出し側の責務。
 */
export interface LedgerRow {
  /** 年月（YYYY-MM）。 */
  period: string;
  /** その月に送ったお茶の参照（項目43）。 */
  teas: TeaRef[];
}

/** 割当エンジンの入力（純粋・I/O を含まない）。 */
export interface AssignmentInput {
  /** 対象の年月（YYYY-MM）。例: "2026-09" */
  period: string;
  karte: RojiKarte;
  /** 今月出せるお茶と読みもの。 */
  candidates: Candidate[];
  /** 直近数か月に送ったもの（重複回避用。対象月より前の行だけを見る）。 */
  recentLedger: LedgerRow[];
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

/**
 * お茶の参照。5 桁の銘柄番号が同一性の鍵（台帳・カルテの teaRequests も番号で持つ）。
 * `name` は台帳・画面の可読性のための写しであり、照合には使わない。
 */
export interface TeaRef {
  number: string;
  name?: string;
}

/** 読みものの参照（Notion Content Hub の page id が鍵）。 */
export interface ArticleRef {
  id: string;
  title?: string;
  url?: string;
}

/**
 * 理由 1 行の**記号**（文章そのものではない・設計 3-4）。
 * 文言の生成は表示側の責務。スコア・一致度・順位は絶対に表に出さない。
 *   - `requested_more`     「先月お伝えいただいた◯◯を、今月入れました」
 *   - `taste_match`        「◯◯の時間に合うお茶を選びました」
 *   - `not_enough_signal`  「まだ手がかりが少ないので、はじめの6つを選びました」
 * 優先順は上から（設計 3-4）。
 */
export type ReasonKey = "requested_more" | "taste_match" | "not_enough_signal";

/**
 * 候補を外した / 選ばなかった理由の記号（台帳 `candidates_not_chosen.reason` へ入る）。
 *   - `none_of`           「もういらない」に入っている（点数では絶対に覆らない）
 *   - `recent_duplicate`  直近 N か月に送った（N は `ShortageNote.relaxedRecentMonths` で分かる）
 *   - `category_cap`      同じ種類の上限（4 本）に当たって次点の別の種類へ譲った
 *   - `score_rank`        点数順で 6 本に届かなかった（外したのではなく、単に選ばれなかった）
 */
export type ExclusionReason = "none_of" | "recent_duplicate" | "category_cap" | "score_rank";

/** 選ばなかった候補と、その理由（台帳 項目49）。 */
export interface Excluded {
  ref: TeaRef;
  reason: ExclusionReason;
}

/**
 * 点の内訳（**内部用。表に出さない**）。あとから「なぜこうなったか」を再現するために台帳へ残す。
 * `score` は既存 `karteAffinity` の返り値そのもの（S1 は新しい軸を 1 つも足さない）。
 */
export interface ScoreBreakdown {
  ref: TeaRef;
  score: number;
  /** 並べ替え後の順位（1 始まり）。先取りした「また入れてほしい」は 0。 */
  rank: number;
  /** 最終的に選ばれたか。 */
  picked: boolean;
  /** 「また入れてほしい」として点数を見ずに先取りしたか（設計 3-1 順2）。 */
  preselected: boolean;
}

/**
 * 候補不足・重複回避の緩和の記録（設計 3-2）。**黙って埋めない**ための印で、月の締め記録に書く。
 *
 * 非 null になるのは次の 2 つだけ（どちらも「そのまま通してはいけない月」の印）:
 *   - `candidate_shortage`    6 本に満たなかった（本数を減らした）
 *   - `recent_window_relaxed` 重複回避を 3 か月 → 1 か月に緩めて 6 本を確保した
 * 何事もなく 6 本揃えば `null`。
 */
export interface ShortageNote {
  code: "candidate_shortage" | "recent_window_relaxed";
  /** 求めた本数（6）。 */
  requested: number;
  /** 実際に決まった本数。 */
  delivered: number;
  /**
   * 重複回避を緩めたときの月数（3 → 1）。緩めていなければ null。
   * 「もういらない」の除外は**決して緩めない**（本人の意思のため）。
   */
  relaxedRecentMonths: number | null;
}

/** 割当エンジンの出力。 */
export interface AssignmentResult {
  /** 決まったお茶（最大 6 本。順序は提示順）。 */
  teas: TeaRef[];
  /** 決まった読みもの。 */
  articles: ArticleRef[];
  /** 理由 1 行の記号（文章そのものではない）。 */
  reasonKey: ReasonKey;
  /** 内部用。表に出さない。 */
  breakdown: ScoreBreakdown[];
  /** 選ばなかった候補と理由記号 → 台帳へ。 */
  excluded: Excluded[];
  /**
   * 候補不足・重複回避の緩和が起きたときだけ非 null（設計 3-2）。
   * 上の 5 つの中核フィールドの形は段階を跨いで変えない。本項目は
   * 「黙って埋めない = 締め記録に書く」を呼び出し側へ伝えるためだけの付随情報。
   */
  shortage: ShortageNote | null;
}

/**
 * 割当エンジン。S1 は既存スコアラを呼ぶだけ。S2 で `S2Engine` に差し替える。
 * `assign` は**純粋関数**（I/O なし・同じ入力なら同じ出力・時刻と乱数を読まない）。
 */
export interface AssignmentEngine {
  assign(input: AssignmentInput): AssignmentResult;
}
