/**
 * M6 Staging E2E — LINE↔Shopify 連携の「実機 LINE を要さない範囲」を staging で実測する。
 *
 * 対象（設計書 §9）:
 *   R-a  staging worker の Shopify 宛先が **開発ストア**であること（本番ストアでないこと）
 *   R-b  staging worker の Supabase が **staging ref** であること
 *   T-1  未連携ユーザーへの `flow_events.link.invite_shown` **記録**（ボタン表示の実証ではない・後述）
 *   T-3  連携済みユーザーの注文照会で開発ストアの注文（#1001 / #1002）が返ること【**陽性対照**】
 *   T-4  [SEC-A] 未連携ユーザーの注文照会は「連携が必要」応答で、他人の注文が漏れないこと
 *   T-6  注文番号指定の詳細照会が当該注文の詳細（品目・状況）を返すこと
 *   T-7  カート生成の checkoutUrl が開発ストアのドメインであること
 *   T-9  本番 OA / 本番リソースへの接触がゼロであること（outbound 実測 + ガード陽性対照）
 *
 * 対象外（実機 LINE が要る）: AC-2 の LIFF レッグ / AC-3 の `sub == Messaging userId` 実測 /
 *   **連携ボタンが実際に描画されること**（T-1 の「表示」レッグ。理由は下記）。
 *   T-10（既存 unit スイート）は本ハーネスの外（`pnpm test:unit`）で判定する。
 *
 * ---------------------------------------------------------------------------
 * 判定の相関保証（2026-07-22 差し戻し対応・最重要）
 * ---------------------------------------------------------------------------
 * 旧版は「now−5 秒以降の同一 userId の最新 assistant 行」を拾うだけで、**どのリクエストへの
 * 応答かを相関付けていなかった**。同一 userId を使う T-3 / T-6 / T-7 で窓が重なり、
 * T-6 の待機が T-3 の応答を拾って誤判定していた（実測: T-6 発話 23:07:59.94Z に対し
 * 23:07:56.98Z の T-3 応答を採用）。逆向き（前テストの応答に "1001"/"商品" が含まれて誤 PASS）も
 * 同じ欠陥である。
 *
 * 本版は 4 段で相関を機械的に保証する（`ask()`）:
 *   0. **DB 時計の厳密な起点を取る** — 送信した webhook の `webhookEventId`（run ごとに UUID）を
 *      `processed_events` から引き、その `processed_at` を下限にする。worker は
 *      processed_events を **先に await して書いてから**メッセージ処理に入る（routes/line.ts:245-252）
 *      ため、この時刻はこのリクエスト由来の行より必ず前・他 run の行より必ず後になる。
 *      ローカル時計は一切使わない（`now - N秒` という当て推量の窓を廃止）。
 *   1. **自分の user 発話行を同定する** — conversations(role=user) を「送った本文 + 上記 DB 起点以降」で
 *      引き当て、その `created_at` を下限にする（worker は user 行 → assistant 行の順で書く:
 *      routes/line.ts:944, :1007）。前テストの応答は構造上この下限より前になる。
 *   2. **直前応答の created_at を持ち越す** — 同一 userId の前回応答時刻を watermark として
 *      保持し、下限は max(自分の user 行, 前回応答) を採る（未消費の古い応答を採らない）。
 *   3. **timeout したストリームは poison する** — 応答が来なかった userId は以降 `desynced` とし、
 *      同じ userId の後続テストは送信もせず **BLOCKED** にする（遅れて届いた前リクエストの応答を
 *      次テストが拾う最後の穴を塞ぐ。誤 PASS/誤 FAIL より「判定不能」を出す）。
 *
 * ※ 0 を入れた理由（2026-07-22 実測）: 最初の修正版はローカル時計の run floor（now−120 秒）で
 *   過去 run を除外していたが、**1 分後に再実行したら前 run の行を拾った**（同一本文・floor 内）。
 *   窓を広げる/狭めるでは直らない種類の欠陥なので、DB 時計の厳密な起点に置き換えた。
 *
 * 安全:
 *   - 宛先は tests/lib/assert-not-prod のホワイトリスト経由でのみ解決する（本番 worker へ到達不能）。
 *   - Supabase は **必ず *_STAGING**（fail-closed）。prod ref には一切接続しない。
 *   - 使う LINE userId はすべて合成（U+32hex・実在しない）。replyToken も合成なので
 *     LINE 側の返信は必ず失敗し、実在の誰にも 1 通も届かない（実配信ゼロ）。
 *   - Shopify への書き込みは一切しない（注文照会・カート作成は read / 一時カートのみ）。
 *
 * 使い方:
 *   STAGING_BASE_URL=https://elxea-agent-staging.setaka-on.workers.dev \
 *     npx tsx tests/staging/m6-shopify-linkage-e2e.ts
 *
 * 後片付け（実機テスト前に必須）:
 *   npx tsx scripts/cleanup-m6-test-linkages.ts --apply
 *   （合成連携行を残したまま実機で同じテスト顧客を連携すると customer_linkages に
 *     同一 shopify_customer_id の行が 2 本でき、web チャネルの `.single()`（src/lib/shopify.ts:35-39）が
 *     multiple-rows エラー → null → 未連携扱いに壊れる）
 */

