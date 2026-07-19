/**
 * マルシェ入口「番号未送信」活性化ナッジ（spec drift #1）— 送信ゲート付きの短期活性化機構。
 *
 * 設計・体験原則: personalization-spec §6 優先2 / Table B 監査 #1（⚠️ 設計最大の抜け）。
 *   ジャーニーマップ §17:334 は「マルシェ入口＝最大の入口」と名指すが、袋の 5 桁番号を送らずに
 *   （＝お茶カード未到達で）静かになった友だちには短期ホライズンの再喚起が無かった。唯一の再エンゲージは
 *   休眠 60 日・本番 OFF（dormant-reengagement.ts）で、day-1..数日の drop-off を拾えない。ここを埋める。
 *   文言正本は brand-copy.ts（MARCHE_ACTIVATION_MESSAGE）。
 *
 * 役割（dormant-reengagement.ts と同じ思想を再利用・reinvent しない）:
 *   Firestore lineUsers を走査し「onboarding.source = marche かつ お茶カード未到達（tea.card_view 無し）
 *   かつ 追加から短いしきい値を過ぎ、まだ短期ウィンドウ内」の友だちに、1 回だけ静かなナッジを送る。
 *   ただし本機能は **仕組みのみ構築し送信は封鎖** する（MARCHE_SEND_ENABLED 既定 OFF）。
 *
 * 「番号未送信 / card 未到達」の検出（read-only・書き込み側は不変）:
 *   flow_events（migration 021）は 5 桁番号 → お茶カード提示のたびに tea.card_view を user_ref=lineUserId で
 *   記録している。よって「tea.card_view を 1 度も持たない lineUserId」= 番号未送信 / カード未到達。
 *   新たな書き込みを足さず、既存の観測ログを read-only に読むだけで検出できる（write surface ゼロ）。
 *
 * 多層の送信ガード（dormant-reengagement / message-ledger と同一思想）:
 *   1. MARCHE_SEND_ENABLED != "true" → dry-run。実送信せず「候補＋送るはずだった本文」を台帳へ記録するだけ。
 *   2. 恒久重複防止: marche_activation_log（migration 026）で 1 人 1 回まで（sent=true 行のみ dedup 対象）。
 *      dormant（90 日再送）と違い activation は再送間隔を持たない＝一度送ったら二度と送らない。
 *   3. 実行あたり上限（既定 20 通）+ 月次予算（LINE 無料枠 200 通/月）は line_message_ledger（migration 019）で会計。
 *   4. LINE 送信系 API は sendEnabled のときだけ呼ぶ（dry-run では api.line.me に一切接触しない）。
 *
 * 純度の分離（dormant-reengagement.ts と同じ設計）:
 *   - 純粋関数（isMarcheSource / isPastActivationThreshold / isWithinActivationWindow /
 *     selectActivationCandidates / parsePositiveInt / jstDate / marcheActivationAggregationUnit）… I/O なし。
 *   - I/O 実装（runMarcheActivation）… Supabase / Firestore / LINE。テストは fake / DI で純粋に保つ。
 *
 * fail-soft: cron 経路（index.ts）で未処理 reject を残さないため、実行時例外は throw せず
 *   ok:false（理由付き）に倒す（dormant-reengagement / broadcast-stats と同じ姿勢）。
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
import { FLOW_EVENTS_TABLE } from "./flow-events";
import { MARCHE_ACTIVATION_MESSAGE } from "./brand-copy";

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

/** 意思決定台帳テーブル名（migration 026）。 */
export const MARCHE_ACTIVATION_LOG_TABLE = "marche_activation_log";

/** お茶カード到達を示す flow_events のイベント名（read-only 検出の鍵）。 */
export const TEA_CARD_VIEW_EVENT = "tea.card_view";

/** onboarding.source がマルシェ入口であることを示す値（welcome-onboarding.WelcomeSource と一致）。 */
export const MARCHE_SOURCE = "marche";

