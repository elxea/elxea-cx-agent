/**
 * 休眠検知＋「静かな一通」（ブロック3-B）— 送信ゲート付きの再エンゲージ機構。
 *
 * 設計・体験原則: 統合設計書 §B（休眠検知＋静かな一通）／リポ CLAUDE.md（静かで丁寧・押し売り禁止・
 *   プッシュを増やさない・本文絵文字禁止・1メッセージ100文字目安）。文言正本は brand-copy.ts。
 *
 * 役割:
 *   lineUsers/{lineUserId}.lastActiveAt（firestore.ts:62 で書かれる）を読む「読む側」を実装し、
 *   一定日数（既定 60 日）活動の無い友だちを抽出して「静かな一通」を送る機構を作る。
 *   ただし本タスクは **仕組みのみ構築し送信は封鎖** する（DORMANT_SEND_ENABLED 既定 OFF）。
 *
 * 多層の送信ガード（既存 delivery / message-ledger と同じ思想）:
 *   1. DORMANT_SEND_ENABLED != "true" → dry-run。実送信せず「候補＋送るはずだった本文」を台帳へ記録するだけ。
 *   2. 恒久重複防止: dormant_reengagement_log（migration 025）で 1 人 1 回まで。
 *      再送は最短 90 日間隔（sent=true の行のみを再送ガードの対象にする）。
 *   3. 実行あたり上限（既定 20 通）+ 月次予算（LINE 無料枠 200 通/月）は line_message_ledger（migration 019）で会計。
 *   4. LINE 送信系 API は sendEnabled のときだけ呼ぶ（dry-run では api.line.me に一切接触しない）。
 *
 * 純度の分離（message-ledger.ts / broadcast-stats.ts と同じ設計）:
 *   - 純粋関数（isDormant / selectDormantCandidates / parsePositiveInt / jstDate / dormantAggregationUnit）
 *     … I/O なし・完全にユニットテスト可能。
 *   - I/O 実装（runDormantReengagement）… Supabase / Firestore / LINE。テストは fake / DI で純粋に保つ。
 *
 * fail-soft: cron 経路（index.ts）で未処理 reject を残さないため、実行時例外は throw せず
 *   ok:false（理由付き）に倒す（broadcast-stats.runBroadcastStatsFetch と同じ姿勢）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";
import {
  getFirestoreEnv,
  getAccessToken,
  firestoreBaseUrl,
  buildCollectionListQuery,
  LINE_USERS_COLLECTION,
  type FirestoreEnv,
} from "./firestore";
import {
  guardAndClaim,
  createSupabaseLedgerStore,
  createLineConsumptionFetcher,
  currentLineMonth,
} from "./message-ledger";
import { resolveDeliveryChannel } from "./delivery-channel";
import { jstYyyymmdd, isValidAggregationUnit } from "./aggregation-unit";
import {
  DORMANT_REENGAGEMENT_MESSAGE,
  buildDormantReengagementMessage,
  dormantCategoryReferencePhrase,
  DORMANT_TASTE_REFERENCE_SERENITY,
  DORMANT_TASTE_REFERENCE_SENSORY,
} from "./brand-copy";
import { categoryLabelForPreferred, type NextCupKarte } from "./next-cup";
import { loadCustomerKarte } from "./customer-karte";

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

/** 意思決定台帳テーブル名（migration 025）。 */
export const DORMANT_LOG_TABLE = "dormant_reengagement_log";

/** 1 日のミリ秒。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 休眠判定の既定しきい値（日）。env DORMANT_THRESHOLD_DAYS で上書き可能。
 *
 * 根拠（60 日を既定に選ぶ理由）:
 *   - elxea はクラフトティー（茶葉）。1 袋の消費サイクルは概ね 1〜2 か月で、購入/対話の自然な間隔もこの帯。
 *   - 60 日（約 2 か月）無反応は「消費が一巡しても戻ってこない」意味のある休眠シグナルで、
 *     かつ「1〜2 週間の生活の谷」で誤検知しない十分な保守性がある。
 *   - LINE 無料枠 200 通/月・友だち数十人規模では、しきい値を短くしても送る相手は増えないため、
 *     押し売りを避ける方向（長め）に倒す。運用計測（broadcast_stats）1 サイクル後に再調整する前提。
 */
