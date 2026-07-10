/**
 * 配信 runtime 配線（T8/T9 の実 I/O 束ね）。
 *
 * 実アダプタ（Notion / Supabase / Firestore / LINE チャネル）を構築し、
 * オーケストレータ（delivery-orchestrator.ts）を駆動する `runDelivery` を提供する。
 *
 * ⚠ 実送信の絶対制約:
 *   - sendEnabled = (DELIVERY_SEND_ENABLED === "true")。既定 false。
 *   - false のときは orchestrator が step(g) の前で「非破壊プレビュー」early-return し、
 *     台帳 claim も setStatus(Sending) も writeResult も送信も一切行わない（QA Finding 1 修正）。
 *     sender=noopSender も併せて注入するが、そもそも送信点に到達しない。
 *   - cron からの自動発火は wrangler.toml crons=[] のため発生しない（本タスクでは実発火ゼロ）。
 */

import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";
import {
  getFirestoreEnv,
  getAccessToken,
  firestoreBaseUrl,
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
  pinApproval,
  fetchDeliveryPage,
  DEFAULT_DELIVERY_DB_ID,
} from "./delivery-repository";
import { computeContentHash } from "./content-hash";
import { hasIndependentApprover } from "./delivery-approval";
import { resolveDeliveryChannel } from "./delivery-channel";
import { createLineSender, noopSender } from "./line-messages";
import {
  resolveTargets,
  collectAllPages,
  type LinkageRow,
  type PersonaRow,
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

/** Firestore: persona.primary 設定済みユーザーを cursor ページングで全件取得。 */
async function loadPersonaUsers(fsEnv: FirestoreEnv): Promise<PersonaRow[]> {
  const accessToken = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
  const PAGE = 300;

  return collectAllPages<PersonaRow>(async (cursor) => {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: "users", allDescendants: false }],
      where: {
        fieldFilter: {
          field: { fieldPath: "persona.primary" },
          op: "NOT_EQUAL",
          value: { nullValue: null },
        },
      },
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit: PAGE,
    };
    if (cursor) {
      structuredQuery.startAt = {
        values: [{ referenceValue: cursor }],
        before: false,
      };
    }

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

/** 承認 pin の結果。 */
export type PinApprovalResult =
  | { ok: true; contentHash: string }
  | { ok: false; reason: string };

/**
 * 承認時のコンテンツ pinning（T12）を実行する。
 * ページの現在値を読み、形式別の必須項目 + 自己承認（承認者!=著者）を検証し、
 * ハッシュを保存して Status=Approved にする。実送信はしない。
 */
export async function pinDeliveryApproval(
  env: Env,
  pageId: string,
): Promise<PinApprovalResult> {
  const request = createNotionRequest(env);
  const page = await fetchDeliveryPage(request, pageId);

  if (page.format !== "text" && page.format !== "image") {
    return { ok: false, reason: "形式が未設定/未知" };
  }
  if (page.format === "text" && !(page.body ?? "").trim()) {
    return { ok: false, reason: "text 形式だが本文が空" };
  }
  if (page.format === "image" && !page.imageUrl) {
    return { ok: false, reason: "image 形式だが画像URLが空" };
  }
  if (!hasIndependentApprover(page.assignees, page.approvers)) {
    return { ok: false, reason: "独立した承認者がいない（自己承認・fail-closed）" };
  }

  const contentHash = await computeContentHash({
    format: page.format,
    body: page.body,
    imageUrl: page.imageUrl,
  });
  await pinApproval(request, pageId, contentHash);
  return { ok: true, contentHash };
}

/** 配信を 1 巡実行する（runtime 配線）。実送信は sendEnabled のときのみ。 */
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
  const sendEnabled = env.DELIVERY_SEND_ENABLED === "true";
  const dbId = env.NOTION_DELIVERY_DB_ID || DEFAULT_DELIVERY_DB_ID;
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
    loadPersonaUsers: async () => {
      if (!fsEnv) throw new Error("Firestore 未設定のためペルソナ対象を解決できない");
      return loadPersonaUsers(fsEnv);
    },
    broadcastEstimate: async () => channel.estimatedFriendCount,
  };

  const ledger = createSupabaseLedgerStore(supabase);

  const deps: OrchestratorDeps = {
    repo: {
      queryDue: (nowIso) => queryDueDeliveries(request, nowIso, dbId),
      querySending: () => querySendingDeliveries(request, dbId),
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
    sender: sendEnabled ? createLineSender(channel) : noopSender,
    now: () => new Date(),
    sendEnabled,
  };

  const result = await runDeliveryOnce(deps);
  console.log(
    `[delivery] env=${channel.label} sendEnabled=${sendEnabled} month=${currentLineMonth()} ` +
      `scanned=${result.scanned} processed=${result.processed.length} reaper=${result.reaper.length}`,
  );
  return result;
}