import dotenv from "dotenv";
import * as crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertAllowedTestTarget,
  assertNoProdMarker,
  installTestFetchGuard,
  resolveStagingBaseUrl,
  PROD_SUPABASE_REF,
  PROD_OA_ID,
  PROD_WORKER_HOSTS,
  STAGING_WORKER_HOST,
} from "../lib/assert-not-prod";
import { upsertCustomerLinkage } from "../../src/lib/customer-linkage";

dotenv.config({ path: ".dev.vars" });
installTestFetchGuard("m6-shopify-linkage-e2e");

// ---------------------------------------------------------------------------
// T-9 用: この run が実際に触った outbound ホストを記録する（ガードの内側に重ねる）
// ---------------------------------------------------------------------------
const OUTBOUND_HOSTS = new Set<string>();
{
  const inner = globalThis.fetch;
  const recorder = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    try {
      OUTBOUND_HOSTS.add(new URL(url).hostname.toLowerCase());
    } catch {
      OUTBOUND_HOSTS.add("<unparsable>");
    }
    return inner(input as RequestInfo, init);
  }) as typeof fetch;
  globalThis.fetch = recorder;
}

const STAGING_URL = resolveStagingBaseUrl(undefined, "m6 STAGING_BASE_URL");

/**
 * 開発ストア（テスト用・本番ストアではない）。
 *
 * 2026-07-22 張替: 旧 `elxea-test-ugen0voh` → `elxea-test2`。
 *   旧ストアのアプリは管理画面「アプリを開発」製で protected customer data Level 2 が
 *   プラン依存（Grow 以上）となり `customer{displayName}` 等が ACCESS_DENIED になっていた
 *   （T-3 FAIL → T-4 BLOCKED の根因）。新ストアは本番 `elxea-ec-api` と **同型** の
 *   Dev Dashboard 製 custom distribution アプリで Level 2 がプラン非依存に使えるため、
 *   本番同等の条件で測れる。
 */
const DEV_STORE_DOMAIN = "elxea-test2.myshopify.com";
/** 開発ストアのテスト顧客 Shopify customer id（2026-07-22 Admin API 実測）。 */
const TEST_SHOPIFY_CUSTOMER_ID = "24858806714740";
/** 開発ストアの実在商品名（#1001 / #1002 の唯一の品目・照合語）。 */
const DEV_STORE_PRODUCT_TITLE = "テスト商品A";
/** 開発ストアのテスト顧客の displayName（PII・漏洩判定の照合語）。 */
const DEV_STORE_CUSTOMER_DISPLAY_NAME = "Test Shopify";
/** staging Supabase ref（設計 §5）。 */
const STAGING_SUPABASE_REF = "espeokdhutgztksdrpzt";

/** 合成 Messaging userId（U + 32hex）。m6 由来と分かる hex マーカー付き。 */
const HEX32 = (tail: string) => {
  const head = "e6a11" /* e2e-a11 */ + "0".repeat(32 - 5 - tail.length) + tail;
  if (!/^[0-9a-f]{32}$/.test(head)) throw new Error(`bad synthetic hex: ${head}`);
  return `U${head}`;
};
/** 連携済みにする合成 userId（手順 2 で customer_linkages に投入する）。 */
const LINKED_ID = HEX32("0001");
/** 未連携の合成 userId（T-4 SEC-A 用。連携行を作らない）。 */
const UNLINKED_ID = HEX32("0002");
/** T-1 用の別の未連携合成 userId（invite_shown を汚さないよう分離）。 */
const INVITE_ID = HEX32("0003");

const LINKAGE_TRIGGER = "アカウントを連携する";

/** 相関の下限の初期値。実際の下限は毎回 processed_events（DB 時計）から取る。 */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// 判定記録（PASS / FAIL / BLOCKED の 3 値）
// ---------------------------------------------------------------------------
type Verdict = "PASS" | "FAIL" | "BLOCKED";
const results: Array<{ verdict: Verdict; name: string; detail: string }> = [];
let failed = 0;
let blocked = 0;

function record(verdict: Verdict, name: string, detail: string): Verdict {
  const line = `  [${verdict}] ${name}: ${detail}`;
  console.log(line);
  results.push({ verdict, name, detail });
  if (verdict === "FAIL") failed++;
  if (verdict === "BLOCKED") blocked++;
  return verdict;
}
function check(name: string, pass: boolean, detail: string): Verdict {
  return record(pass ? "PASS" : "FAIL", name, detail);
}
/** 判定不能（前提が崩れている）。PASS でも FAIL でもないことを明示する。 */
function blockedCheck(name: string, reason: string, detail = ""): Verdict {
  return record("BLOCKED", name, detail ? `${reason} — ${detail}` : reason);
}

