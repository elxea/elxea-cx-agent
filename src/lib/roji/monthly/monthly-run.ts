/**
 * roji 月次処理の骨格（S1）— 「対象者を集める → 割当エンジンを呼ぶ → 台帳に書く → 月を締める」だけ。
 *
 * 設計正本: roji出し分けの仕組み 設計書（S1シンプル版・Setaka 承認済み 2026-08-10）
 *   https://www.notion.so/3b870c9d064c8191b807c59c1c2a6e74  第4章（B. 毎月どう回すか）
 * 台帳の器: `src/db/migrations/033_roji_delivery_ledger.sql`（適用済み・**本モジュールは DDL を足さない**）
 * Setaka 回答（2026-08-11）:
 *   Q1 = 月末日 23:59 JST 締め・翌月 1 日に計算（→ `period.ts` の `derivePeriod`）
 *   Q2 = 対象は**カルテがある人全員**（絞り込み条件を足さない）
 *
 * ─ 送信は構造で止める（設計 4-3・最優先の安全制約）─
 *   **本モジュールは送信系（`delivery-orchestrator` / `delivery-runtime` / `line*` / `segment-broadcast`）を
 *   一切 import しない。** 「フラグで止める」ではなく「呼ぶ手段を持たない」形にする。
 *   import が増えていないことは `tests/unit/roji-monthly-run.test.ts` がソースを読んで機械チェックする。
 *   スケジューラ（cron / launchd）への登録も本フェーズでは行わない（手動実行のみ）。
 *
 * ─ 何度流しても壊れない（設計 4-2）─
 *   冪等キー = (EC 上の顧客番号, 年月)。台帳に UNIQUE 制約として既にある。
 *   **既存行があれば upsert せずスキップする**（凍結原則: 一度確定した割当を再実行で上書きしない）。
 *   全員スキップでも月の締め記録は書く（＝「誰も居なかった」と「締めが走らなかった」を見分けるため）。
 *   途中で失敗したら例外をそのまま投げて**その月ごと止める**（月の締め記録を書かない ＝ 未締めとして残る）。
 *
 * ─ I/O は全部 `MonthlyPorts` の向こう側 ─
 *   本モジュールは Supabase も Notion も Firestore も直接触らない（純粋な手順だけを持つ）。
 *   実配線は `scripts/roji-monthly-run.ts`。テストは fake ポートを差し込んでネットワーク非接触で回す。
 */

import { s1Engine } from "../assignment/s1-engine";
import type {
  ArticleRef,
  AssignmentEngine,
  Candidate,
  ExclusionReason,
  LedgerRow,
  ReasonKey,
  RojiKarte,
  ScoreBreakdown,
  ShortageNote,
  TeaRef,
} from "../assignment/types";
import { assertValidPeriod } from "./period";

// ---------------------------------------------------------------------------
// 入出力の形
// ---------------------------------------------------------------------------

/**
 * 今月の対象者 1 人（Q2: カルテがある人全員）。
 *
 * 鍵が `shopifyCustomerId` なのは台帳の鍵がそれだから（migration 033 / 項目42）。
 * 未連携 LINE だけのカルテは台帳の鍵を持てないため、**鍵の解決は対象者を集める側（ポート）の責務**とし、
 * 本モジュールは「鍵付きで渡ってきた人」だけを見る（ここで推測して鍵を作らない）。
 */
export interface MonthlySubject {
  shopifyCustomerId: string;
  karte: RojiKarte;
}

/**
 * 割当を決めた時点の凍結値（項目48 `estimate_snapshot` に入れる jsonb の中身）。
 *
 * 台帳には「理由の記号」「点の内訳」「候補不足の印」を入れる列が無い。**列を足さず**（S1 は
 * 新テーブル・新列ゼロが前提）、形の決まっていない `estimate_snapshot` にまとめて凍結する。
 * 設計 7-2「S1 で使わなくても、今から必ず書くもの」（凍結値・点の出所の内訳）を満たすための置き場。
 */
