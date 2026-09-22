/**
 * 配信 runtime 配線（T8/T9 の実 I/O 束ね）。
 *
 * 実アダプタ（Notion / Supabase / Firestore / LINE チャネル）を構築し、
 * 1 件指定送信（delivery-send-one.ts）を駆動する `runSendOneDelivery` と、
 * 承認 pin（`pinDeliveryApproval`）を提供する。
 *
 * ⚠ 実送信の前提（2026-08-22 変更: 実送信スイッチ撤去 → さらに完全オンデマンド化）:
 *   - 以前あった env フラグ DELIVERY_SEND_ENABLED は **廃止した**。
 *   - **cron による自動配信も廃止した**。配信が走るのは `POST /api/delivery/send-one` を
 *     明示的に叩いたときだけ（「承認しただけでは送られない・回したら送られる」）。
 *   - **配信予定日時は送信条件ではなくなった**（Approved なら予定日時が未来でも空でも送る）。
 *     予定日時は運用者の記録用メモとして残るだけ。
 *   - 送信可否を握る安全弁は次の多層ガードのみ:
 *       (1) Notion Status=Approved かつ独立した承認者がいる（自己承認は fail-closed）
 *       (2) 承認時コンテンツハッシュ（pin）と現在値が一致する（承認後の編集は自動リセット）
 *       (3) 通数台帳 claim（月内の二重送信を排他）+ 無料枠ガード
 *       (4) 宛先解決（allowlist 未設定・ペルソナ 0 件などは fail-closed）
 *       (5) 送信済み（送信済みチェックボックス）の行は対象外
 *   - 送信先 OA は DELIVERY_TARGET_ENV で決まる（本番 Worker=prod OA / staging Worker=test OA）。
 *   - 止め方は docs/deploy-runbook.md「配信を止める」節を参照（送りたくない行は Approved→Draft。
 *     そもそも run を叩かなければ何も送られない）。
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
  setStatus,
  writeDeliveryResult,
  resetApproval,
  clearDeliveryError,
  pinApproval,
  fetchDeliveryPage,
  fetchApprovalTask,
  fetchNotionUserEmail,
  resolveDeliveryDbId,
  writeDeliveryError,
  DeliveryDbConfigError,
  NotionHttpError,
  isRetryableNotionStatus,
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
import {
  createLineFollowerPageFetcher,
  resolveBroadcastRecipientEstimate,
  type FriendCountBasis,
} from "./line-audience-size";
import {
  createLineSender,
  chunkForMulticast,
  MULTICAST_MAX_RECIPIENTS,
} from "./line-messages";
import {
  resolveTargets,
  collectAllPages,
  parseAllowlist,
  type LinkageRow,
  type PersonaRow,
  type LineUserPersonaRow,
  type ResolvedTargets,
  type TargetResolverDeps,
} from "./target-resolver";
import {
  compareTargets,
  resolveCdpSegmentTargets,
  resolveSegmentMode,
  type SegmentAgreement,
} from "./cdp/segment-resolver";
import {
  sendOneDelivery,
  type SendOneDeps,
  type SendOneRequest,
  type SendOneResponse,
  type SendReservationPort,
  type ReservationClaim,
} from "./delivery-send-one";
import {
  RetryableApprovalError,
  type ApprovalTaskPort,
} from "./delivery-approval-task";
import {
  audienceFingerprintKey,
  parseAudience,
  type AudienceSpec,
} from "./delivery-audience";

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

// ---------------------------------------------------------------------------
// CDP 統合 Stage 4: 宛先解決の並走（旧 3 本 ↔ 新 SQL 1 本）
// ---------------------------------------------------------------------------
//
// ─ いまここに何本あるか（T-11）─
//   上の loadLinkages / loadPersonaUsers / loadPersonaLineUsers が「全件スキャン 3 本」
//   の実体である。3 本あるのは同じ人の記録が 3 つの棚に分かれているからで、
//   置き換え先は L1 への SQL 1 本（migration 046 の cdp_segment_line_targets）。
//
// ─ Stage 4 では消さない ─
//   設計 §6-1 Stage 4 の完了条件は「配信対象が新旧で一致」。一致を **観測してから**
//   切り替える（撤去は Stage 5 / T-11）。よって既定は shadow で、旧が決めたまま
//   新も引いて食い違いを数える。切替は env CDP_SEGMENT_MODE=cdp。
//
// ─ 全員配信・社内 allowlist は対象外 ─
//   broadcast（受信者 ID 不要）と allowlist（env が唯一の供給元）はそもそも棚を
//   引かないので、置き換える対象が無い。ペルソナ配信だけを並走させる。

/** ペルソナ配信の宛先を、モードに従って解決する（shadow は旧が決める）。 */
export async function resolveTargetsWithCdp(
  env: Env,
  supabase: ReturnType<typeof createSupabaseClient>,
  audience: AudienceSpec,
  targetDeps: TargetResolverDeps,
): Promise<ResolvedTargets> {
  const mode = resolveSegmentMode(env.CDP_SEGMENT_MODE);
  if (audience.kind !== "persona" || mode === "off") {
    return resolveTargets(audience, targetDeps);
  }

  if (mode === "cdp") {
    // 切替後。新が引けなかったら **送らない**（旧に黙って落ちると「切り替えたつもりで
    // 旧のまま」が起きて、切替の是非を誰も判断できなくなる）。
    const cdp = await resolveCdpSegmentTargets(supabase, audience.persona);
    if (!cdp.ok) {
      return { kind: "error", reason: `CDP 宛先解決に失敗（fail-closed）: ${cdp.reason}` };
    }
    if (cdp.truncated) {
      return { kind: "error", reason: "CDP 宛先が上限で切れた（fail-closed。黙って削らない）" };
    }
    if (cdp.userIds.length === 0) {
      return { kind: "error", reason: "対象ユーザーが 0 件（除外後・CDP）" };
    }
    console.log(
      `[cdp/segment] mode=cdp persona=${audience.persona} recipients=${cdp.userIds.length} ` +
        `excluded=${JSON.stringify(cdp.excluded)}`,
    );
    const userIds = cdp.userIds;
    return {
      kind: "multicast",
      userIds,
      batches: chunkForMulticast(userIds, MULTICAST_MAX_RECIPIENTS),
      estimatedRecipients: userIds.length,
    };
  }

  // shadow（既定）: 旧が決める。新は数えるだけで、配信の挙動を 1 つも変えない。
  const legacy = await resolveTargets(audience, targetDeps);
  const cdp = await resolveCdpSegmentTargets(supabase, audience.persona);
  logSegmentShadow(audience.persona, legacy, cdp);
  return legacy;
}

