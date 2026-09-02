/**
 * ハーメティック L1 — 送った記録の台帳の読み口が、約束どおりのものを返すこと
 * （roji タッチポイント地図 A-0 / migration 053 / POST /api/cdp/delivery/history）
 *
 * ─ なぜ要るか ─
 *
 *   この口は **じぶんのページと今月のお茶が「何が届いたか」を知る唯一の経路**に
 *   なる（web-app は Supabase クライアントを持たない）。ここが壊れると、
 *   A-1「先月への返事」が **送っていないものを送ったと言う** / **送ったものを
 *   送っていないと言う** のどちらかになる。正本が「唯一の約束の唯一の観測できる
 *   証明」と呼んでいる 1 行が、そのまま嘘になる。
 *
 *   認証が閉じていること自体は flow20 が全 CDP の口をまとめて見ている。
 *   ここで見るのは **中身**である。
 *
 * ─ 何を機械に留めるか ─
 *
 *   1. 「決めたこと」(033) と「届いたこと」(038) を 1 つの配列に畳まない
 *   2. 人を指す値（subject_id / 生の LINE userId / Shopify 顧客番号）を返さない
 *   3. 台帳の自由文（038 の note）を返さない
 *   4. 出所タグ（date_basis / source / basis）が、捏造ではなく台帳の値のまま出る
 *   5. RPC が落ちても 200 で「いま読めない」と言える（画面を落とさない）
 *   6. 語彙に無い鍵の種類は 400（要求そのものが組み立てられないときだけ 400）
 *
 * ⚠ 実ネットワーク不使用・実送信ゼロ。Supabase は RPC ごとモック。
 *   plpgsql そのものの検証は本番適用と tests/db/*.db.test.ts の役目で、
 *   ここは「口の契約が守られているか」を見る層。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";

let h: Hermetic;

const SECRET = "hermetic-mock-sync-api-secret";
const RPC = "cdp_delivery_history_for_identifier";

type MutableEnv = { SYNC_API_SECRET?: string };

/** 本番に実在しない、明らかに作り物の鍵。 */
const SHOPIFY_ID = "9999999999";
const LINE_UID = "Uffffffffffffffffffffffffffffffff";
const SUBJECT_ID = "sub_hermetic_delivery_0001";

beforeEach(() => {
  h = installHermeticFetch(env);
  h.supabase.reset();
  (env as unknown as MutableEnv).SYNC_API_SECRET = SECRET;
});

afterEach(() => {
  delete (env as unknown as MutableEnv).SYNC_API_SECRET;
  h.restore();
});