export interface FrozenSnapshot {
  /** どのエンジンで決めたか（S2 で差し替えたとき、過去分と混ざらないようにする）。 */
  engine: "S1";
  /** 決めた時点のカルテ（現在値ではなく凍結値・項目48 の本体）。 */
  karte: RojiKarte;
  /** 理由 1 行の記号（文章ではない・設計 3-4）。 */
  reasonKey: ReasonKey;
  /** 点の内訳（内部用・表に出さない）。 */
  breakdown: ScoreBreakdown[];
  /** 候補不足 / 重複回避の緩和（黙って埋めない印・設計 3-2）。無ければ null。 */
  shortage: ShortageNote | null;
}

/** 台帳へ書く 1 行（列名は migration 033 に合わせた camelCase。SQL への写しはポート側）。 */
export interface LedgerWrite {
  shopifyCustomerId: string;
  period: string;
  /** 項目43: 今月のお茶。 */
  teas: TeaRef[];
  /** 項目49: 選ばなかった候補と理由記号。 */
  candidatesNotChosen: Array<{ ref: string; reason: ExclusionReason }>;
  /** 項目50: その号に置いた素材と順番（S1 の素材＝読みもの）。 */
  issueMaterials: Array<{ ref: string; position: number }>;
  /** 項目48: 凍結値。 */
  estimateSnapshot: FrozenSnapshot;
}

/** 月の締め記録（項目66 `roji_delivery_months`）。 */
export interface MonthRecord {
  period: string;
  closedAt: Date;
  /** その月の対象会員数。 */
  memberCount: number;
  /** 実行後にその月の台帳に存在する行数（既存スキップ分を含む）。 */
  rowCount: number;
}

/**
 * 外の世界（Supabase / Notion / Firestore）への口。実装は `scripts/roji-monthly-run.ts`。
 * すべて period か顧客番号だけを受ける（本モジュールが SQL や API の形を知らないようにする）。
 */
export interface MonthlyPorts {
  /** 対象者一覧（Q2: カルテがある人全員・台帳の鍵を持つ人）。 */
  listSubjects(period: string): Promise<MonthlySubject[]>;
  /** 今月出せる候補（お茶と読みもの）。 */
  loadCandidates(period: string): Promise<Candidate[]>;
  /** 重複回避用に読む、その人の直近の台帳行（対象月より前）。 */
  loadRecentLedger(shopifyCustomerId: string, period: string): Promise<LedgerRow[]>;
  /** 既に (顧客番号, 年月) の行があるか（冪等キーの判定）。 */
  hasLedgerRow(shopifyCustomerId: string, period: string): Promise<boolean>;
  /** 台帳へ 1 行 INSERT（UPDATE しない）。 */
  insertLedgerRow(row: LedgerWrite): Promise<void>;
  /** その月の台帳行数（締め記録の row_count 用）。 */
  countLedgerRows(period: string): Promise<number>;
  /** その月が既に締められているか。 */
  isMonthClosed(period: string): Promise<boolean>;
  /** 月の締め記録を 1 件 INSERT（既に締まっていれば呼ばれない）。 */
  insertMonthRecord(record: MonthRecord): Promise<void>;
}

/** スキップの理由（現状 1 種類だが、増えたときに呼び出し側が壊れないよう記号で持つ）。 */
export type SkipReason = "already_assigned";

/** 実行結果（画面にもログにも出せる素の値。ここに個人の氏名・住所・メールは入れない）。 */
export interface MonthlyRunResult {
  period: string;
  /** 対象者数（＝締め記録の member_count）。 */
  memberCount: number;
  /** 実行後の台帳行数（＝締め記録の row_count）。 */
  rowCount: number;
  /** 今回新しく台帳へ書いた人。 */
  assigned: string[];
  /** 既に行があって触らなかった人（凍結）。 */
  skipped: Array<{ shopifyCustomerId: string; reason: SkipReason }>;
  /** 候補不足 / 重複回避を緩めた人（黙って埋めないための可視化・設計 3-2）。 */
  shortages: Array<{ shopifyCustomerId: string; shortage: ShortageNote }>;
  /** 月の締め記録を書いたか、既に締まっていたか。 */
  monthRecord: "written" | "already_closed";
  /**
   * 対象者数と台帳行数が食い違ったか（migration 033 が「記録の事故（N3）」と呼ぶ状態）。
   * 呼び出し側はこれが true のとき人の目で確かめる。
   */
  countMismatch: boolean;
}