/** 1 日のミリ秒。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 活性化ナッジを送る「下限しきい値」（日）。env MARCHE_ACTIVATION_THRESHOLD_DAYS で上書き可能。
 *
 * 🅙 判断（設計非指定）: personalization-spec は「追加後 翌日〜数日」とだけ述べ具体値を指定しない。
 *   1 日を既定に選ぶ理由:
 *   - マルシェで追加したその瞬間に番号を送る人は多い。追加当日に急かすのは「押し売りしない・静か」原則に反する。
 *   - 追加から丸 1 日たっても番号未送信＝「その場では送らなかった / 忘れた」シグナルで、静かに 1 回だけ思い出す
 *     のに無理のない最短。運用計測（flow_events / 本台帳）1 サイクル後に再調整する前提。
 */
export const DEFAULT_ACTIVATION_THRESHOLD_DAYS = 1;

/**
 * 活性化ナッジの「上限ウィンドウ」（日）。env MARCHE_ACTIVATION_WINDOW_DAYS で上書き可能。
 *
 * 🅙 判断（設計非指定）: 本ナッジは「短期ホライズンの活性化」であり、遠い過去に追加して未活性のまま放置された
 *   友だちは休眠再エンゲージ（dormant-reengagement・60 日）の担当に譲る（二重接触を避ける）。追加から
 *   14 日（約 2 週間）を過ぎたら activation は打たない。「翌日〜数日」を余裕をもって包む短期窓の既定値。
 */
export const DEFAULT_ACTIVATION_WINDOW_DAYS = 14;

/** 1 回の実行での送信上限（既定 20 通）。env MARCHE_ACTIVATION_PER_RUN_CAP で上書き可能。月次予算は別レイヤ（ledger）。 */
export const DEFAULT_PER_RUN_CAP = 20;

// -------------------------------------------------------------------
// 型
// -------------------------------------------------------------------

/** Firestore lineUsers から読む最小の活性化判定情報。 */
export interface MarcheUser {
  lineUserId: string;
  /** 友だち追加時刻の ISO 8601（lineUsers/{id}.createdAt）。未設定・不明は null。 */
  createdAt: string | null;
  /** 入口（onboarding.source）。marche 判定に使う。未設定・不明は null。 */
  source: string | null;
}

/** 抽出された活性化候補。 */
export interface ActivationCandidate {
  lineUserId: string;
  createdAt: string | null;
}

/** 台帳へ記録する 1 決定。 */
export interface ActivationDecisionRecord {
  lineUserId: string;
  /** JST 暦日 "YYYY-MM-DD"。 */
  decisionDate: string;
  createdAt: string | null;
  dryRun: boolean;
  bodyPreview: string;
  aggregationUnit: string;
}

/** 1 候補の処理結果（PII を返さない・userId はマスク）。 */
export interface ActivationDetail {
  userRefMasked: string;
  action: "sent" | "dry_run" | "budget_blocked" | "error";
  reason?: string;
}