async function post(body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://example.com/api/cdp/delivery/history", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": SECRET },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** SQL 側が返す形（053 の jsonb）。2 か月ぶん・片方は割当だけ・片方は配送だけ。 */
function rpcPayload() {
  return {
    found: true,
    months: 12,
    keys: { shopify_customer_id: 1, line_messaging_uid: 1 },
    periods: [
      {
        period: "2026-10",
        assigned: {
          issue_ref: "issue-2026-10",
          teas: [
            { product_no: "11301", name: "やぶきたの上煎茶" },
            { product_no: "40201", name: "香駿の和烏龍茶" },
          ],
          basis: "assignment",
        },
        // 決めたが、まだ届いていない月（欠品・発送前）。
        delivered: [],
      },
      {
        period: "2026-09",
        // 割当の行が無い月（マルシェの手渡しだけ）。
        assigned: null,
        delivered: [
          {
            item_ref: "gid://shopify/Product/1111",
            item_name: "やぶきたのかぶせ茶",
            item_kind: "tea",
            quantity: 1,
            delivered_on: "2026-09-05",
            date_basis: "manual",
            source: "manual",
          },
        ],
      },
    ],
  };
}

describe("A-0 送付履歴の読み口 — 中身の契約", () => {
  it("決めたこと(033) と 届いたこと(038) を別のキーで返す（1 つに畳まない）", async () => {
    h.supabase.onRpc(RPC, () => ({ status: 200, body: rpcPayload() }));

    const res = await post({
      identifier_kind: "shopify_customer_id",
      identifier_value: SHOPIFY_ID,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      found: boolean;
      periods: Array<{
        period: string;
        assigned: { issue_ref: string; teas: Array<{ product_no: string }>; basis: string } | null;
        delivered: Array<{ item_ref: string; date_basis: string; source: string }>;
      }>;
    };

    expect(body.found).toBe(true);
    // 新しい月が先頭。
    expect(body.periods.map((p) => p.period)).toEqual(["2026-10", "2026-09"]);

    // 決めたが届いていない月: assigned は在り、delivered は空。
    const oct = body.periods[0];
    expect(oct.assigned?.issue_ref).toBe("issue-2026-10");
    expect(oct.assigned?.teas.map((t) => t.product_no)).toEqual(["11301", "40201"]);
    expect(oct.delivered).toEqual([]);

    // 割当の行が無い月: assigned は null で、delivered だけが在る。
    const sep = body.periods[1];
    expect(sep.assigned).toBeNull();
    expect(sep.delivered).toHaveLength(1);
  });

  it("出所タグは台帳の値のまま出る（捏造しない）", async () => {
    h.supabase.onRpc(RPC, () => ({ status: 200, body: rpcPayload() }));

    const res = await post({
      identifier_kind: "shopify_customer_id",
      identifier_value: SHOPIFY_ID,
    });
    const body = (await res.json()) as {
      periods: Array<{
        assigned: { basis: string } | null;
        delivered: Array<{ date_basis: string; source: string }>;
      }>;
    };

    // 033 由来であることの印。
    expect(body.periods[0].assigned?.basis).toBe("assignment");
    // 038 の 2 列がそのまま出る（手渡しは manual / manual）。
    expect(body.periods[1].delivered[0].date_basis).toBe("manual");
    expect(body.periods[1].delivered[0].source).toBe("manual");
  });

  it("人を指す値と自由文を 1 つも返さない", async () => {
    // SQL 側が（将来の改修ミスで）余計な列を混ぜてきても、口が素通しにしないこと。
    h.supabase.onRpc(RPC, () => ({
      status: 200,
      body: {
        ...rpcPayload(),
        // ↓ どれも返してはいけないもの。わざと混ぜる。
        subject_id: SUBJECT_ID,
        periods: [
          {
            period: "2026-09",
            assigned: null,
            delivered: [
              {
                item_ref: "gid://shopify/Product/1111",
                item_name: "やぶきたのかぶせ茶",
                item_kind: "tea",
                quantity: 1,
                delivered_on: "2026-09-05",
                date_basis: "manual",
                source: "manual",
                // 台帳の自由文と人の鍵。
                note: "9/5 マルシェで手渡し",
                shopify_customer_id: SHOPIFY_ID,
                line_user_id: LINE_UID,
                subject_id: SUBJECT_ID,
              },
            ],
          },
        ],
      },
    }));

    const res = await post({
      identifier_kind: "line_messaging_uid",
      identifier_value: LINE_UID,
    });
    const text = await res.text();

    expect(text).not.toContain(SUBJECT_ID);
    expect(text).not.toContain(LINE_UID);
    expect(text).not.toContain(SHOPIFY_ID);
    expect(text).not.toContain("マルシェで手渡し");
    // 素通しでないことの裏取り: 返してよいものは残っている。
    expect(text).toContain("2026-09-05");
    expect(text).toContain("gid://shopify/Product/1111");
  });

  it("鍵の件数だけは返る（履歴ゼロの理由を、生値を見ずに切り分けられる）", async () => {
    h.supabase.onRpc(RPC, () => ({
      status: 200,
      body: {
        found: true,
        months: 12,
        keys: { shopify_customer_id: 0, line_messaging_uid: 1 },
        periods: [],
      },
    }));

    const res = await post({
      identifier_kind: "line_messaging_uid",
      identifier_value: LINE_UID,
    });
    const body = (await res.json()) as {
      found: boolean;
      keys: { shopifyCustomerId: number; lineMessagingUid: number };
      periods: unknown[];
    };

    expect(body.found).toBe(true);
    expect(body.periods).toEqual([]);
    // EC の顧客番号が繋がっていないので 033（割当）は原理的に引けない、が読める。
    expect(body.keys).toEqual({ shopifyCustomerId: 0, lineMessagingUid: 1 });
  });

  it("主体が居なければ found:false と理由を返す（200 のまま）", async () => {
    h.supabase.onRpc(RPC, () => ({
      status: 200,
      body: { found: false, reason: "subject_not_found" },
    }));

    const res = await post({
      identifier_kind: "web_session_id",
      identifier_value: "sess-hermetic-0001",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { found: boolean; reason: string; periods: unknown[] };
    expect(body.found).toBe(false);
    expect(body.reason).toBe("subject_not_found");
    expect(body.periods).toEqual([]);
  });

  it("RPC が落ちても 200 で「いま読めない」と言える（画面を落とさない）", async () => {
    // onRpc を登録しない = mock は 404（migration 未適用と同じ見え方）。
    const res = await post({
      identifier_kind: "shopify_customer_id",
      identifier_value: SHOPIFY_ID,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { found: boolean; reason: string; periods: unknown[] };
    expect(body.found).toBe(false);
    // 「履歴が無い」ではなく「引けなかった」であることが呼び手に伝わる。
    expect(body.reason).toBe("rpc_failed");
    expect(body.periods).toEqual([]);
  });

  it("語彙に無い鍵の種類は 400（要求が組み立てられないときだけ 400）", async () => {
    h.supabase.onRpc(RPC, () => ({ status: 200, body: rpcPayload() }));

    const res = await post({ identifier_kind: "email", identifier_value: "x" });
    expect(res.status).toBe(400);
    // RPC まで到達していない。
    expect(h.supabase.rpcCalls.filter((c) => c.name === RPC)).toHaveLength(0);
  });

  it("email_hash では引かない（SEC-1）", async () => {
    h.supabase.onRpc(RPC, () => ({ status: 200, body: rpcPayload() }));

    const res = await post({
      identifier_kind: "email_hash",
      identifier_value: "0123456789abcdef0123456789abcdef",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { found: boolean; reason: string };
    expect(body.found).toBe(false);
    expect(body.reason).toBe("identifier_kind_not_resolvable");
    // 「メールが同じなら同じ人」の経路が 1 本も生えていないこと。
    expect(h.supabase.rpcCalls.filter((c) => c.name === RPC)).toHaveLength(0);
  });

  it("何も書かない（読み取り専用）", async () => {
    h.supabase.onRpc(RPC, () => ({ status: 200, body: rpcPayload() }));

    await post({ identifier_kind: "shopify_customer_id", identifier_value: SHOPIFY_ID });

    // 呼ばれた RPC は読み口の 1 本だけ。書き込み系（主体の発行・出来事の追記）に
    // 触れていない — 読むだけのつもりが主体を発行する、が起きないことの固定。
    expect(h.supabase.rpcCalls.map((c) => c.name)).toEqual([RPC]);
    expect(Object.keys(h.supabase.store)).toEqual([]);
  });
});