/** shadow の 1 行ログ（**生の LINE userId は出さない**。件数だけ・E5）。 */
function logSegmentShadow(
  persona: string,
  legacy: ResolvedTargets,
  cdp: Awaited<ReturnType<typeof resolveCdpSegmentTargets>>,
): void {
  if (!cdp.ok) {
    console.warn(
      `[cdp/segment] mode=shadow persona=${persona} cdp_unavailable reason=${cdp.reason}`,
    );
    return;
  }
  const legacyIds = legacy.kind === "multicast" ? legacy.userIds : [];
  const agreement = compareTargets(legacyIds, cdp.userIds);
  console.log(
    `[cdp/segment] mode=shadow persona=${persona} ` +
      `legacy=${agreement.legacyCount} cdp=${agreement.cdpCount} both=${agreement.both} ` +
      `legacy_only=${agreement.legacyOnly} cdp_only=${agreement.cdpOnly} ` +
      `in_agreement=${agreement.inAgreement} excluded=${JSON.stringify(cdp.excluded)}`,
  );
}

/**
 * 日次観測用に、ペルソナごとの新旧一致を数える（配信はしない・読み取りのみ）。
 *
 * ここに置くのは、旧 resolver（全件スキャン 3 本）が **このファイルにしか無い**ため。
 * 観測側（cdp/stage4-parity.ts）に写すと「全件スキャンの口」が 1 つ増える。
 *
 * ─ 引けなかったペルソナは結果に入れない ─
 *   0 件同士を「一致」と数えると、Firestore 未設定の日が「一致した 1 日」になる。
 *   引けなかったことは警告に出し、判定からは外す（空虚合格を作らない）。
 *
 * **決して throw しない。**
 */