/** `runMonthlyAssignment` の任意引数。 */
export interface MonthlyRunOptions {
  /** 割当エンジン（S2 ではここだけ差し替える）。既定は S1。 */
  engine?: AssignmentEngine;
  /** 締め記録に書く時刻。テストは固定値を渡す（本モジュールは時計を読まない）。 */
  now?: Date;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/** 読みものの参照 → 素材（項目50）。position は 1 始まり（提示順そのもの）。 */
function toIssueMaterials(articles: ArticleRef[]): Array<{ ref: string; position: number }> {
  return articles
    .map((a, i) => ({ ref: (a?.id ?? "").trim(), position: i + 1 }))
    .filter((m) => m.ref.length > 0);
}

/**
 * 1 か月分を回す（設計 4-1 の順 1・2・3・4・8。順 5〜7＝人の確認・ページ表示・通知は本骨格の外）。
 *
 * **送信は一切呼ばない**（そもそも import していない）。スケジューラ登録もしない（手動実行のみ）。
 */
export async function runMonthlyAssignment(
  period: string,
  ports: MonthlyPorts,
  options: MonthlyRunOptions = {},
): Promise<MonthlyRunResult> {
  const p = assertValidPeriod(period);
  const engine = options.engine ?? s1Engine;
  const now = options.now ?? new Date();

  // 順1「締める」: その月の対象会員を確定する（Q2 = カルテがある人全員。ここで絞らない）。
  const subjects = await ports.listSubjects(p);
  // 候補プールは月に 1 回だけ読む（人ごとに読み直すと、実行の途中で候補が変わり得る）。
  const candidates = await ports.loadCandidates(p);

  const assigned: string[] = [];
  const skipped: Array<{ shopifyCustomerId: string; reason: SkipReason }> = [];
  const shortages: Array<{ shopifyCustomerId: string; shortage: ShortageNote }> = [];

  for (const subject of subjects) {
    const id = (subject?.shopifyCustomerId ?? "").trim();
    if (!id) {
      // 鍵の無い対象者は台帳に書けない。推測で鍵を作らず、その月ごと止める（設計 4-2）。
      throw new Error(`roji monthly: 対象者に EC 上の顧客番号がありません（period=${p}）`);
    }

    // 冪等（設計 4-2）: 既存行は upsert せず**スキップ**。人が直したものを機械が戻さない。
    if (await ports.hasLedgerRow(id, p)) {
      skipped.push({ shopifyCustomerId: id, reason: "already_assigned" });
      continue;
    }

    const recentLedger = await ports.loadRecentLedger(id, p);
    const result = engine.assign({
      period: p,
      karte: subject.karte,
      candidates,
      recentLedger,
    });

    await ports.insertLedgerRow({
      shopifyCustomerId: id,
      period: p,
      teas: result.teas,
      candidatesNotChosen: result.excluded.map((e) => ({ ref: e.ref.number, reason: e.reason })),
      issueMaterials: toIssueMaterials(result.articles),
      // 項目53（その月の1行 monthly_note）は**ここでは書かない**。migration 033 の CHECK は
      // 「closed_at がある行だけ空欄を許さない」形で、行を作る時点では未記入でよいと定めている。
      // 本骨格は行の closed_at を立てない（人の最終確認が済んでいないため）＝制約違反にならない。
      estimateSnapshot: {
        engine: "S1",
        karte: subject.karte,
        reasonKey: result.reasonKey,
        breakdown: result.breakdown,
        shortage: result.shortage,
      },
    });

    assigned.push(id);
    if (result.shortage) shortages.push({ shopifyCustomerId: id, shortage: result.shortage });
  }

  // 順8「月の締め記録を書く」。**全員スキップでも書く**（0 人の月と未実行の月を見分けるため）。
  const memberCount = subjects.length;
  const rowCount = await ports.countLedgerRows(p);
  const alreadyClosed = await ports.isMonthClosed(p);
  if (!alreadyClosed) {
    await ports.insertMonthRecord({ period: p, closedAt: now, memberCount, rowCount });
  }

  return {
    period: p,
    memberCount,
    rowCount,
    assigned,
    skipped,
    shortages,
    monthRecord: alreadyClosed ? "already_closed" : "written",
    countMismatch: memberCount !== rowCount,
  };
}
