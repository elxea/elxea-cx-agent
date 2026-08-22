/**
 * 配信 runtime 配線（T8/T9 の実 I/O 束ね）。
 *
 * 実アダプタ（Notion / Supabase / Firestore / LINE チャネル）を構築し、
 * オーケストレータ（delivery-orchestrator.ts）を駆動する `runDelivery` を提供する。
 *
 * ⚠ 実送信の前提（2026-08-22 変更: 実送信スイッチ撤去）:
 *   - 以前あった env フラグ DELIVERY_SEND_ENABLED は **廃止した**。承認済み・予定時刻到来の行は
 *     staging / 本番のどちらでも常に実送信される（「承認したら送られる」が唯一の判断点）。
 *   - 送信可否を握る安全弁は次の多層ガードのみ:
 *       (1) Notion Status=Approved かつ独立した承認者がいる（自己承認は fail-closed）
 *       (2) 配信予定日時が存在し時刻付きで、かつ到来している
 *       (3) 承認時コンテンツハッシュ（pin）と現在値が一致する（承認後の編集は自動リセット）
 *       (4) 通数台帳 claim（月内の二重送信を排他）+ 無料枠ガード
 *       (5) 宛先解決（allowlist 未設定・ペルソナ 0 件などは fail-closed）
 *   - 送信先 OA は DELIVERY_TARGET_ENV で決まる（本番 Worker=prod OA / staging Worker=test OA）。
 *   - 緊急停止は docs/deploy-runbook.md「配信を止める」節を参照（個別=Approved→Draft /
 *     全体=15分 cron トリガの停止）。
 */

import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";
import {
  getFirestoreEnv,
  getAccessToken,
  firestoreBaseUrl,
  buildPersonaPrimaryEqualQuery,
  LINE_USERS_COLLECTION,
  type FirestoreEnv,
  type PersonaType,
} from "./firestore";
import {
  createSupabaseLedgerStore,
  createLineConsumptionFetcher,
  checkLedgerTables,
  currentLineMonth,
  LEDGER_TABLE,
} from "./message-ledger";
import {
  createNotionRequest,
  queryDueDeliveries,
  querySendingDeliveries,
  setStatus,
  writeDeliveryResult,
  resetApproval,
  clearDeliveryError,
  pinApproval,
  fetchDeliveryPage,
  resolveDeliveryDbId,
  DeliveryDbConfigError,
} from "./delivery-repository";
import { computeContentHash } from "./content-hash";
import {
  ingestPageImages,
  describeBlockingImages,
  resolveR2Config,
  resolveR2PublicBase,
  r2UrlsForPage,
} from "./image-ingest";
import { isApprovalAuthorized, selfApprovalRelaxed } from "./delivery-approval";
import { resolveDeliveryChannel } from "./delivery-channel";
import { createLineSender } from "./line-messages";
import {
  resolveTargets,
  collectAllPages,
  parseAllowlist,
  type LinkageRow,
  type PersonaRow,
  type LineUserPersonaRow,
  type TargetResolverDeps,
} from "./target-resolver";
import {
  runDeliveryOnce,
  type OrchestratorDeps,
  type DeliveryRunResult,
} from "./delivery-orchestrator";
import type { AudienceSpec } from "./delivery-audience";

const VALID_PERSONAS: PersonaType[] = ["serenity", "explorer", "sensory"];

/** LINE consumption を「解決済みチャネルのトークン」で読む fetcher。 */
function consumptionFetcherForToken(accessToken: string) {
  // message-ledger の createLineConsumptionFetcher は env.LINE_CHANNEL_ACCESS_TOKEN 固定のため、
  // 2 環境対応として一時 env でトークンだけ差し替える。
  return createLineConsumptionFetcher({
    LINE_CHANNEL_ACCESS_TOKEN: accessToken,
  } as Env);
}