export const DEFAULT_DORMANT_THRESHOLD_DAYS = 60;

/**
 * 再送の最短間隔（日）。一度「静かな一通」を送った相手には、最短でもこの日数は再送しない。
 * 90 日 = しきい値（60 日）より長く、季節が 1 つ変わる程度の間隔。押し売り防止の恒久ガード。
 * dry-run 行は実送信枠を消費しない（sent=true の行のみ再送ガードの対象）。
 */
export const RESEND_INTERVAL_DAYS = 90;

/** 1 回の実行での送信上限（既定 20 通）。env DORMANT_PER_RUN_CAP で上書き可能。月次予算は別レイヤ（ledger）。 */
export const DEFAULT_PER_RUN_CAP = 20;

// -------------------------------------------------------------------
// 型
// -------------------------------------------------------------------

/** Firestore lineUsers から読む最小の活動情報。 */
export interface LineUserActivity {
  lineUserId: string;
  /** ISO 8601 文字列。未設定・不明は null。 */
  lastActiveAt: string | null;
}

/** 抽出された休眠候補。 */
export interface DormantCandidate {
  lineUserId: string;
  lastActiveAt: string | null;
}

/** 台帳へ記録する 1 決定。 */
export interface DecisionRecord {
  lineUserId: string;
  /** JST 暦日 "YYYY-MM-DD"。 */
  decisionDate: string;
  lastActiveAt: string | null;
  dryRun: boolean;
  bodyPreview: string;
  aggregationUnit: string;
}

/** 1 候補の処理結果（PII を返さない・userId はマスク）。 */
export interface DormantDetail {
  userRefMasked: string;
  action: "sent" | "dry_run" | "budget_blocked" | "error";
  reason?: string;
}

/** ジョブ結果（証跡用の要約。PII・トークンは含めない）。 */
export interface DormantReengagementResult {
  ok: boolean;
  /** preflight 失敗等の理由（ok:false のとき）。 */
  reason?: string;
  sendEnabled: boolean;
  thresholdDays: number;
  perRunCap: number;
  /** 走査した lineUsers 総数。 */
  scanned: number;
  /** 上限クリップ後の候補数。 */
  candidates: number;
  /** 実送信数（dry-run 時は 0）。 */
  sent: number;
  /** dry-run 記録数（送信封鎖で「送らず記録だけ」した数）。 */
  dryRun: number;
  /** 予算/台帳ガードで送れなかった数。 */
  budgetBlocked: number;
  details: DormantDetail[];
}

// -------------------------------------------------------------------
// 純粋関数（I/O なし・完全にユニットテスト可能）
// -------------------------------------------------------------------

/** LINE userId をログ用にマスクする（先頭 8 文字 + "..."）。PII を要約に出さない。 */
export function maskUserRef(id: string): string {
  return typeof id === "string" && id.length > 8 ? `${id.slice(0, 8)}...` : "********";
}