// ---------------------------------------------------------------------------
// staging Supabase（fail-closed）
// ---------------------------------------------------------------------------
function stagingSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL_STAGING;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING;
  if (!url || !key) {
    throw new Error("SUPABASE_URL_STAGING / SUPABASE_SERVICE_ROLE_KEY_STAGING が .dev.vars に無い（fail-closed）。");
  }
  // 三重ガード: 本番 ref を含む URL には決して接続しない。
  assertNoProdMarker(url, "SUPABASE_URL_STAGING");
  if (!url.includes(STAGING_SUPABASE_REF)) {
    throw new Error(`SUPABASE_URL_STAGING が staging ref (${STAGING_SUPABASE_REF}) を指していない。中断。`);
  }
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// LINE webhook 送信（署名付き）
// ---------------------------------------------------------------------------
function pickWebhookSecret(): { label: string; secret: string } {
  // staging worker の LINE_CHANNEL_SECRET は「テスト OA の secret」が入っている（実測: 署名プローブ）。
  const s = process.env.LINE_CHANNEL_SECRET_TEST;
  if (!s) throw new Error("LINE_CHANNEL_SECRET_TEST が .dev.vars に無い（署名できないため中断）。");
  return { label: "LINE_CHANNEL_SECRET_TEST", secret: s };
}

/** webhook 本文を組む（署名対象）。webhookEventId は相関の起点なので呼び出し側に返す。 */
function buildWebhookBody(userId: string, text: string, eventId: string): string {
  return JSON.stringify({
    destination: "U" + "0".repeat(32),
    events: [
      {
        type: "message",
        mode: "active",
        timestamp: Date.now(),
        // processEvents は deliveryContext.isRedelivery と webhookEventId を必須で読む
        // （line.ts:226,235）。欠けると TypeError で 1 件も処理されない（実測 2026-07-22）。
        webhookEventId: eventId,
        deliveryContext: { isRedelivery: false },
        source: { type: "user", userId },
        // 合成 replyToken: LINE 側の返信は必ず失敗する（実在の誰にも届かない）。
        replyToken: "0".repeat(32),
        message: { type: "text", id: `m6-${Date.now()}`, text },
      },
    ],
  });
}

async function postWebhook(body: string, secret: string): Promise<number> {
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64");
  const target = assertAllowedTestTarget(`${STAGING_URL}/webhook/line`, "m6 webhook POST");
  const res = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": sig },
    body,
  });
  return res.status;
}

/** 1 通送る。相関の起点になる eventId を必ず返す。 */
async function sendLineText(
  userId: string,
  text: string,
): Promise<{ http: number; eventId: string }> {
  const { secret } = pickWebhookSecret();
  const eventId = `m6-${crypto.randomUUID()}`;
  const http = await postWebhook(buildWebhookBody(userId, text, eventId), secret);
  return { http, eventId };
}

/**
 * 送った webhook イベントが worker に取り込まれた **DB 時計上の時刻** を取る（相関の起点）。
 * worker は processed_events を await で先に書いてからメッセージ処理へ進む（routes/line.ts:245-252）。
 */
async function waitProcessedAt(
  supabase: SupabaseClient,
  eventId: string,
  timeoutMs = 45_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("processed_events")
      .select("webhook_event_id, processed_at")
      .eq("webhook_event_id", eventId)
      .limit(1);
    if (data && data.length > 0) return data[0].processed_at as string;
    await sleep(1500);
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 相関付き 1 往復（ask）
// ---------------------------------------------------------------------------
type ConvRow = { content: string; created_at: string };

/** userId ごとの相関状態。desynced が立ったストリームは以降 BLOCKED 扱いにする。 */
type StreamState = { lastUserAt: string; lastReplyAt: string; desynced: string | null };
const streams = new Map<string, StreamState>();
function streamOf(userId: string): StreamState {
  let s = streams.get(userId);
  if (!s) {
    s = { lastUserAt: EPOCH_ISO, lastReplyAt: EPOCH_ISO, desynced: null };
    streams.set(userId, s);
  }
  return s;
}

/** 「自分が今送った発話」の user 行を本文一致で同定する（run floor 以降・単調増加）。 */
async function findOwnUserRow(
  supabase: SupabaseClient,
  userId: string,
  text: string,
  sinceIso: string,
  timeoutMs = 45_000,
): Promise<ConvRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("conversations")
      .select("content, created_at")
      .eq("user_id", userId)
      .eq("role", "user")
      .eq("content", text)
      .gt("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .limit(1);
    if (data && data.length > 0) return data[0] as ConvRow;
    await sleep(2000);
  }
  return null;
}