/** Supabase: customer_linkages を除外フラグ込みで全件取得（migration 020 の列に依存）。 */
async function loadLinkages(env: Env): Promise<LinkageRow[]> {
  const supabase = createSupabaseClient(env);
  const { data, error } = await supabase
    .from("customer_linkages")
    .select("shopify_customer_id, line_user_id, unfollowed_at, broadcast_opted_out")
    .not("line_user_id", "is", null);
  if (error) {
    throw new Error(`customer_linkages 取得失敗: ${error.message}`);
  }
  return (data ?? []).map(
    (r: {
      shopify_customer_id: string | null;
      line_user_id: string | null;
      unfollowed_at: string | null;
      broadcast_opted_out: boolean | null;
    }) => ({
      shopifyCustomerId: String(r.shopify_customer_id ?? ""),
      lineUserId: r.line_user_id,
      unfollowed: r.unfollowed_at != null,
      optedOut: r.broadcast_opted_out === true,
    }),
  );
}

/**
 * Firestore: persona.primary == targetPersona のユーザーを cursor ページングで全件取得（連携済み users）。
 *
 * ブロック1 修正（2026-07-16・ライブ E2E で実証）: 旧 `persona.primary != null`（NOT_EQUAL null）は
 * Firestore 仕様でフィールド欠落行も除外し、ライブで常に 0 件になった。よって対象ペルソナごとの
 * EQUAL クエリ（buildPersonaPrimaryEqualQuery）に変更する。呼び出し側（resolveTargets）は
 * audience.persona を渡す（横断が要る箇所は EQUAL×3 の和で合成する）。
 */
async function loadPersonaUsers(
  fsEnv: FirestoreEnv,
  targetPersona: PersonaType,
): Promise<PersonaRow[]> {
  const accessToken = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
  const PAGE = 300;

  return collectAllPages<PersonaRow>(async (cursor) => {
    const structuredQuery = buildPersonaPrimaryEqualQuery("users", targetPersona, {
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
      throw new Error(`Firestore runQuery 失敗 (${res.status}): ${await res.text()}`);
    }
    const rows = (await res.json()) as Array<{
      document?: { name: string; fields?: Record<string, Record<string, unknown>> };
    }>;

    const items: PersonaRow[] = [];
    let lastName: string | undefined;
    let count = 0;
    for (const entry of rows) {
      if (!entry.document?.name) continue;
      count++;
      lastName = entry.document.name;
      const fields = entry.document.fields;
      const personaMap = fields?.persona as
        | { mapValue?: { fields?: Record<string, Record<string, unknown>> } }
        | undefined;
      const primary = personaMap?.mapValue?.fields?.primary as
        | { stringValue?: string }
        | undefined;
      const persona = primary?.stringValue as PersonaType | undefined;
      if (!persona || !VALID_PERSONAS.includes(persona)) continue;
      const shopifyId = entry.document.name.split("/").pop() ?? "";
      items.push({ shopifyCustomerId: shopifyId, persona });
    }
    // 次ページ cursor: 取得件数が PAGE 未満なら終了。
    const nextCursor = count >= PAGE ? lastName : undefined;
    return { items, nextCursor };
  });
}

/**
 * Firestore: lineUsers/{lineUserId}.persona.primary == targetPersona を cursor ページングで全件取得（ブロック1・直読み）。
 * ドキュメント ID がそのまま Messaging API userId（webhook 由来）なので multicast の宛先にそのまま使える。
 * loadPersonaUsers（users コレクション）と同一パターンだが、対象コレクションと返す ID が異なる。
 *
 * ブロック1 修正（2026-07-16・ライブ E2E で実証）: 旧 NOT_EQUAL null はフィールド欠落行を除外し常に 0 件だった。
 * EQUAL クエリ（buildPersonaPrimaryEqualQuery）へ変更し、対象ペルソナを引数で受ける。
 */
async function loadPersonaLineUsers(
  fsEnv: FirestoreEnv,
  targetPersona: PersonaType,
): Promise<LineUserPersonaRow[]> {
  const accessToken = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
  const PAGE = 300;

  return collectAllPages<LineUserPersonaRow>(async (cursor) => {
    const structuredQuery = buildPersonaPrimaryEqualQuery(
      LINE_USERS_COLLECTION,
      targetPersona,
      { limit: PAGE, startAfterName: cursor },
    );

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
        `Firestore runQuery (lineUsers) 失敗 (${res.status}): ${await res.text()}`,
      );
    }
    const rows = (await res.json()) as Array<{
      document?: { name: string; fields?: Record<string, Record<string, unknown>> };
    }>;

    const items: LineUserPersonaRow[] = [];
    let lastName: string | undefined;
    let count = 0;
    for (const entry of rows) {
      if (!entry.document?.name) continue;
      count++;
      lastName = entry.document.name;
      const fields = entry.document.fields;
      const personaMap = fields?.persona as
        | { mapValue?: { fields?: Record<string, Record<string, unknown>> } }
        | undefined;
      const primary = personaMap?.mapValue?.fields?.primary as
        | { stringValue?: string }
        | undefined;
      const persona = primary?.stringValue as PersonaType | undefined;
      if (!persona || !VALID_PERSONAS.includes(persona)) continue;
      const lineUserId = entry.document.name.split("/").pop() ?? "";
      if (!lineUserId) continue;
      items.push({ lineUserId, persona });
    }
    const nextCursor = count >= PAGE ? lastName : undefined;
    return { items, nextCursor };
  });
}