/** ジョブ結果（証跡用の要約。PII・トークンは含めない）。 */
export interface MarcheActivationResult {
  ok: boolean;
  /** preflight 失敗等の理由（ok:false のとき）。 */
  reason?: string;
  sendEnabled: boolean;
  thresholdDays: number;
  windowDays: number;
  perRunCap: number;
  /** 走査した marche-source lineUsers 総数。 */
  scanned: number;
  /** 上限クリップ後の候補数。 */
  candidates: number;
  /** 実送信数（dry-run 時は 0）。 */
  sent: number;
  /** dry-run 記録数（送信封鎖で「送らず記録だけ」した数）。 */
  dryRun: number;
  /** 予算/台帳ガードで送れなかった数。 */
  budgetBlocked: number;
  details: ActivationDetail[];
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

/** createdAt(ISO) を Date に。空・不正は null。純粋。 */
export function parseCreatedAt(iso: string | null | undefined): Date | null {
  if (typeof iso !== "string" || iso.trim().length === 0) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** onboarding.source がマルシェ入口か（純粋・完全一致）。 */
export function isMarcheSource(source: string | null | undefined): boolean {
  return source === MARCHE_SOURCE;
}

/**
 * 活性化しきい値を過ぎたか（純粋・下限）。createdAt から thresholdDays 以上経過していれば true。
 * - createdAt が無い/不正 → false（判定材料が無い相手には送らない・fail-safe）。
 * - 境界（ちょうど thresholdDays 経過）→ true（>=）。
 * - 未来日時（時計ズレ等で elapsed < 0）→ false。
 */
export function isPastActivationThreshold(
  createdAt: Date | null,
  now: Date,
  thresholdDays: number,
): boolean {
  if (!createdAt || Number.isNaN(createdAt.getTime())) return false;
  const elapsed = now.getTime() - createdAt.getTime();
  return elapsed >= thresholdDays * DAY_MS;
}

/**
 * 短期ウィンドウ内か（純粋・上限）。createdAt から windowDays 以内なら true（＝まだ activation の担当範囲）。
 * - createdAt が無い/不正 → false（材料が無い＝範囲外扱い・fail-safe）。
 * - 境界（ちょうど windowDays 経過）→ true（<=）。それを超えたら休眠再エンゲージへ譲る。
 */
export function isWithinActivationWindow(
  createdAt: Date | null,
  now: Date,
  windowDays: number,
): boolean {
  if (!createdAt || Number.isNaN(createdAt.getTime())) return false;
  const elapsed = now.getTime() - createdAt.getTime();
  return elapsed >= 0 && elapsed <= windowDays * DAY_MS;
}

/**
 * 活性化候補を選定する（純粋）。次を満たす友だちを createdAt 昇順（＝離脱が古い＝窓を抜けそうな順）で cap 切り:
 *   1. onboarding.source = marche（マルシェ入口）
 *   2. お茶カード未到達（usersWithCard に含まれない ＝ 5 桁番号未送信）
 *   3. 既ナッジ済みでない（alreadyNudged に含まれない ＝ 恒久 dedup・1 人 1 回）
 *   4. 追加から thresholdDays 以上経過（下限）かつ windowDays 以内（上限・短期窓）
 *
 * @param users marche-source lineUsers（runtime は loader が marche 済みで渡すが、ここでも防御的に再判定する）。
 * @param usersWithCard tea.card_view を 1 度でも持つ lineUserId 集合（＝カード到達済み・番号送信済み）。
 * @param alreadyNudged 既に実送信で activation 済みの lineUserId 集合（恒久 dedup）。
 * @param now 現在時刻。
 * @param thresholdDays 下限しきい値（日）。
 * @param windowDays 上限ウィンドウ（日）。
 * @param cap 1 実行の送信上限。
 */
export function selectActivationCandidates(
  users: ReadonlyArray<MarcheUser>,
  usersWithCard: ReadonlySet<string>,
  alreadyNudged: ReadonlySet<string>,
  now: Date,
  thresholdDays: number,
  windowDays: number,
  cap: number,
): ActivationCandidate[] {
  const eligible = users.filter((u) => {
    if (!u.lineUserId) return false;
    if (!isMarcheSource(u.source)) return false;
    if (usersWithCard.has(u.lineUserId)) return false; // 番号送信済み / カード到達 → ナッジしない
    if (alreadyNudged.has(u.lineUserId)) return false; // 恒久 dedup（1 人 1 回）
    const created = parseCreatedAt(u.createdAt);
    return (
      isPastActivationThreshold(created, now, thresholdDays) &&
      isWithinActivationWindow(created, now, windowDays)
    );
  });

  // createdAt 昇順（古い順＝窓の出口に近い順・より取りこぼしやすい順を優先）。null は既に除外済み。
  eligible.sort((a, b) => {
    const ta = parseCreatedAt(a.createdAt)?.getTime() ?? Infinity;
    const tb = parseCreatedAt(b.createdAt)?.getTime() ?? Infinity;
    return ta - tb;
  });

  return eligible.slice(0, Math.max(0, cap)).map((u) => ({
    lineUserId: u.lineUserId,
    createdAt: u.createdAt,
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
 * 活性化一通の集計単位名（純粋）。形式 `d{YYYYMMDD(JST)}_mact`（例: d20260719_mact）。
 * LINE 制約（半角英数字・_・最大30字）を満たす。同一 JST 日の活性化送信は 1 unit に集約される。
 */
export function marcheActivationAggregationUnit(date: Date = new Date()): string {
  return `d${jstYyyymmdd(date)}_mact`;
}

// -------------------------------------------------------------------
// オーケストレーション（DI・テストは fake を注入し純粋に保つ）
// -------------------------------------------------------------------

/** ジョブの依存（実 I/O は runtime、テストは fake を注入）。 */
export interface MarcheActivationDeps {
  now: Date;
  sendEnabled: boolean;
  thresholdDays: number;
  windowDays: number;
  perRunCap: number;
  /** marche-source lineUsers（createdAt / source）を返す（Firestore 走査）。取得不能は throw（上位 try で fail-soft）。 */
  loadMarcheUsers(): Promise<MarcheUser[]>;
  /** tea.card_view を 1 度でも持つ lineUserId 集合（flow_events・カード到達＝番号送信済み判定）。 */
  loadUsersWithCard(): Promise<Set<string>>;
  /** sent=true の line_user_id 集合（恒久 dedup・1 人 1 回）。 */
  loadAlreadyNudged(): Promise<Set<string>>;
  /** 決定行を冪等 upsert（同一 line_user_id×decision_date は 1 行）。 */
  recordDecision(input: ActivationDecisionRecord): Promise<void>;
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
 *   1. marche-source lineUsers + カード到達集合 + 既ナッジ集合を並列取得。
 *   2. 活性化候補を選定（上限クリップ）。
 *   3. 候補ごとに: 決定行を必ず記録（冪等）。
 *      - sendEnabled=false（既定）: dry-run（送らず本文を記録だけ）。
 *      - sendEnabled=true: 予算 claim → LINE push → sent 記録。予算不足は budget_blocked。
 *   候補ごとの例外は握って continue（1 件の失敗で全体を止めない）。
 *
 * @param body 送る本文（活性化ナッジは個別最適せず generic 固定。既定 = ブランド正本 MARCHE_ACTIVATION_MESSAGE）。
 */
export async function runMarcheActivationWith(
  deps: MarcheActivationDeps,
  body: string = MARCHE_ACTIVATION_MESSAGE,
): Promise<MarcheActivationResult> {
  const now = deps.now;
  const decisionDate = jstDate(now);
  const unit = marcheActivationAggregationUnit(now);

  const [users, usersWithCard, alreadyNudged] = await Promise.all([
    deps.loadMarcheUsers(),
    deps.loadUsersWithCard(),
    deps.loadAlreadyNudged(),
  ]);
  const scanned = users.length;

  const candidates = selectActivationCandidates(
    users,
    usersWithCard,
    alreadyNudged,
    now,
    deps.thresholdDays,
    deps.windowDays,
    deps.perRunCap,
  );

  const details: ActivationDetail[] = [];
  let sent = 0;
  let dryRun = 0;
  let budgetBlocked = 0;

  for (const c of candidates) {
    const masked = maskUserRef(c.lineUserId);
    try {
      // 決定は常に記録（dry-run でも観測できるように・冪等）。台帳には「送るはずだった本文」を残す。
      await deps.recordDecision({
        lineUserId: c.lineUserId,
        decisionDate,
        createdAt: c.createdAt,
        dryRun: !deps.sendEnabled,
        bodyPreview: body,
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
      await deps.sendMessage(c.lineUserId, body, unit);
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
    windowDays: deps.windowDays,
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
 * marche_activation_log の存在を確認する（preflight）。
 * 不在（migration 026 未適用）なら理由を返す。存在すれば null。
 * message-ledger.checkLedgerTables と同じく head select で軽量確認。
 */
export async function checkMarcheActivationTable(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { error } = await supabase
    .from(MARCHE_ACTIVATION_LOG_TABLE)
    .select("*", { head: true, count: "exact" });
  if (error) {
    return `required table "${MARCHE_ACTIVATION_LOG_TABLE}" is not accessible: ${error.message}${error.code ? ` (code: ${error.code})` : ""}`;
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

/** Firestore stringValue/timestampValue のどちらかを ISO 文字列として拾う（無ければ null）。 */
function readTimestampField(
  field: { stringValue?: string; timestampValue?: string } | undefined,
): string | null {
  if (typeof field?.stringValue === "string") return field.stringValue;
  if (typeof field?.timestampValue === "string") return field.timestampValue;
  return null;
}

/**
 * Firestore: lineUsers を全件走査し、marche-source のユーザーだけを {createdAt, source} 付きで返す。
 * where フィルタは使わず全件走査（buildCollectionListQuery の注記参照・対象は友だち数十人で軽量）。
 * onboarding.source は mapValue のネストから読む。marche 以外はここで落とす（候補集合を最小化）。
 */
async function loadAllMarcheUsers(fsEnv: FirestoreEnv): Promise<MarcheUser[]> {
  const accessToken = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
  const PAGE = 300;

  const all = await collectAllPages<MarcheUser>(async (cursor) => {
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

    const items: MarcheUser[] = [];
    let lastName: string | undefined;
    let count = 0;
    for (const entry of rows) {
      if (!entry.document?.name) continue;
      count++;
      lastName = entry.document.name;
      const fields = entry.document.fields;
      const lineUserId = entry.document.name.split("/").pop() ?? "";
      if (!lineUserId) continue;

      const createdAt = readTimestampField(
        fields?.createdAt as { stringValue?: string; timestampValue?: string } | undefined,
      );
      // onboarding は mapValue。source は onboarding.mapValue.fields.source.stringValue。
      const onboarding = fields?.onboarding as
        | { mapValue?: { fields?: Record<string, { stringValue?: string }> } }
        | undefined;
      const source =
        typeof onboarding?.mapValue?.fields?.source?.stringValue === "string"
          ? onboarding.mapValue.fields.source.stringValue
          : null;

      items.push({ lineUserId, createdAt, source });
    }
    const nextCursor = count >= PAGE ? lastName : undefined;
    return { items, nextCursor };
  });

  // marche-source のみに絞る（純粋 selectActivationCandidates でも再判定するが、ここで候補集合を最小化）。
  return all.filter((u) => isMarcheSource(u.source));
}

/** LINE push（活性化一通・実送信経路のみ）。customAggregationUnits を付与して将来 insight を可能にする。 */
async function pushActivationMessage(
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
 * マルシェ活性化ナッジ ジョブ本体（runtime 配線）。実送信は sendEnabled のときだけ。
 *
 * deps 省略時は env から実 Supabase / Firestore / LINE（配信 OA トークン）を組み立てる。
 * fail-soft: 実行時例外は throw せず ok:false（理由付き）に倒す（cron 経路で未処理 reject を残さない）。
 */
export async function runMarcheActivation(
  env: Env,
  overrides?: Partial<MarcheActivationDeps>,
): Promise<MarcheActivationResult> {
  const now = overrides?.now ?? new Date();
  const sendEnabled = overrides?.sendEnabled ?? env.MARCHE_SEND_ENABLED === "true";
  const thresholdDays =
    overrides?.thresholdDays ??
    parsePositiveInt(env.MARCHE_ACTIVATION_THRESHOLD_DAYS, DEFAULT_ACTIVATION_THRESHOLD_DAYS);
  const windowDays =
    overrides?.windowDays ??
    parsePositiveInt(env.MARCHE_ACTIVATION_WINDOW_DAYS, DEFAULT_ACTIVATION_WINDOW_DAYS);
  const perRunCap =
    overrides?.perRunCap ??
    parsePositiveInt(env.MARCHE_ACTIVATION_PER_RUN_CAP, DEFAULT_PER_RUN_CAP);

  const base = {
    sendEnabled,
    thresholdDays,
    windowDays,
    perRunCap,
    scanned: 0,
    candidates: 0,
    sent: 0,
    dryRun: 0,
    budgetBlocked: 0,
    details: [] as ActivationDetail[],
  };

  try {
    // supabase は env 由来（ユニットテストは runMarcheActivationWith に fake port を注入し、この経路を通らない）。
    const sb = createSupabaseClient(env);

    // preflight（不在を早期に検知できたときだけ即返す・fast-path）。
    const preflight = await checkMarcheActivationTable(sb);
    if (preflight) {
      return {
        ok: false,
        reason: `preflight 失敗（migration 026 未適用の可能性）: ${preflight}`,
        ...base,
      };
    }

    // 配信 OA トークン（送信・予算 consumption 照合に使う）。dry-run でも consumption GET は使わないため
    // 未設定でも dry-run は成立する。sendEnabled のときだけ厳密に必要（fail-closed）。
    let channelToken = "";
    try {
      channelToken = resolveDeliveryChannel(env).accessToken;
    } catch {
      if (sendEnabled) {
        return {
          ok: false,
          reason: "配信チャネル未解決（MARCHE_SEND_ENABLED=true だが送信 OA トークン未設定・fail-closed）",
          ...base,
        };
      }
    }

    const ledgerStore = createSupabaseLedgerStore(sb);
    const consumptionFetcher = createLineConsumptionFetcher({
      LINE_CHANNEL_ACCESS_TOKEN: channelToken,
    } as Env);

    const deps: MarcheActivationDeps = {
      now,
      sendEnabled,
      thresholdDays,
      windowDays,
      perRunCap,
      loadMarcheUsers:
        overrides?.loadMarcheUsers ??
        (async () => loadAllMarcheUsers(getFirestoreEnv(env))),
      // カード到達（番号送信済み）集合: flow_events の tea.card_view を持つ user_ref を全件読む（read-only）。
      loadUsersWithCard:
        overrides?.loadUsersWithCard ??
        (async () => {
          const { data, error } = await sb
            .from(FLOW_EVENTS_TABLE)
            .select("user_ref")
            .eq("event_name", TEA_CARD_VIEW_EVENT);
          if (error) {
            throw new Error(`${FLOW_EVENTS_TABLE} カード到達集合取得失敗: ${error.message}`);
          }
          return new Set((data ?? []).map((r: { user_ref: string }) => r.user_ref));
        }),
      // 恒久 dedup: sent=true（実送信済み）の line_user_id を除外集合として読む（1 人 1 回・再送間隔なし）。
      loadAlreadyNudged:
        overrides?.loadAlreadyNudged ??
        (async () => {
          const { data, error } = await sb
            .from(MARCHE_ACTIVATION_LOG_TABLE)
            .select("line_user_id")
            .eq("sent", true);
          if (error) {
            throw new Error(`${MARCHE_ACTIVATION_LOG_TABLE} dedup 集合取得失敗: ${error.message}`);
          }
          return new Set(
            (data ?? []).map((r: { line_user_id: string }) => r.line_user_id),
          );
        }),
      recordDecision:
        overrides?.recordDecision ??
        (async (input) => {
          const { error } = await sb.from(MARCHE_ACTIVATION_LOG_TABLE).upsert(
            {
              line_user_id: input.lineUserId,
              decision_date: input.decisionDate,
              user_created_at: input.createdAt,
              sent: false,
              sent_at: null,
              dry_run: input.dryRun,
              body_preview: input.bodyPreview,
              aggregation_unit: input.aggregationUnit,
            },
            { onConflict: "line_user_id,decision_date", ignoreDuplicates: true },
          );
          if (error) {
            throw new Error(`${MARCHE_ACTIVATION_LOG_TABLE} 決定記録失敗: ${error.message}`);
          }
        }),
      claimBudget:
        overrides?.claimBudget ??
        (async (lineUserId, unit) => {
          const decision = await guardAndClaim(ledgerStore, consumptionFetcher, {
            notionPageId: `marche_activate_${lineUserId}`,
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
          await pushActivationMessage(channelToken, lineUserId, body, unit);
        }),
      markSent:
        overrides?.markSent ??
        (async (lineUserId, decisionDate, sentAt) => {
          const { error } = await sb
            .from(MARCHE_ACTIVATION_LOG_TABLE)
            .update({ sent: true, sent_at: sentAt })
            .eq("line_user_id", lineUserId)
            .eq("decision_date", decisionDate);
          if (error) {
            throw new Error(`${MARCHE_ACTIVATION_LOG_TABLE} sent 記録失敗: ${error.message}`);
          }
        }),
    };

    return await runMarcheActivationWith(deps);
  } catch (err) {
    // fail-soft: テーブル不在（migration 未適用）・Firebase 未設定・一時的な DB エラー等は throw せず ok:false。
    return {
      ok: false,
      reason: `マルシェ活性化実行時エラー（fail-soft）: ${err instanceof Error ? err.message : String(err)}`,
      ...base,
    };
  }
}