/** 指定時刻より後の「最初の」assistant 行を取る（最新ではなく最初 = 自分の応答）。 */
async function findReplyAfter(
  supabase: SupabaseClient,
  userId: string,
  afterIso: string,
  timeoutMs: number,
): Promise<ConvRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("conversations")
      .select("content, created_at")
      .eq("user_id", userId)
      .eq("role", "assistant")
      .gt("created_at", afterIso)
      .order("created_at", { ascending: true })
      .limit(1);
    if (data && data.length > 0) return data[0] as ConvRow;
    await sleep(3000);
  }
  return null;
}

type AskResult =
  | { ok: true; reply: string; anchorAt: string; userAt: string; replyAt: string; http: number }
  | { ok: false; reason: string; http?: number };

/**
 * 1 発話送って「その発話への応答」を相関付きで取る。
 *
 * 相関の根拠（機械的・すべて DB 時計）:
 *   - 起点は自分の webhookEventId の `processed_events.processed_at`（他 run より必ず後）。
 *   - user 行は「送った本文 かつ 起点より後」で一意（同一本文を 1 run に 2 回送らない）。
 *   - 応答は必ず **自分の user 行より後**（worker は user 行を先に書く: line.ts:944）。
 *   - かつ **同一 userId の前回応答より後**（watermark 持ち越し）。
 *   - どちらも満たす最初の assistant 行だけを採る（「最新行」は採らない）。
 *   - timeout したら以降そのストリームは判定不能（desynced）にして BLOCKED を返す。
 */
async function ask(
  supabase: SupabaseClient,
  userId: string,
  text: string,
  replyTimeoutMs = 90_000,
): Promise<AskResult> {
  const s = streamOf(userId);
  if (s.desynced) {
    // 送信もしない（未消費の応答を増やして相関をさらに壊さない）。
    return { ok: false, reason: `stream desynced: ${s.desynced}` };
  }

  const { http, eventId } = await sendLineText(userId, text);
  console.log(`  webhook HTTP ${http} eventId=${eventId}`);

  const anchorAt = await waitProcessedAt(supabase, eventId);
  if (!anchorAt) {
    s.desynced = `webhook イベント ${eventId} が processed_events に現れなかった（DB 起点を取れない）`;
    return { ok: false, reason: "processed_events 不着（相関の起点なし）", http };
  }

  const userFloor = anchorAt > s.lastUserAt ? anchorAt : s.lastUserAt;
  const userRow = await findOwnUserRow(supabase, userId, text, userFloor);
  if (!userRow) {
    s.desynced = "自分の user 発話行が conversations に現れなかった（相関の起点を取れない）";
    return { ok: false, reason: `user 行が現れない（相関不能, anchor=${anchorAt}）`, http };
  }
  s.lastUserAt = userRow.created_at;

  const floor = userRow.created_at > s.lastReplyAt ? userRow.created_at : s.lastReplyAt;
  const replyRow = await findReplyAfter(supabase, userId, floor, replyTimeoutMs);
  if (!replyRow) {
    s.desynced = "直前リクエストの応答が timeout（遅延応答が後続を汚し得るため以降は判定不能）";
    return { ok: false, reason: `応答なし(timeout, floor=${floor})`, http };
  }
  s.lastReplyAt = replyRow.created_at;

  return {
    ok: true,
    reply: replyRow.content,
    anchorAt,
    userAt: userRow.created_at,
    replyAt: replyRow.created_at,
    http,
  };
}

/** 相関の裏取り（判定行に必ず載せる）。 */
function corr(r: Extract<AskResult, { ok: true }>): string {
  return `[corr anchor=${r.anchorAt} → user=${r.userAt} → reply=${r.replyAt}]`;
}

/**
 * そのユーザーの **過去の**会話に既出のカートトークン集合（履歴エコーの検出用）。
 *
 * なぜ要るか（2026-07-22 実測）: 同一 userId で T-7 を再実行したところ、返ってきた checkoutUrl の
 * カートトークンが **前 run と完全一致**した。`cartCreate` は毎回新しいカートを作るため、
 * 同一トークン = ツールを呼び直さず **会話履歴に残っていた URL を LLM がそのまま再掲した**ことを意味する。
 * この場合「ドメインが開発ストア」だけを見ると PASS になるが、`create_cart_link` が
 * 今回実行された証拠にはならない（真空 PASS）。よって新規性を判定条件に入れる。
 */