export async function compareSegmentTargets(
  env: Env,
): Promise<Record<string, SegmentAgreement>> {
  const out: Record<string, SegmentAgreement> = {};
  try {
    const supabase = createSupabaseClient(env);

    let fsEnv: FirestoreEnv | null = null;
    try {
      fsEnv = getFirestoreEnv(env);
    } catch {
      fsEnv = null;
    }
    if (!fsEnv) {
      console.warn("[cdp/segment] daily compare skipped: firestore_unconfigured");
      return out;
    }

    // 配信はしないので、送信に関わる依存（チャネル・allowlist）は配線しない。
    const deps: TargetResolverDeps = {
      loadLinkages: () => loadLinkages(env),
      loadPersonaUsers: (persona) => loadPersonaUsers(fsEnv as FirestoreEnv, persona),
      loadPersonaLineUsers: (persona) => loadPersonaLineUsers(fsEnv as FirestoreEnv, persona),
      broadcastEstimate: async () => null,
      loadAllowlistUserIds: async () => [],
    };

    for (const persona of VALID_PERSONAS) {
      const legacy = await resolveTargets({ kind: "persona", persona }, deps);
      if (legacy.kind === "error") {
        console.warn(
          `[cdp/segment] daily compare skipped persona=${persona}: ${legacy.reason}`,
        );
        continue;
      }
      const cdp = await resolveCdpSegmentTargets(supabase, persona);
      if (!cdp.ok) {
        console.warn(
          `[cdp/segment] daily compare skipped persona=${persona}: cdp ${cdp.reason}`,
        );
        continue;
      }
      out[persona] = compareTargets(
        legacy.kind === "multicast" ? legacy.userIds : [],
        cdp.userIds,
      );
    }
  } catch (err) {
    console.warn(
      "[cdp/segment] daily compare failed (non-blocking):",
      err instanceof Error ? err.message : String(err),
    );
  }
  return out;
}

