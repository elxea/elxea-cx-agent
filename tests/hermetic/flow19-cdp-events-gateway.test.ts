/**
 * ハーメティック L1 — CDP 統合 Stage 1: 出来事が L0 に積まれ始める。
 *
 * 何を守るテストか:
 *   Stage 1 の完了条件は 2 つで、どちらも「動かしてみないと言えない」種類のものである。
 *
 *     (A) 既存の読み出し・書き込みの挙動が 1 つも変わらない
 *     (B) L0 (customer_events) に事実が積まれ始める
 *
 *   本番は連携 0 件なので、実データで (B) を確かめると **空虚合格** になる
 *   （0 件を積んで 0 件を数えて緑）。よってここでは Worker を workerd 内に立て、
 *   モック Supabase のストアを直接読んで「実際に積まれた行」を数える。
 *
 * 検査する契約:
 *   1. 既知の action → 従来どおり 200。加えて L0 に 1 行積まれ、schema_ok = true
 *   2. 未知の action → **従来どおり 400**（応答は変えない）。しかし L0 には積まれ、
 *      schema_ok = false（E1: 出来事は捨てない）
 *   3. 主体が発行される（subjects 1 行 + identity_edges 1 行）。2 回目は発行されない
 *   4. 同じ出来事を 2 回投げても L0 は 1 行のまま（冪等キー = 二重加算の構造的な止め）
 *   5. 未連携の人の行動は Firestore へは書かれないが、**理由が L0 に残る**（T-12）
 *   6. L0 の行に生の識別子が入っていない（E5 / PII）
 *
 * ハーメティック＝実ネットワーク不使用・実送信ゼロ。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
  h.supabase.reset();
});

afterEach(() => {
  h.restore();
});

/** validateSessionId が UUID v4 を要求するため、形の合う固定値を使う。 */
const SESSION = "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

async function postChatEvent(body: Record<string, unknown>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://example.com/api/chat/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  // fire-and-forget（waitUntil）の書き込みを待ってから数える。
  await waitOnExecutionContext(ctx);
  return res;
}

function l0Rows(): Array<Record<string, unknown>> {
  return h.supabase.all("customer_events");
}

describe("CDP Stage 1 — 出来事が L0 に積まれ始める", () => {
  it("既知の action は 200 のまま。加えて L0 に 1 行積まれる（schema_ok = true）", async () => {
    const res = await postChatEvent({ session_id: SESSION, action: "chat_started" });

    // (A) 既存の挙動が変わっていない。
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // (B) L0 に積まれている。
    const rows = l0Rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("behavior.chat_started");
    expect(rows[0].channel).toBe("web");
    expect(rows[0].schema_ok).toBe(true);
    expect(rows[0].source).toBe("cx-agent.behavior-log");
  });

  it("主体が発行される。2 回目の観測では発行し直さない", async () => {
    await postChatEvent({ session_id: SESSION, action: "chat_started" });

    const subjects = h.supabase.all("subjects");
    const edges = h.supabase.all("identity_edges");
    expect(subjects).toHaveLength(1);
    expect(edges).toHaveLength(1);
    expect(edges[0].identifier_kind).toBe("web_session_id");
    expect(edges[0].identifier_value).toBe(SESSION);

    // 同じ人の 2 つ目の出来事。主体は増えない。
    await postChatEvent({ session_id: SESSION, action: "product_viewed" });
    expect(h.supabase.all("subjects")).toHaveLength(1);
    expect(h.supabase.all("identity_edges")).toHaveLength(1);
    expect(l0Rows()).toHaveLength(2);
    expect(l0Rows()[0].subject_id).toBe(l0Rows()[1].subject_id);
  });

  it("subject_id は ULID の形をしていて、応答にも L0 の行にも生の識別子が出ない（E5 / PII）", async () => {
    await postChatEvent({ session_id: SESSION, action: "chat_started" });

    const row = l0Rows()[0];
    expect(String(row.subject_id)).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);

    // 冪等キーにも payload にも生のセッション ID が入っていない
    //（生の値が在ってよいのは identity_edges だけ）。
    expect(String(row.idempotency_key)).not.toContain(SESSION);
    expect(JSON.stringify(row.payload)).not.toContain(SESSION);
  });

  it("未知の action は 400 のまま（応答は変えない）。それでも L0 には積まれる（E1）", async () => {
    const res = await postChatEvent({ session_id: SESSION, action: "some_new_action" });

    // (A) 既存クライアントとの契約である応答コードは変わっていない。
    expect(res.status).toBe(400);

    // (B) 出来事は捨てられていない。語彙から漏れたことは schema_ok = false で残る。
    const rows = l0Rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("behavior.some_new_action");
    expect(rows[0].schema_ok).toBe(false);
    expect(rows[0].source).toBe("cx-agent.web-chat-event");
  });

  it("未連携の人の行動は Firestore に書けないが、**書けなかった理由が L0 に残る**（T-12）", async () => {
    // customer_linkages に行が無い = 未連携。従来はここで無言 return していた。
    await postChatEvent({ session_id: SESSION, action: "chat_started" });

    const rows = l0Rows();
    expect(rows).toHaveLength(1);
    const legacy = (rows[0].payload as { legacy_write?: { status?: string; reason?: string } })
      .legacy_write;
    expect(legacy?.status).toBe("skipped");
    // Firestore 資格情報を持たないハーメティックでは未設定が先に立つ。どちらにせよ
    // **理由が付いている**ことがこのテストの主張（無言で消えない）。
    expect(typeof legacy?.reason).toBe("string");
    expect(legacy?.reason).not.toBe("");
  });

  it("同じ出来事を 2 回受けても L0 は 1 行のまま（冪等キー = 二重加算の構造的な止め）", async () => {
    const ctx = createExecutionContext();
    const supabase = h.supabase;

    // gateway を直接呼ぶ（同じ dedupe を 2 回渡す = 「同じ現実の出来事」の再送）。
    const { recordCustomerEvent } = await import("../../src/lib/cdp/events-gateway");
    const { createSupabaseClient } = await import("../../src/lib/supabase");
    const client = createSupabaseClient(env as never);

    const fact = {
      eventType: "purchase.order_paid",
      channel: "shopify",
      identifier: { kind: "shopify_customer_id" as const, value: "7654321" },
      dedupe: "order:gid://shopify/Order/999",
      source: "cx-agent.shopify-order",
      occurredAt: "2026-08-29T00:00:00.000Z",
    };

    const first = await recordCustomerEvent(client, fact);
    const second = await recordCustomerEvent(client, fact);

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(second.reason).toBe("duplicate_idempotency_key");
    expect(supabase.all("customer_events")).toHaveLength(1);

    await waitOnExecutionContext(ctx);
  });
});