async function priorCartTokens(
  supabase: SupabaseClient,
  userId: string,
  beforeIso: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("conversations")
    .select("content, created_at")
    .eq("user_id", userId)
    .lt("created_at", beforeIso)
    .order("created_at", { ascending: false })
    .limit(200);
  const tokens = new Set<string>();
  for (const row of data ?? []) {
    for (const m of String(row.content ?? "").matchAll(/\/cart\/c\/([A-Za-z0-9_-]+)/g)) {
      tokens.add(m[1]);
    }
  }
  return tokens;
}

/** flow_events を 1 件待つ。 */
async function waitFlowEvent(
  supabase: SupabaseClient,
  userRef: string,
  eventName: string,
  sinceIso: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("flow_events")
      .select("event_name, user_ref, metadata, created_at")
      .eq("user_ref", userRef)
      .eq("event_name", eventName)
      .gt("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0] as Record<string, unknown>;
    await sleep(3000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(70));
  console.log("M6 Shopify Linkage Staging E2E");
  console.log(`Target worker : ${STAGING_URL}`);
  console.log(`Dev store     : ${DEV_STORE_DOMAIN}`);
  console.log(`Synthetic ids : linked=${LINKED_ID} unlinked=${UNLINKED_ID} invite=${INVITE_ID}`);
  console.log("相関の起点     : processed_events.processed_at（DB 時計・ローカル時計は不使用）");
  console.log("=".repeat(70));

  const supabase = stagingSupabase();

  // -------------------------------------------------------------------------
  // 手順 1: **合成ユーザーの**会話履歴だけを purge（run を hermetic にする）
  //
  //   なぜ必要か（2026-07-22 実測）: 同一 LINKED_ID で再実行すると、前 run の応答
  //   （カート URL 等）が会話履歴に残り、LLM がツールを呼ばずに**それを再掲する**。
  //   結果 T-7 が「ドメイン一致」だけで PASS する真空 PASS になる。
  //
  //   削除対象の限定（機械的保証）:
  //     - 対象は SYNTHETIC_IDS の 3 件のみ（`.in("user_id", SYNTHETIC_IDS)` の完全一致）。
  //     - その 3 件が合成前缀 `Ue6a11`（= 実在しない e2e 専用 hex マーカー）で始まることを
  //       削除前に assert する。1 件でも外れたら throw して **削除を実行しない**。
  //     - よって実ユーザー・実データの行が対象に入る経路は存在しない。
  // -------------------------------------------------------------------------
  const SYNTHETIC_PREFIX = "Ue6a11";
  const SYNTHETIC_IDS = [LINKED_ID, UNLINKED_ID, INVITE_ID];
  console.log("\n[SETUP] 合成ユーザーの会話履歴を purge（前 run のエコー防止）");
  for (const id of SYNTHETIC_IDS) {
    if (!id.startsWith(SYNTHETIC_PREFIX)) {
      throw new Error(`purge 対象が合成 ID ではない（中断・削除しない）: ${id}`);
    }
  }
  const { error: purgeErr } = await supabase
    .from("conversations")
    .delete()
    .in("user_id", SYNTHETIC_IDS);
  check(
    "合成ユーザーの会話履歴 purge（合成 ID 3 件のみ）",
    !purgeErr,
    purgeErr ? String(purgeErr.message) : `user_id in [${SYNTHETIC_IDS.join(", ")}]`,
  );

  // -------------------------------------------------------------------------
  // 手順 2: 合成の連携行を投入（AC-2 の LIFF レッグを迂回して下流を検証する）
  // -------------------------------------------------------------------------
  console.log("\n[SETUP] customer_linkages に合成の連携行を upsert（staging のみ）");
  const up = await upsertCustomerLinkage(supabase, {
    lineUserId: LINKED_ID,
    shopifyCustomerId: TEST_SHOPIFY_CUSTOMER_ID,
    shopifyEmail: "setaka-on+shopifytest@elxea.com",
    source: "test",
  });
  check("合成連携行 upsert", up.ok, up.ok ? `${LINKED_ID} → ${TEST_SHOPIFY_CUSTOMER_ID}` : String(up.error));
  if (!up.ok) process.exit(1);

  // 未連携 ID に行が無いことを明示確認（SEC-A の前提）。
  const { data: unlinkedRows } = await supabase
    .from("customer_linkages")
    .select("line_user_id")
    .eq("line_user_id", UNLINKED_ID);
  check("未連携 ID に連携行が無い", (unlinkedRows?.length ?? 0) === 0, `rows=${unlinkedRows?.length ?? 0}`);

  // -------------------------------------------------------------------------
  // T-3 連携済みユーザーの注文照会（下流 + R-a の実測）【陽性対照】
  //   ここが FAIL なら「そもそも誰も注文を取れない」環境であり、T-4 の PASS は真空 PASS になる。
  //   よって T-3 を **T-4 より先に** 実行し、その判定を T-4 のゲートに使う。
  // -------------------------------------------------------------------------
  console.log("\n[T-3] 連携済み ID で「注文状況」（陽性対照）");
  const t3 = await ask(supabase, LINKED_ID, "注文状況を教えてください");
  let t3Verdict: Verdict;
  if (!t3.ok) {
    t3Verdict = record("FAIL", "T-3 開発ストアの注文が返る（#1001 / #1002）", t3.reason);
  } else {
    const has1001 = /#?1001/.test(t3.reply);
    const has1002 = /#?1002/.test(t3.reply);
    t3Verdict = check(
      "T-3 開発ストアの注文が返る（#1001 / #1002）",
      has1001 && has1002,
      `${corr(t3)} ${JSON.stringify(t3.reply.slice(0, 400))}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-4 [SEC-A] 未連携ユーザーの注文照会
  //   **陽性対照ゲート**: T-3 が PASS でない限り PASS にしない（真空 PASS の禁止）。
  //   観測自体は行い、漏洩の有無は情報として必ず出す。
  // -------------------------------------------------------------------------
  console.log("\n[T-4 / SEC-A] 未連携 ID で「注文状況」");
  const t4 = await ask(supabase, UNLINKED_ID, "注文状況を教えてください");
  const T4_NAME = "T-4 未連携は連携要求で返り、他人の注文が漏れない";
  if (!t4.ok) {
    record("FAIL", T4_NAME, t4.reason);
  } else {
    // 漏洩判定: 開発ストアの注文番号・商品名・顧客名・メールが 1 つでも出たら FAIL（本質はここ）。
    const leakPattern = new RegExp(
      `(#?\\b100[12]\\b|${DEV_STORE_PRODUCT_TITLE}|${DEV_STORE_CUSTOMER_DISPLAY_NAME}|setaka-on\\+shopifytest)`,
      "i",
    );
    const t4Leak = leakPattern.test(t4.reply);
    // 案内判定: 連携（紐付け）を求める / 注文番号を求める 方向に誘導していること。
    const t4Guides = /(連携|紐付|ログイン|注文番号)/.test(t4.reply);
    const observed = `leak=${t4Leak} guides=${t4Guides} ${corr(t4)} ${JSON.stringify(t4.reply.slice(0, 260))}`;
    if (t4Leak) {
      // 漏洩は陽性対照に関係なく FAIL（安全側）。
      record("FAIL", T4_NAME, `他人の注文が漏れた: ${observed}`);
    } else if (t3Verdict !== "PASS") {
      blockedCheck(
        T4_NAME,
        "BLOCKED (positive control failed): 陽性対照 T-3 が PASS でないため、" +
          "「誰も注文を取れない環境で自動的に無漏洩になっただけ」を排除できない",
        observed,
      );
    } else {
      check(T4_NAME, t4Guides, observed);
    }
  }

  // -------------------------------------------------------------------------
  // T-6 注文番号指定の詳細照会
  // -------------------------------------------------------------------------
  console.log("\n[T-6] 連携済み ID で「注文番号 #1001 の詳細」");
  const t6 = await ask(
    supabase,
    LINKED_ID,
    "注文番号 #1001 の詳細を教えてください。品目と配送状況をお願いします。",
  );
  const T6_NAME = "T-6 当該注文の詳細（品目・状況）が返る";
  if (!t6.ok) {
    if (t6.reason.startsWith("stream desynced")) blockedCheck(T6_NAME, t6.reason);
    else record("FAIL", T6_NAME, t6.reason);
  } else {
    // 「品目」「商品」のような**質問文の語のエコー**では PASS にしない。
    // 開発ストアの実在品目名（#1001 の唯一の line item）が出ていることを要求する。
    check(
      T6_NAME,
      /1001/.test(t6.reply) && t6.reply.includes(DEV_STORE_PRODUCT_TITLE),
      `${corr(t6)} ${JSON.stringify(t6.reply.slice(0, 400))}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-7 カート生成（Storefront API・PII 非依存）
  //   既定は新開発ストア elxea-test2 の **実在 variant**（テスト商品A / S）。
  //   別の variant で測るときは CART_VARIANT_ID で上書きする（M サイズ = 55001939738996）。
  //   ⚠ 実測（2026-07-22）: この variant は availableForSale=false（在庫 -1）のため
  //      cartCreate は成功して checkoutUrl を返すが cart.lines は空（totalQuantity=0）になる。
  //      T-7 が測るのは「**開発ストアのドメイン**の checkoutUrl が **今回新規に**発行されたこと」
  //      であり、購入可能性ではないため判定は成立する（在庫は Admin 書き込み権限が無く変更不可）。
  // -------------------------------------------------------------------------
  const cartVariantId =
    process.env.CART_VARIANT_ID ?? "gid://shopify/ProductVariant/55001939706228";
  console.log(`\n[T-7] 連携済み ID でカート生成（variant_id=${cartVariantId}）`);
  const t7 = await ask(
    supabase,
    LINKED_ID,
    `この商品を買いたいです。create_cart_link ツールで variant_id="${cartVariantId}"、数量1のカートリンクを作ってください。`,
  );
  const T7_NAME = "T-7 checkoutUrl が開発ストアのドメイン";
  if (!t7.ok) {
    if (t7.reason.startsWith("stream desynced")) blockedCheck(T7_NAME, t7.reason);
    else record("FAIL", T7_NAME, t7.reason);
  } else {
    const t7Url = t7.reply.match(/https?:\/\/[^\s)"'）】]+/g)?.find((u) => /\/cart\/|checkout/.test(u));
    const t7Host = t7Url ? new URL(t7Url).hostname : null;
    const t7Token = t7Url?.match(/\/cart\/c\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
    // 履歴エコー検出: このカートトークンが「今回より前」の会話に既出でないこと。
    const seen = await priorCartTokens(supabase, LINKED_ID, t7.anchorAt);
    const fresh = !!t7Token && !seen.has(t7Token);
    const base = t7Host
      ? `host=${t7Host} token=${t7Token ?? "n/a"} url=${t7Url} ${corr(t7)}`
      : `checkoutUrl なし: ${corr(t7)} ${JSON.stringify(t7.reply.slice(0, 260))}`;

    if (!t7Host || t7Host !== DEV_STORE_DOMAIN) {
      record("FAIL", T7_NAME, base);
    } else if (!fresh) {
      blockedCheck(
        T7_NAME,
        "BLOCKED (history echo): カートトークンが同一ユーザーの過去会話に既出。" +
          "cartCreate は毎回新規カートを作るため、同一トークンは create_cart_link が" +
          "今回実行された証拠にならない（ドメイン一致だけの真空 PASS を排除）",
        base,
      );
    } else {
      check(T7_NAME, true, `${base} fresh=true（過去 ${seen.size} 件のトークンと不一致）`);
    }
  }

  // -------------------------------------------------------------------------
  // T-1 未連携ユーザーへの「invite_shown 記録」
  //
  //   ⚠ 判定名を実態に合わせた（旧: 「連携ボタン提示」）。
  //   `link.invite_shown` は subscriber-linkage.ts:338-342 で **`responder.flex(...)`（:344）より前**に
  //   fire-and-forget で記録される。したがって記録の存在は「記録された」ことの証拠であって
  //   **「ボタンが実際に表示された」ことの証拠ではない**（送信が失敗しても記録は残る設計）。
  //   ボタン表示の実証は **実機項目**（実 LINE で Flex が描画され、LIFF が開くこと）に分離する。
  // -------------------------------------------------------------------------
  console.log(`\n[T-1] 未連携 ID で完全一致トリガ「${LINKAGE_TRIGGER}」`);
  const t1Send = await sendLineText(INVITE_ID, LINKAGE_TRIGGER);
  console.log(`  webhook HTTP ${t1Send.http} eventId=${t1Send.eventId}`);
  // T-1 も DB 時計を起点にする（過去 run の invite_shown を拾わない）。
  const t1Anchor = await waitProcessedAt(supabase, t1Send.eventId);
  const T1_NAME = "T-1 invite_shown 記録（flow_events に link.invite_shown がある）";
  if (!t1Anchor) {
    record("FAIL", T1_NAME, `processed_events 不着（相関の起点なし, eventId=${t1Send.eventId}）`);
  } else {
    const t1Event = await waitFlowEvent(supabase, INVITE_ID, "link.invite_shown", t1Anchor);
    check(
      T1_NAME,
      !!t1Event,
      t1Event ? `[corr anchor=${t1Anchor}] ${JSON.stringify(t1Event)}` : `記録なし(timeout, anchor=${t1Anchor})`,
    );
  }
  record(
    "BLOCKED",
    "T-1b 連携ボタンの表示実証（Flex 描画 + LIFF 起動）",
    "実機項目（本ハーネスの対象外）。invite_shown は flex 送信の**前**に記録される" +
      "（subscriber-linkage.ts:338-342 → :344）ため、記録の存在は表示の証拠にならない。",
  );

  // -------------------------------------------------------------------------
  // R-b: staging worker が staging Supabase を使っていることの実測
  //   合成連携行は **staging Supabase にしか無い**。worker がそれを解決できた
  //   （= T-3 で本人の注文が返った）事実が、worker→staging Supabase の配線の証拠。
  //   さらに worker が書いた行（conversations / flow_events）が staging に現れることでも裏取りする。
  // -------------------------------------------------------------------------
  console.log("\n[R-b] worker の書き込みが staging Supabase に現れるか");
  const { data: rbRows } = await supabase
    .from("conversations")
    .select("user_id, channel, role, created_at")
    .in("user_id", [LINKED_ID, UNLINKED_ID])
    .order("created_at", { ascending: false })
    .limit(10);
  check(
    "R-b worker の会話行が staging Supabase に存在",
    (rbRows?.length ?? 0) > 0,
    `rows=${rbRows?.length ?? 0} (ref=${STAGING_SUPABASE_REF}, prod ref ${PROD_SUPABASE_REF} には未接続)`,
  );

  // -------------------------------------------------------------------------
  // T-9 本番 OA / 本番リソース非接触
  //   測れること: (1) この run の outbound ホスト実測 (2) ガードの陽性対照
  //   (3) staging worker が **テスト OA の channel secret** で署名検証していること
  //       （＝ worker が返信/push する先はテスト OA。本番 OA の channel ではない）。
  //   測れないこと（実機項目）: 本番 OA 側の受信ログそのもの。
  // -------------------------------------------------------------------------
  console.log("\n[T-9] 本番非接触（outbound 実測 + ガード陽性対照）");
  const hosts = Array.from(OUTBOUND_HOSTS).sort();
  const stagingSupabaseHost = new URL(process.env.SUPABASE_URL_STAGING as string).hostname.toLowerCase();
  const allowedHosts = new Set([STAGING_WORKER_HOST, stagingSupabaseHost]);
  const unexpected = hosts.filter((h) => !allowedHosts.has(h));
  check(
    "T-9a この run の outbound は staging worker と staging Supabase のみ",
    unexpected.length === 0,
    `hosts=[${hosts.join(", ")}]${unexpected.length ? ` 想定外=[${unexpected.join(", ")}]` : ""}`,
  );

  // ガードの陽性対照: 本番マーカーが実際に弾かれること（ガードが死んでいないことの実証）。
  const guardProbes: Array<{ label: string; url: string }> = [
    ...PROD_WORKER_HOSTS.map((h) => ({ label: h, url: `https://${h}/webhook/line` })),
    // ⚠ マーカーは **生のまま** 埋める。URL エンコードすると "@" が "%40" になり
    //    assertNoProdMarker の includes() が一致せず、ガードではなくプローブ側の欠陥で
    //    「弾かれなかった」と出る（2026-07-22 実測・自己修正）。
    { label: `prod OA marker (${PROD_OA_ID})`, url: `https://${STAGING_WORKER_HOST}/x?oa=${PROD_OA_ID}` },
    { label: `prod supabase ref`, url: `https://${PROD_SUPABASE_REF}.supabase.co/rest/v1/` },
  ];
  const notBlocked: string[] = [];
  for (const p of guardProbes) {
    try {
      assertAllowedTestTarget(p.url, "T-9 guard probe");
      notBlocked.push(p.label);
    } catch {
      /* 期待どおり弾かれた */
    }
  }
  check(
    "T-9b 本番宛先はガードで弾かれる（陽性対照）",
    notBlocked.length === 0,
    notBlocked.length === 0
      ? `probes=${guardProbes.length} すべて ProdContactError`
      : `弾かれなかった: ${notBlocked.join(", ")}`,
  );

  // staging worker の channel 束縛: テスト OA secret の署名は通り、別 secret の署名は 403。
  const probeBody = buildWebhookBody(
    INVITE_ID,
    "m6-signature-probe（処理されない・署名不正）",
    `m6-sigprobe-${crypto.randomUUID()}`,
  );
  const badStatus = await postWebhook(probeBody, crypto.randomBytes(32).toString("hex"));
  check(
    "T-9c staging worker はテスト OA secret のみ受理（別 secret は 403）",
    badStatus === 403,
    `不正署名 HTTP ${badStatus} / 正規署名（LINE_CHANNEL_SECRET_TEST）は上記各 T-x で HTTP 200 = ` +
      `staging worker の LINE channel はテスト OA。本番 OA ${PROD_OA_ID} の channel ではない。`,
  );
  console.log(
    "  注記: worker 側の LINE 送信は合成 replyToken → 失敗 → 合成 userId への push フォールバックとなり、" +
      "宛先が実在しないため実配信ゼロ。本番 OA 側の受信ログ確認は実機項目（未確認）。",
  );

  // -------------------------------------------------------------------------
  // サマリ
  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(70));
  for (const r of results) console.log(`  [${r.verdict}] ${r.name}`);
  console.log("-".repeat(70));
  const passed = results.filter((r) => r.verdict === "PASS").length;
  console.log(`M6 E2E: PASS=${passed} FAIL=${failed} BLOCKED=${blocked}`);
  console.log("後片付け: 合成連携行は残す（後続検証で使う）。");
  console.log(`  line_user_id=${LINKED_ID} shopify_customer_id=${TEST_SHOPIFY_CUSTOMER_ID} source=test`);
  console.log("  実機テスト前に必ず: npx tsx scripts/cleanup-m6-test-linkages.ts --apply");
  process.exit(failed === 0 && blocked === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