/** 承認 pin の結果。 */
export type PinApprovalResult =
  | { ok: true; contentHash: string }
  | { ok: false; reason: string };

/**
 * 承認時のコンテンツ pinning（T12）を実行する。
 * ページの現在値を読み、必須項目（本文 or 画像）+ 自己承認（承認者!=著者）を検証し、
 * files「画像」を R2 に取込（Notion 一時URL → R2 恒久URL）してから、その恒久R2 URL 群で
 * ハッシュを計算し保存して Status=Approved にする。実送信はしない。
 *
 * 形式は自動判定（画像ありなら image / 無ければ text）。運用者は「形式」を触らない。
 */
export async function pinDeliveryApproval(
  env: Env,
  pageId: string,
): Promise<PinApprovalResult> {
  const request = createNotionRequest(env);
  const page = await fetchDeliveryPage(request, pageId);

  // 形式は normalize が files「画像」の有無で自動判定済み。
  if (page.format !== "text" && page.format !== "image") {
    return { ok: false, reason: "形式が未設定/未知" };
  }
  // 本文か画像のどちらかは必須（text は本文、image は画像枚数）。
  const srcUrls = page.imageSourceUrls ?? [];
  if (page.format === "text" && !(page.body ?? "").trim()) {
    return { ok: false, reason: "本文が空（本文か画像のどちらかが必須）" };
  }
  if (page.format === "image" && srcUrls.length === 0) {
    return { ok: false, reason: "画像が空（画像をドラッグしてください）" };
  }
  if (
    !isApprovalAuthorized(
      page.assignees,
      page.approvers,
      selfApprovalRelaxed(env),
    )
  ) {
    return { ok: false, reason: "独立した承認者がいない（自己承認・fail-closed）" };
  }

  // 画像取込（承認 pin 時に実行）: Notion 一時URL → R2 → 恒久公開URL。
  // これでコンテンツを「凍結」し、送信は R2 スナップショットを参照する（TOCTOU 対策）。
  let r2Urls: string[] = [];
  if (srcUrls.length > 0) {
    let cfg;
    try {
      cfg = resolveR2Config(env);
    } catch (err) {
      return {
        ok: false,
        reason: `画像アップロード設定不備: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const ingest = await ingestPageImages(cfg, pageId, srcUrls);
    r2Urls = ingest.urls;
    if (ingest.warnings.length > 0) {
      console.warn(
        `[delivery:pin] page=${pageId} image warnings: ${ingest.warnings.join("; ")}`,
      );
    }
    // fail-closed: LINE 非対応形式（HEIC 等）・非画像・10MB超は承認を通さない。
    // 平易な日本語の理由を返し、呼び出し側（poll / approve API）が運用者へ提示する。
    // これで「壊れた画像が LINE に届く前に」止める（正規化本体は v2）。
    if (ingest.blocking.length > 0) {
      return { ok: false, reason: describeBlockingImages(ingest.blocking) };
    }
  }

  // ハッシュは恒久R2 URL 群で計算（送信時は imageCount から同じ URL 群を決定的に再構成し照合）。
  const contentHash = await computeContentHash({
    format: page.format,
    body: page.body,
    imageUrls: r2Urls,
  });
  await pinApproval(request, pageId, contentHash);
  return { ok: true, contentHash };
}

/**
 * 配信を 1 巡実行する（runtime 配線）。
 * 承認済み・予定時刻到来・pin 一致・通数ガード通過の行を実送信する
 * （env の実送信スイッチは 2026-08-22 に廃止済み）。
 */
export async function runDelivery(env: Env): Promise<DeliveryRunResult> {
  const supabase = createSupabaseClient(env);

  // preflight: 台帳テーブル必須（不在なら送信経路に載せない）。
  const ledgerErr = await checkLedgerTables(supabase);
  if (ledgerErr) {
    return {
      scanned: 0,
      processed: [
        {
          pageId: "-",
          title: "-",
          audience: null,
          disposition: "failed",
          reason: `preflight 失敗: ${ledgerErr}`,
          recipients: 0,
        },
      ],
      reaper: [],
    };
  }

  const channel = resolveDeliveryChannel(env); // token 未設定は throw（fail-closed）
  // env 分離: prod ワーカーは prod DB、test/staging ワーカーは専用 test DB のみ読む。
  // 誤配線（共有 DB / cross-env）は送信前に fail-closed で塞ぐ（preflight 失敗として返す）。
  let dbId: string;
  try {
    dbId = resolveDeliveryDbId(env);
  } catch (e) {
    if (e instanceof DeliveryDbConfigError) {
      return {
        scanned: 0,
        processed: [
          {
            pageId: "-",
            title: "-",
            audience: null,
            disposition: "failed",
            reason: `配信 DB 解決 fail-closed: ${e.message}`,
            recipients: 0,
          },
        ],
        reaper: [],
      };
    }
    throw e;
  }
  const request = createNotionRequest(env);

  // Firestore env（ペルソナ配信で必要。全員配信のみなら未設定でも動く）。
  let fsEnv: FirestoreEnv | null = null;
  try {
    fsEnv = getFirestoreEnv(env);
  } catch {
    fsEnv = null;
  }

  const targetDeps: TargetResolverDeps = {
    loadLinkages: () => loadLinkages(env),
    loadPersonaUsers: async (persona) => {
      if (!fsEnv) throw new Error("Firestore 未設定のためペルソナ対象を解決できない");
      return loadPersonaUsers(fsEnv, persona);
    },
    // ブロック1: lineUsers 直読み（未連携ユーザーのペルソナ）を宛先解決の和集合に加える。
    loadPersonaLineUsers: async (persona) => {
      if (!fsEnv) throw new Error("Firestore 未設定のため lineUsers 直読みができない");
      return loadPersonaLineUsers(fsEnv, persona);
    },
    broadcastEstimate: async () => channel.estimatedFriendCount,
    // 社内 allowlist は env が唯一の供給元（PII 非記載）。空/未設定は resolveTargets が fail-closed。
    loadAllowlistUserIds: async () => parseAllowlist(env.LINE_INTERNAL_USER_IDS),
  };

  const ledger = createSupabaseLedgerStore(supabase);

  // 送信側の恒久R2 URL 再構成には公開ベースのみ必要（R2 token 不要）。
  // pin 時に broadcast/<pageId>/<index>.jpg へ put 済みなので、枚数から決定的に URL を組める。
  const r2Base = resolveR2PublicBase(env);
  const withR2Urls = <T extends { id: string; imageCount: number }>(p: T): T => ({
    ...p,
    imageUrls: r2UrlsForPage(p.id, p.imageCount ?? 0, r2Base),
  });

  const deps: OrchestratorDeps = {
    repo: {
      queryDue: async (nowIso) =>
        (await queryDueDeliveries(request, nowIso, dbId)).map(withR2Urls),
      querySending: async () =>
        (await querySendingDeliveries(request, dbId)).map(withR2Urls),
      setStatus: (pageId, status) => setStatus(request, pageId, status),
      writeResult: (pageId, result) => writeDeliveryResult(request, pageId, result),
      resetApproval: (pageId, reason) => resetApproval(request, pageId, reason),
    },
    ledger,
    consumption: consumptionFetcherForToken(channel.accessToken),
    ledgerHasClaim: async (notionPageId, month) => {
      const { data, error } = await supabase
        .from(LEDGER_TABLE)
        .select("id")
        .eq("notion_page_id", notionPageId)
        .eq("month", month)
        .limit(1);
      if (error) throw new Error(`ledger hasClaim 失敗: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    resolveTargets: (audience: AudienceSpec) => resolveTargets(audience, targetDeps),
    // 実送信スイッチ撤去（2026-08-22）: 常に実 sender を配線する。
    // 送信先 OA は resolveDeliveryChannel が env（DELIVERY_TARGET_ENV）から決める
    // （本番 Worker=本番 OA / staging Worker=テスト OA）。
    sender: createLineSender(channel),
    now: () => new Date(),
    // テスト環境限定の自己承認緩和（prod では selfApprovalRelaxed が常に false）。
    allowSelfApproval: selfApprovalRelaxed(env),
    // 順序付き画像URL群（恒久HTTPS・env が唯一の供給元）。orchestrator は audience が
    // allowlist(社内) または all(全員=broadcast) のときだけ本文に続けて image N を組む
    // （persona には注入しない。Notion 複数画像UIの本実装 v2 までの暫定）。
    testImageUrls: parseAllowlist(env.DELIVERY_TEST_IMAGE_URLS),
  };

  const result = await runDeliveryOnce(deps);
  // 可観測性（実送信スイッチ撤去後の唯一の実績ログ）: 「実送信したか / 何通 / どの行が何故落ちたか」を
  // 1 行で追えるようにする。以前は sendEnabled= を見て dry-run/実送信を判別していたため、
  // 撤去に伴い disposition 別内訳と実送信通数（recipients 合計）をログに載せる。
  const count = (d: string) =>
    result.processed.filter((p) => p.disposition === d).length;
  const delivered = result.processed
    .filter((p) => p.disposition === "sent")
    .reduce((sum, p) => sum + p.recipients, 0);
  console.log(
    `[delivery] env=${channel.label} month=${currentLineMonth()} ` +
      `scanned=${result.scanned} processed=${result.processed.length} ` +
      `sent=${count("sent")} recipients=${delivered} skipped=${count("skipped")} ` +
      `reset=${count("reset")} failed=${count("failed")} reaper=${result.reaper.length}`,
  );
  // 実送信した行は個別にも残す（PII 非記載: pageId / タイトル / 対象種別 / 通数のみ）。
  for (const p of result.processed) {
    if (p.disposition === "sent" || p.disposition === "failed") {
      console.log(
        `[delivery] ${p.disposition} page=${p.pageId} audience=${p.audience ?? "-"} ` +
          `recipients=${p.recipients} reason=${p.reason}`,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 承認 → 自動配信 の配線（cron ポーリング方式）
// ---------------------------------------------------------------------------
//
// QA 指摘①: 運用者が Notion で Status=Approved にしても、承認 pin（画像R2化・
//   ハッシュ凍結）は別 API（POST /api/delivery/approve）を叩かないと起きず、
//   ハッシュ未設定のまま runDelivery に載ると承認リセットされ「自動で始まらない」。
//
// 対処: cron（15分毎）が Approved & 予定日時<=now & 未送信 の行を拾い、
//   まだ pin されていなければ pinDeliveryApproval で凍結してから runDelivery に渡す。
//   → 運用者は「Notion で Status を Approved にするだけ」で完結する（手動 API 不要）。
//
// 冪等・安全:
//   - 既に pin 済み（コンテンツハッシュあり）の行は pin を skip（二重 pin しない）。
//   - pin 失敗（HEIC 等の LINE 非対応形式 / R2 未設定 / 自己承認）は fail-closed で
//     resetApproval（Status を Draft に戻し、平易な日本語をエラー詳細へ）。
//     → 承認を通さないので runDelivery の対象からも外れる（壊れた配信を出さない）。
//   - 本 poll は「拾って承認 pin まで」を担い、送信可否は一切変えない。
//     送信可否は runDelivery 側の多層ガード（承認者独立性・予定日時・ハッシュ照合・通数台帳）が握る。

/** 承認 pin 前処理（phase 1）の注入依存（テストは fake、runtime は実 I/O を配線）。 */
export interface ScheduledPinDeps {
  /** Approved & 予定日時<=nowIso & 未送信 の行（id と contentHash だけ見る）。 */
  queryDue(nowIso: string): Promise<Array<{ id: string; contentHash: string | null }>>;
  /** 承認 pin（画像R2化・ハッシュ凍結）。既存 pinDeliveryApproval を配線。 */
  pin(pageId: string): Promise<PinApprovalResult>;
  /** pin 失敗時の fail-closed（Draft 戻し + エラー詳細書込）。 */
  resetApproval(pageId: string, reason: string): Promise<void>;
  /** pin 成功時の後始末（過去の失敗メッセージを消す）。 */
  clearError(pageId: string): Promise<void>;
  now(): Date;
}

/** phase 1（pin 前処理）の 1 行あたり結果。 */
export interface PinPassOutcome {
  pageId: string;
  action: "pinned" | "already_pinned" | "reset_failed";
  reason?: string;
}

/** cron ポーリング 1 巡の結果（pin 前処理 + 本処理）。 */
export interface ScheduledDeliveryResult {
  pinPass: PinPassOutcome[];
  run: DeliveryRunResult;
}

/** phase 1（pin 前処理）の全注入依存 + 本処理ランナー。 */
export interface ScheduledDeliveryDeps extends ScheduledPinDeps {
  run(): Promise<DeliveryRunResult>;
}

/**
 * phase 1: Approved & due & 未送信 のうち未 pin 行を承認 pin する（純粋・注入依存）。
 * queryDue が失敗したら空を返し、本処理（runDelivery）側の fail-closed に委ねる。
 */
export async function pinDueApprovals(
  deps: ScheduledPinDeps,
): Promise<PinPassOutcome[]> {
  const nowIso = deps.now().toISOString();
  let due: Array<{ id: string; contentHash: string | null }>;
  try {
    due = await deps.queryDue(nowIso);
  } catch {
    return [];
  }

  const out: PinPassOutcome[] = [];
  for (const page of due) {
    // 既に pin 済み（ハッシュあり）は skip（二重 pin 回避）。
    if (page.contentHash) {
      out.push({ pageId: page.id, action: "already_pinned" });
      continue;
    }
    let res: PinApprovalResult;
    try {
      res = await deps.pin(page.id);
    } catch (err) {
      res = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) {
      // 成功: 過去の失敗メッセージを消す（承認済み行に赤字を残さない）。
      await deps.clearError(page.id).catch(() => {});
      out.push({ pageId: page.id, action: "pinned" });
    } else {
      // 失敗: fail-closed。承認を通さず Draft に戻し、平易な理由をエラー詳細へ。
      await deps.resetApproval(page.id, res.reason).catch(() => {});
      out.push({ pageId: page.id, action: "reset_failed", reason: res.reason });
    }
  }
  return out;
}

/**
 * cron ポーリング 1 巡（注入版）。phase 1（pin 前処理）→ phase 2（runDelivery）を
 * この順で直列実行する。テストは fake deps で pin→run 順・fail-closed を検証する。
 */
export async function runScheduledDeliveryWith(
  deps: ScheduledDeliveryDeps,
): Promise<ScheduledDeliveryResult> {
  const pinPass = await pinDueApprovals(deps);
  const run = await deps.run();
  return { pinPass, run };
}

/**
 * cron ポーリング 1 巡（runtime 配線）。
 * scheduled ハンドラ（15分毎 cron）と手動 run API から呼ぶ。本関数は送信可否を変えない
 * （送信可否は runDelivery の多層ガードが握る）。
 */
export async function runScheduledDelivery(
  env: Env,
): Promise<ScheduledDeliveryResult> {
  const request = createNotionRequest(env);
  // env 分離 + fail-closed。解決不能な env（例: 専用 test DB 未設定の staging）では
  // due 取得を空にし pin/送信を一切行わない（run() 側の runDelivery も同じく fail-closed）。
  let dbId: string | null;
  try {
    dbId = resolveDeliveryDbId(env);
  } catch (e) {
    if (!(e instanceof DeliveryDbConfigError)) throw e;
    dbId = null;
  }
  return runScheduledDeliveryWith({
    queryDue: async (nowIso) => {
      if (dbId === null) return [];
      const pages = await queryDueDeliveries(request, nowIso, dbId);
      return pages.map((p) => ({ id: p.id, contentHash: p.contentHash }));
    },
    pin: (pageId) => pinDeliveryApproval(env, pageId),
    resetApproval: (pageId, reason) => resetApproval(request, pageId, reason),
    clearError: (pageId) => clearDeliveryError(request, pageId),
    now: () => new Date(),
    run: () => runDelivery(env),
  });
}