/** 承認 pin の結果。 */
export type PinApprovalResult =
  | {
      ok: true;
      contentHash: string;
      /** 承認時点の配信対象人数（スナップショット・N-12）。呼び出し側が判定タスクに載せる。 */
      approvedAudienceCount: number;
      /** 指紋に載せた配信対象の識別子（"all" / "persona:xxx" / "allowlist"）。 */
      audienceKey: string;
    }
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
  // 配信対象は指紋の構成要素（2026-09-22）。空・未知は pin しない（fail-closed）。
  const audience = parseAudience(page.audienceRaw);
  if (!audience) {
    return { ok: false, reason: "配信対象が空/未知（fail-closed）" };
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

  // 承認時点の配信対象人数（N-12 の基準）。取得できないまま pin すると送信直前の
  // 「+10% 超で停止」の基準が無くなるので、ここは fail-closed で止める。
  let approvedAudienceCount: number;
  try {
    const targets = await resolveTargetsForEnv(env, audience);
    if (targets.kind === "error") {
      return { ok: false, reason: `配信対象の人数を数えられない: ${targets.reason}` };
    }
    approvedAudienceCount = targets.estimatedRecipients;
  } catch (err) {
    return {
      ok: false,
      reason: `配信対象の人数を数えられない: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Number.isInteger(approvedAudienceCount) || approvedAudienceCount < 1) {
    return { ok: false, reason: "配信対象の人数が 0（送る相手がいない・fail-closed）" };
  }

  // ハッシュは恒久R2 URL 群 + 配信対象で計算（送信時は同じ組み立てで再計算し照合）。
  const audienceKey = audienceFingerprintKey(audience);
  const contentHash = await computeContentHash({
    format: page.format,
    body: page.body,
    imageUrls: r2Urls,
    audience: audienceKey,
  });
  await pinApproval(request, pageId, contentHash, approvedAudienceCount);
  return { ok: true, contentHash, approvedAudienceCount, audienceKey };
}

// ---------------------------------------------------------------------------
// 1 件指定送信の runtime 配線（POST /api/delivery/send-one が唯一の送信経路）
// ---------------------------------------------------------------------------
//
// ⚠ 旧「全件送る口」（`POST /api/delivery/run` / `runOnDemandDelivery` / `runDelivery` /
//    `runDeliveryOnce`）は 2026-09-22 に削除した。互換の再追加をしないこと
//    （プラン v6.2 §4-2 の 1・§7-5「1 件だけ送る口が成り立たないなら止めて相談する」）。
//
// 送信可否を握る多層ガード（プラン §4-3）:
//   1-2. Setaka の承認と送信直前の再確認（Mac 側が主・ここは第二の防御）
//   5.   1 件指定（対象は引数の pageId だけ。走査しない）
//   6.   配信本体による承認確認（All Tasks 判定行・最終編集者・指紋）
//   8.   既存の確認（配信停止の除外・無料枠 200 通・claim による二重送信防止）

/** 対象解決に必要な依存を env から組む（pin と送信で同じ解決経路を使う）。 */
function buildTargetDeps(
  env: Env,
  accessToken: string,
  fallbackFriendCount: number | null,
  onBasis?: (basis: FriendCountBasis) => void,
): TargetResolverDeps {
  let fsEnv: FirestoreEnv | null = null;
  try {
    fsEnv = getFirestoreEnv(env);
  } catch {
    fsEnv = null;
  }
  return {
    loadLinkages: () => loadLinkages(env),
    loadPersonaUsers: async (persona) => {
      if (!fsEnv) throw new Error("Firestore 未設定のためペルソナ対象を解決できない");
      return loadPersonaUsers(fsEnv, persona);
    },
    loadPersonaLineUsers: async (persona) => {
      if (!fsEnv) throw new Error("Firestore 未設定のため lineUsers 直読みができない");
      return loadPersonaLineUsers(fsEnv, persona);
    },
    // 全員配信の受信者数は送信のたびに LINE から数える（固定値は必ず陳腐化する・2026-09-11）。
    broadcastEstimate: async () => {
      const result = await resolveBroadcastRecipientEstimate({
        fetchPage: createLineFollowerPageFetcher(accessToken),
        envFallback: fallbackFriendCount,
      });
      onBasis?.(result.basis);
      console.log(
        `[delivery] friend-count basis=${result.basis} count=${result.count ?? "-"} ` +
          `pages=${result.pages}${result.reason ? ` reason=${result.reason}` : ""}`,
      );
      return result.count;
    },
    loadAllowlistUserIds: async () => parseAllowlist(env.LINE_INTERNAL_USER_IDS),
  };
}

/** 承認 pin 時に配信対象人数を数えるための解決（送信経路と同じ resolver を通す）。 */
async function resolveTargetsForEnv(
  env: Env,
  audience: AudienceSpec,
): Promise<ResolvedTargets> {
  const channel = resolveDeliveryChannel(env);
  const supabase = createSupabaseClient(env);
  const deps = buildTargetDeps(env, channel.accessToken, channel.fallbackFriendCount);
  return resolveTargetsWithCdp(env, supabase, audience, deps);
}

/** Notion の一時失敗を「保留」に翻訳する承認確認ポート（読み取りのみ）。 */
export function createApprovalTaskPort(env: Env): ApprovalTaskPort {
  const request = createNotionRequest(env);
  const translate = (err: unknown): never => {
    if (err instanceof NotionHttpError && isRetryableNotionStatus(err.status)) {
      throw new RetryableApprovalError(`Notion ${err.status}`);
    }
    if (err instanceof TypeError) {
      // fetch 自体が失敗した（ネットワーク）。無効ではなく保留。
      throw new RetryableApprovalError(`network: ${err.message}`);
    }
    throw err;
  };
  return {
    fetchTask: async (taskPageId) => {
      try {
        return await fetchApprovalTask(request, taskPageId);
      } catch (err) {
        return translate(err);
      }
    },
    resolveUserEmail: async (userId) => {
      try {
        return await fetchNotionUserEmail(request, userId);
      } catch (err) {
        return translate(err);
      }
    },
  };
}

/**
 * 送信予約ポート（claim-before-send）。
 *
 * 原子性の出所は line_message_ledger の UNIQUE (notion_page_id, month)。
 * `INSERT ... ON CONFLICT DO NOTHING` が挿入できた 1 本だけが送ってよい（N-06 / N-07）。
 * ⚠ アプリ層で「読んで、無ければ書く」に書き換えないこと（並列 2 本が同時に読む窓が開く）。
 * 要 migration 056（reservation_id / send_state / sent_count）。
 */
export function createSupabaseReservationPort(
  supabase: ReturnType<typeof createSupabaseClient>,
): SendReservationPort {
  return {
    async claim(input): Promise<ReservationClaim> {
      const { data, error } = await supabase
        .from(LEDGER_TABLE)
        .upsert(
          {
            month: input.month,
            source: "broadcast",
            recipients: input.recipients,
            notion_page_id: input.pageId,
            aggregation_unit: input.aggregationUnit ?? null,
            reservation_id: input.reservationId,
            send_state: "sending",
          },
          { onConflict: "notion_page_id,month", ignoreDuplicates: true },
        )
        .select("id");
      if (error) throw new Error(`send reservation claim failed: ${error.message}`);
      if ((data?.length ?? 0) > 0) return { kind: "claimed" };

      // 取れなかった = 既存の予約がいる。誰の予約で、いまどの状態かを読んで判断する。
      const existing = await supabase
        .from(LEDGER_TABLE)
        .select("reservation_id,send_state,sent_count")
        .eq("notion_page_id", input.pageId)
        .eq("month", input.month)
        .limit(1);
      if (existing.error) {
        throw new Error(`send reservation read failed: ${existing.error.message}`);
      }
      const row = (existing.data ?? [])[0] as
        | {
            reservation_id: string | null;
            send_state: string | null;
            sent_count: number | null;
          }
        | undefined;
      const state = row?.send_state;
      return {
        kind: "duplicate",
        sameReservation: (row?.reservation_id ?? null) === input.reservationId,
        sendState:
          state === "sending" || state === "sent" || state === "failed"
            ? state
            : "unknown",
        sentCount: row?.sent_count ?? null,
      };
    },

    async finish(input): Promise<void> {
      const { error } = await supabase
        .from(LEDGER_TABLE)
        .update({
          send_state: input.sendState,
          sent_count: input.sentCount,
          ...(input.lineRequestId ? { line_request_id: input.lineRequestId } : {}),
        })
        .eq("notion_page_id", input.pageId)
        .eq("month", input.month);
      if (error) throw new Error(`send reservation finish failed: ${error.message}`);
    },
  };
}

function rejectedResponse(
  code: SendOneResponse["code"],
  reason: string,
  reservationId: string,
): SendOneResponse {
  return {
    status: "rejected",
    code,
    reason,
    sentCount: 0,
    audienceCount: 0,
    ledgerRemaining: null,
    reservationId,
  };
}

/**
 * 1 件指定送信（runtime 配線）。`POST /api/delivery/send-one` からのみ呼ばれる。
 * preflight（台帳テーブル / 配信 DB の env 分離 / チャネル）は送信前に fail-closed で塞ぐ。
 */
export async function runSendOneDelivery(
  env: Env,
  req: SendOneRequest,
): Promise<SendOneResponse> {
  const reservationId = typeof req?.reservationId === "string" ? req.reservationId : "";
  const supabase = createSupabaseClient(env);

  // preflight 1: 通数台帳テーブル（不在なら送信経路に載せない）。
  const ledgerErr = await checkLedgerTables(supabase);
  if (ledgerErr) {
    return rejectedResponse("ledger_error", `preflight 失敗: ${ledgerErr}`, reservationId);
  }

  // preflight 2: 配信 DB の env 分離（test ワーカーが本番 DB を指す誤配線を塞ぐ）。
  try {
    resolveDeliveryDbId(env);
  } catch (e) {
    if (e instanceof DeliveryDbConfigError) {
      return rejectedResponse(
        "bad_request",
        `配信 DB 解決 fail-closed: ${e.message}`,
        reservationId,
      );
    }
    throw e;
  }

  // preflight 3: 送信先 OA（token 未設定は throw = fail-closed）。
  let channel;
  try {
    channel = resolveDeliveryChannel(env);
  } catch (err) {
    return rejectedResponse(
      "bad_request",
      `送信先チャネル未設定: ${err instanceof Error ? err.message : String(err)}`,
      reservationId,
    );
  }

  const request = createNotionRequest(env);
  const ledger = createSupabaseLedgerStore(supabase);
  const r2Base = resolveR2PublicBase(env);
  let lastEstimateBasis: FriendCountBasis | null = null;
  const targetDeps = buildTargetDeps(
    env,
    channel.accessToken,
    channel.fallbackFriendCount,
    (basis) => {
      lastEstimateBasis = basis;
    },
  );

  const deps: SendOneDeps = {
    repo: {
      fetchPage: (pageId) => fetchDeliveryPage(request, pageId),
      setStatus: (pageId, status) => setStatus(request, pageId, status),
      writeResult: (pageId, result) => writeDeliveryResult(request, pageId, result),
      writeError: (pageId, reason) => writeDeliveryError(request, pageId, reason),
    },
    reservation: createSupabaseReservationPort(supabase),
    confirmedConsumption: (month) => ledger.confirmedConsumption(month),
    consumption: consumptionFetcherForToken(channel.accessToken),
    approvalTask: createApprovalTaskPort(env),
    // 照合に使うメールは設定 1 か所に 1 件だけ（既定値を持たない・N-05）。
    ownerEmail: env.DELIVERY_OWNER_EMAIL,
    resolveTargets: (audience: AudienceSpec) =>
      resolveTargetsWithCdp(env, supabase, audience, targetDeps),
    sender: createLineSender(channel),
    now: () => new Date(),
    imageUrlsFor: (page) => r2UrlsForPage(page.id, page.imageCount ?? 0, r2Base),
  };

  const res = await sendOneDelivery(deps, req);

  // 送信 1 回を指す鍵と人数の出所を台帳に注記する（best-effort・送信結果は変えない）。
  if (res.status === "sent" && lastEstimateBasis) {
    await ledger
      .annotate?.(
        { notionPageId: req.pageId, month: currentLineMonth() },
        { recipientsBasis: lastEstimateBasis ?? undefined },
      )
      .catch((err: unknown) => {
        console.warn(
          `[delivery] 台帳注記に失敗（送信は成立・帳簿の精度だけの問題）: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  console.log(
    `[delivery] send-one env=${channel.label} month=${currentLineMonth()} ` +
      `page=${req?.pageId ?? "-"} reservation=${reservationId || "-"} ` +
      `status=${res.status} code=${res.code} sent=${res.sentCount} ` +
      `audience=${res.audienceCount} remaining=${res.ledgerRemaining ?? "-"}`,
  );
  return res;
}