/** 正の整数を env 文字列からパースする（不正・0 以下は fallback）。純粋。 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** lastActiveAt(ISO) を Date に。空・不正は null。純粋。 */
export function parseLastActive(iso: string | null | undefined): Date | null {
  if (typeof iso !== "string" || iso.trim().length === 0) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 休眠か（純粋）。lastActiveAt から thresholdDays 以上経過していれば true。
 * - lastActiveAt が無い/不正 → false（判定材料が無い相手には送らない・fail-safe）。
 * - 境界（ちょうど thresholdDays 経過）→ true（>=）。
 * - 未来日時（時計ズレ等で elapsed < 0）→ false。
 */
export function isDormant(
  lastActiveAt: Date | null,
  now: Date,
  thresholdDays: number,
): boolean {
  if (!lastActiveAt || Number.isNaN(lastActiveAt.getTime())) return false;
  const elapsed = now.getTime() - lastActiveAt.getTime();
  return elapsed >= thresholdDays * DAY_MS;
}

/**
 * 休眠候補を選定する（純粋）。
 *   1. 休眠（isDormant）である
 *   2. 直近 RESEND_INTERVAL に実送信済み（recentlySent）でない
 *   を満たす友だちを、lastActiveAt の古い順（＝より休眠が深い順）に並べ、cap で切る。
 *
 * @param users lineUsers 全走査結果。
 * @param recentlySent 90 日以内に実送信済みの lineUserId 集合（再送ガード）。
 * @param now 現在時刻。
 * @param thresholdDays 休眠しきい値（日）。
 * @param cap 1 実行の送信上限。
 */
export function selectDormantCandidates(
  users: ReadonlyArray<LineUserActivity>,
  recentlySent: ReadonlySet<string>,
  now: Date,
  thresholdDays: number,
  cap: number,
): DormantCandidate[] {
  const dormant = users.filter((u) => {
    if (!u.lineUserId) return false;
    if (recentlySent.has(u.lineUserId)) return false;
    return isDormant(parseLastActive(u.lastActiveAt), now, thresholdDays);
  });

  // 古い順（lastActiveAt 昇順）。null は最も古い扱い（先頭）。
  dormant.sort((a, b) => {
    const ta = parseLastActive(a.lastActiveAt)?.getTime() ?? -Infinity;
    const tb = parseLastActive(b.lastActiveAt)?.getTime() ?? -Infinity;
    return ta - tb;
  });

  return dormant.slice(0, Math.max(0, cap)).map((u) => ({
    lineUserId: u.lineUserId,
    lastActiveAt: u.lastActiveAt,
  }));
}

/** JST 暦日 "YYYY-MM-DD"（決定日・台帳の冪等キー）。純粋。 */
export function jstDate(date: Date = new Date()): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 休眠一通の集計単位名（純粋）。形式 `d{YYYYMMDD(JST)}_dorm`（例: d20260716_dorm）。
 * LINE 制約（半角英数字・_・最大30字）を満たす。同一 JST 日の休眠送信は 1 unit に集約される。
 */
export function dormantAggregationUnit(date: Date = new Date()): string {
  return `d${jstYyyymmdd(date)}_dorm`;
}

// -------------------------------------------------------------------
// カルテ個別最適（純粋・監査 punch-list #②-3）
//   休眠一通を「その人のたまったカルテ」で出し分ける。会話側 core.ts / 次の一杯 #2 / 一覧の出し分け
//   #②-2 と同じ persona / tasteProfile を読み、好みに合う参照（カテゴリ / 味の傾き）を本文に織り込む。
//   カルテが空・手がかり無しなら generic に倒す（no-karte ユーザーは完全に従来挙動＝無回帰）。
// -------------------------------------------------------------------

/**
 * カルテ（persona / tasteProfile）から休眠一通の「参照句」を導く（純粋・#②-3）。
 *
 * 重み付けは次の一杯 #2（karteAffinity）と同じ思想を再利用し一貫させる:
 *   優先1（強い明示シグナル）: tasteProfile.preferredCategories → 日本語カテゴリラベル
 *     （next-cup.categoryLabelForPreferred・CATEGORY_FAMILY 由来）。#2 の「カテゴリ一致 +2」に対応。
 *   優先2（弱い prior）: persona の傾き。serenity→まろやかな甘み / sensory→しっかりしたコク
 *     （next-cup の personaAromaLean / personaBodyLean と同根拠）。#2 の「persona 傾き +1」に対応。
 *   explorer（動機/新規性軸で味の傾きが定まらない）・カルテ空は参照句を作らない → null。
 *
 * @returns 末尾が「お茶」で終わる名詞句（buildDormantReengagementMessage に渡す）。手がかり無しは null。
 */
export function deriveDormantReferencePhrase(
  karte: NextCupKarte | null | undefined,
): string | null {
  if (!karte) return null;
  const label = categoryLabelForPreferred(karte.tasteProfile?.preferredCategories);
  if (label) return dormantCategoryReferencePhrase(label);
  if (karte.persona === "serenity") return DORMANT_TASTE_REFERENCE_SERENITY;
  if (karte.persona === "sensory") return DORMANT_TASTE_REFERENCE_SENSORY;
  return null;
}

/**
 * 休眠候補 1 人に送る本文を、その人のカルテで組む（純粋・#②-3）。
 * カルテに手がかりが無い（null / explorer / 未診断・未収集）ときは generic 版へ倒す（無回帰）。
 * 出力トーン・骨格・長さは generic と共有し、真ん中の 1 文だけがカルテで変わる（explainable）。
 */
export function buildDormantBody(karte: NextCupKarte | null | undefined): string {
  return buildDormantReengagementMessage(deriveDormantReferencePhrase(karte));
}

// -------------------------------------------------------------------
// オーケストレーション（DI・テストは fake を注入し純粋に保つ）
// -------------------------------------------------------------------

/** ジョブの依存（実 I/O は runtime、テストは fake を注入）。 */
export interface DormantReengagementDeps {
  now: Date;
  sendEnabled: boolean;
  thresholdDays: number;
  perRunCap: number;
  /** 全 lineUsers の活動時刻を返す（Firestore 走査）。取得不能は throw（上位 try で fail-soft）。 */
  loadLineUsers(): Promise<LineUserActivity[]>;
  /** sent=true かつ sent_at>=now-90日 の line_user_id 集合（再送ガード）。 */
  loadRecentlySent(): Promise<Set<string>>;
  /**
   * 候補 1 人のカルテ（persona / tasteProfile）を読む（個別最適 #②-3）。
   * 省略時は本文が generic 固定（後方互換）。既定（runDormantReengagement）は loadCustomerKarte で、
   * 会話側 core.ts / 次の一杯 #2 と同じ源を読む。fail-safe（Firebase 未設定・失敗は空カルテ）が期待仕様。
   */
  loadKarte?(lineUserId: string): Promise<NextCupKarte>;
  /** 決定行を冪等 upsert（同一 line_user_id×decision_date は 1 行）。 */
  recordDecision(input: DecisionRecord): Promise<void>;
  /** 実送信の予算/台帳ガード＋claim（message-ledger 経由）。dry-run では呼ばれない。 */
  claimBudget(lineUserId: string, unit: string): Promise<{ ok: boolean; reason?: string }>;
  /** LINE push 実行（dry-run では呼ばれない）。 */
  sendMessage(lineUserId: string, body: string, unit: string): Promise<void>;
  /** 実送信成功後に sent=true / sent_at を記録。 */
  markSent(lineUserId: string, decisionDate: string, sentAt: string): Promise<void>;
}

/**
 * オーケストレーション本体（DI 版・純粋にテスト可能）。
 *
 * 手順:
 *   1. lineUsers 全走査 + 再送ガード集合を並列取得。
 *   2. 休眠候補を選定（上限クリップ）。
 *   3. 候補ごとに: 個別最適本文を組む（#②-3）→ 決定行を必ず記録（冪等）。
 *      - 本文: deps.loadKarte があればカルテで出し分け（buildDormantBody・手がかり無しは generic）。
 *        loadKarte 省略時は引数 body 固定（後方互換）。個別最適は「本文の中身」だけを変える。
 *      - sendEnabled=false（既定）: dry-run（送らず個別最適本文を記録だけ）。
 *      - sendEnabled=true: 予算 claim → LINE push（個別最適本文）→ sent 記録。予算不足は budget_blocked。
 *   候補ごとの例外は握って continue（1 件の失敗で全体を止めない）。
 *
 * @param body カルテの手がかりが無い / loadKarte 未指定のときに使う generic 本文（既定 = ブランド正本）。
 */
export async function runDormantReengagementWith(
  deps: DormantReengagementDeps,
  body: string = DORMANT_REENGAGEMENT_MESSAGE,
): Promise<DormantReengagementResult> {
  const now = deps.now;
  const decisionDate = jstDate(now);
  const unit = dormantAggregationUnit(now);

  const [users, recentlySent] = await Promise.all([
    deps.loadLineUsers(),
    deps.loadRecentlySent(),
  ]);
  const scanned = users.length;

  const candidates = selectDormantCandidates(
    users,
    recentlySent,
    now,
    deps.thresholdDays,
    deps.perRunCap,
  );

  const details: DormantDetail[] = [];
  let sent = 0;
  let dryRun = 0;
  let budgetBlocked = 0;

  for (const c of candidates) {
    const masked = maskUserRef(c.lineUserId);
    try {
      // 個別最適 #②-3: この候補のカルテで本文を出し分ける。
      //   - deps.loadKarte 省略 → generic body 固定（後方互換・既存ユニットテスト経路）。
      //   - loadKarte 由来のカルテを buildDormantBody に通す（手がかり無し＝空カルテは generic に倒れる）。
      //   - 万一 loadKarte が throw しても generic に倒して送信/記録を止めない（fail-safe・no-karte 相当）。
      //   本文は「dry-run でも実送信でも同じ personalizedBody」を使う。送信可否は sendEnabled だけが握る
      //   （個別最適は本文の中身を変えるだけで、送信ゲート＝DORMANT_SEND_ENABLED には一切触れない）。
      let personalizedBody = body;
      if (deps.loadKarte) {
        try {
          personalizedBody = buildDormantBody(await deps.loadKarte(c.lineUserId));
        } catch {
          personalizedBody = body;
        }
      }

      // 決定は常に記録（dry-run でも観測できるように・冪等）。台帳には「送るはずだった個別最適本文」を残す。
      await deps.recordDecision({
        lineUserId: c.lineUserId,
        decisionDate,
        lastActiveAt: c.lastActiveAt,
        dryRun: !deps.sendEnabled,
        bodyPreview: personalizedBody,
        aggregationUnit: unit,
      });

      if (!deps.sendEnabled) {
        dryRun++;
        details.push({ userRefMasked: masked, action: "dry_run" });
        continue;
      }

      // 実送信経路（sendEnabled のときだけ到達）。予算 claim → push → sent 記録。
      const claim = await deps.claimBudget(c.lineUserId, unit);
      if (!claim.ok) {
        budgetBlocked++;
        details.push({ userRefMasked: masked, action: "budget_blocked", reason: claim.reason });
        continue;
      }
      await deps.sendMessage(c.lineUserId, personalizedBody, unit);
      await deps.markSent(c.lineUserId, decisionDate, now.toISOString());
      sent++;
      details.push({ userRefMasked: masked, action: "sent" });
    } catch (err) {
      details.push({
        userRefMasked: masked,
        action: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    sendEnabled: deps.sendEnabled,
    thresholdDays: deps.thresholdDays,
    perRunCap: deps.perRunCap,
    scanned,
    candidates: candidates.length,
    sent,
    dryRun,
    budgetBlocked,
    details,
  };
}

// -------------------------------------------------------------------
// I/O 実装（実 Supabase / Firestore / LINE・runtime のみ）
// -------------------------------------------------------------------

/**
 * dormant_reengagement_log の存在を確認する（preflight）。
 * 不在（migration 025 未適用）なら理由を返す。存在すれば null。
 * message-ledger.checkLedgerTables と同じく head select で軽量確認。
 */
export async function checkDormantTable(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { error } = await supabase
    .from(DORMANT_LOG_TABLE)
    .select("*", { head: true, count: "exact" });
  if (error) {
    return `required table "${DORMANT_LOG_TABLE}" is not accessible: ${error.message}${error.code ? ` (code: ${error.code})` : ""}`;
  }
  return null;
}

/** ページ収集ユーティリティ（cursor ページング）。 */
async function collectAllPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  maxPages = 100,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < maxPages; i++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return all;
}

/**
 * Firestore: lineUsers を全件走査して lastActiveAt を読む（休眠判定の材料）。
 * where フィルタは使わず全件走査（buildCollectionListQuery の注記参照・対象は友だち数十人で軽量）。
 * ドキュメント ID がそのまま Messaging API userId。lastActiveAt は stringValue/timestampValue 両対応。
 */
async function loadAllLineUserActivity(
  fsEnv: FirestoreEnv,
): Promise<LineUserActivity[]> {
  const accessToken = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
  const PAGE = 300;

  return collectAllPages<LineUserActivity>(async (cursor) => {
    const structuredQuery = buildCollectionListQuery(LINE_USERS_COLLECTION, {
      limit: PAGE,
      startAfterName: cursor,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      throw new Error(
        `Firestore runQuery (lineUsers 全走査) 失敗 (${res.status}): ${await res.text()}`,
      );
    }
    const rows = (await res.json()) as Array<{
      document?: { name: string; fields?: Record<string, Record<string, unknown>> };
    }>;

    const items: LineUserActivity[] = [];
    let lastName: string | undefined;
    let count = 0;
    for (const entry of rows) {
      if (!entry.document?.name) continue;
      count++;
      lastName = entry.document.name;
      const fields = entry.document.fields;
      const la = fields?.lastActiveAt as
        | { stringValue?: string; timestampValue?: string }
        | undefined;
      const lastActiveAt =
        typeof la?.stringValue === "string"
          ? la.stringValue
          : typeof la?.timestampValue === "string"
            ? la.timestampValue
            : null;
      const lineUserId = entry.document.name.split("/").pop() ?? "";
      if (!lineUserId) continue;
      items.push({ lineUserId, lastActiveAt });
    }
    const nextCursor = count >= PAGE ? lastName : undefined;
    return { items, nextCursor };
  });
}

/** LINE push（休眠一通・実送信経路のみ）。customAggregationUnits を付与して将来 insight を可能にする。 */
async function pushDormantMessage(
  channelToken: string,
  lineUserId: string,
  body: string,
  unit: string,
): Promise<void> {
  const messages = [{ type: "text", text: body }];
  const payload: Record<string, unknown> = { to: lineUserId, messages };
  if (isValidAggregationUnit(unit)) {
    payload.customAggregationUnits = [unit];
  }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`LINE push 失敗 (${res.status}): ${await res.text().catch(() => "")}`);
  }
}

/**
 * 休眠再エンゲージ ジョブ本体（runtime 配線）。実送信は sendEnabled のときだけ。
 *
 * deps 省略時は env から実 Supabase / Firestore / LINE（配信 OA トークン）を組み立てる。
 * fail-soft: 実行時例外は throw せず ok:false（理由付き）に倒す（cron 経路で未処理 reject を残さない）。
 */
export async function runDormantReengagement(
  env: Env,
  overrides?: Partial<DormantReengagementDeps>,
): Promise<DormantReengagementResult> {
  const now = overrides?.now ?? new Date();
  const sendEnabled = overrides?.sendEnabled ?? env.DORMANT_SEND_ENABLED === "true";
  const thresholdDays =
    overrides?.thresholdDays ??
    parsePositiveInt(env.DORMANT_THRESHOLD_DAYS, DEFAULT_DORMANT_THRESHOLD_DAYS);
  const perRunCap =
    overrides?.perRunCap ?? parsePositiveInt(env.DORMANT_PER_RUN_CAP, DEFAULT_PER_RUN_CAP);

  const base = {
    sendEnabled,
    thresholdDays,
    perRunCap,
    scanned: 0,
    candidates: 0,
    sent: 0,
    dryRun: 0,
    budgetBlocked: 0,
    details: [] as DormantDetail[],
  };

  try {
    // supabase は env 由来（ユニットテストは runDormantReengagementWith に fake port を注入し、この経路を通らない）。
    const sb = createSupabaseClient(env);

    // preflight（不在を早期に検知できたときだけ即返す・fast-path）。
    const preflight = await checkDormantTable(sb);
    if (preflight) {
      return {
        ok: false,
        reason: `preflight 失敗（migration 025 未適用の可能性）: ${preflight}`,
        ...base,
      };
    }

    // 配信 OA トークン（送信・予算 consumption 照合に使う）。dry-run でも consumption GET は使わないため
    // 未設定でも dry-run は成立する。sendEnabled のときだけ厳密に必要。
    let channelToken = "";
    try {
      channelToken = resolveDeliveryChannel(env).accessToken;
    } catch {
      // dry-run では未設定でも続行（送信経路に入らないため無害）。
      if (sendEnabled) {
        return {
          ok: false,
          reason: "配信チャネル未解決（DORMANT_SEND_ENABLED=true だが送信 OA トークン未設定・fail-closed）",
          ...base,
        };
      }
    }

    const ledgerStore = createSupabaseLedgerStore(sb);
    const consumptionFetcher = createLineConsumptionFetcher({
      LINE_CHANNEL_ACCESS_TOKEN: channelToken,
    } as Env);

    const deps: DormantReengagementDeps = {
      now,
      sendEnabled,
      thresholdDays,
      perRunCap,
      loadLineUsers:
        overrides?.loadLineUsers ??
        (async () => loadAllLineUserActivity(getFirestoreEnv(env))),
      loadRecentlySent:
        overrides?.loadRecentlySent ??
        (async () => {
          const cutoff = new Date(now.getTime() - RESEND_INTERVAL_DAYS * DAY_MS).toISOString();
          const { data, error } = await sb
            .from(DORMANT_LOG_TABLE)
            .select("line_user_id")
            .eq("sent", true)
            .gte("sent_at", cutoff);
          if (error) {
            throw new Error(`${DORMANT_LOG_TABLE} 再送ガード取得失敗: ${error.message}`);
          }
          return new Set(
            (data ?? []).map((r: { line_user_id: string }) => r.line_user_id),
          );
        }),
      // 個別最適 #②-3: 候補のカルテを会話側 core.ts / 次の一杯 #2 と同じ源（loadCustomerKarte）から読む。
      //   fail-safe: Firebase 未設定・リンク解決失敗・Firestore 読取失敗は空カルテ（generic に倒れる）。
      //   これは read-only（送信ではない）。送信ゲート（DORMANT_SEND_ENABLED）とは独立で、dry-run でも
      //   「送るはずだった個別最適本文」を台帳に残すために読む（本番でも fail-safe に無回帰）。
      loadKarte:
        overrides?.loadKarte ??
        ((lineUserId: string) => loadCustomerKarte(lineUserId, env, sb)),
      recordDecision:
        overrides?.recordDecision ??
        (async (input) => {
          const { error } = await sb.from(DORMANT_LOG_TABLE).upsert(
            {
              line_user_id: input.lineUserId,
              decision_date: input.decisionDate,
              last_active_at: input.lastActiveAt,
              sent: false,
              sent_at: null,
              dry_run: input.dryRun,
              body_preview: input.bodyPreview,
              aggregation_unit: input.aggregationUnit,
            },
            { onConflict: "line_user_id,decision_date", ignoreDuplicates: true },
          );
          if (error) {
            throw new Error(`${DORMANT_LOG_TABLE} 決定記録失敗: ${error.message}`);
          }
        }),
      claimBudget:
        overrides?.claimBudget ??
        (async (lineUserId, unit) => {
          const decision = await guardAndClaim(ledgerStore, consumptionFetcher, {
            notionPageId: `dormant_${lineUserId}`,
            month: currentLineMonth(now),
            recipients: 1,
            source: "interactive",
            aggregationUnit: unit,
          });
          return decision.ok
            ? { ok: true }
            : { ok: false, reason: "reason" in decision ? decision.reason : "unknown" };
        }),
      sendMessage:
        overrides?.sendMessage ??
        (async (lineUserId, body, unit) => {
          await pushDormantMessage(channelToken, lineUserId, body, unit);
        }),
      markSent:
        overrides?.markSent ??
        (async (lineUserId, decisionDate, sentAt) => {
          const { error } = await sb
            .from(DORMANT_LOG_TABLE)
            .update({ sent: true, sent_at: sentAt })
            .eq("line_user_id", lineUserId)
            .eq("decision_date", decisionDate);
          if (error) {
            throw new Error(`${DORMANT_LOG_TABLE} sent 記録失敗: ${error.message}`);
          }
        }),
    };

    return await runDormantReengagementWith(deps);
  } catch (err) {
    // fail-soft: テーブル不在（migration 未適用）・Firebase 未設定・一時的な DB エラー等は throw せず ok:false。
    return {
      ok: false,
      reason: `休眠再エンゲージ実行時エラー（fail-soft）: ${err instanceof Error ? err.message : String(err)}`,
      ...base,
    };
  }
}
