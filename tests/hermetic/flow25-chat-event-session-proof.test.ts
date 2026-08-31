/**
 * ハーメティック L1 — 動線25: 行動ログの口を「誰でも名乗れる」から閉じる。
 *
 * ─ 何が開いていたか ─
 *
 *   PR #60 / #182 で `/api/chat`・`/api/chat/history`・`/api/identity/link-line` は
 *   `session_id` の署名（`src/lib/chat-session.ts`）を必須にした。ところが
 *   **`/api/chat/event` だけが素通し**のまま残っていた（QA 指摘・既存挙動）。
 *
 *   この口は `session_id` を鍵にして L0（customer_events）へ出来事を積む。つまり
 *   他人の `session_id` を body に入れるだけで **他人の行動ログに書き込める**。
 *   行動ログは L1（好みタイプ・セグメント）に畳まれ、配信の宛先を決めるので、
 *   他人の入力でその人の分類と配信が動く。
 *
 * ─ このファイルが固定すること ─
 *
 *   1. 署名なし          → 積まれない（主体も辺も L0 も 1 行も増えない）
 *   2. 偽署名            → 積まれない
 *   3. 信頼経路でない     → 積まれない（X-API-Key 無しは本番に存在しない経路）
 *   4. 正しい署名        → 従来どおり積まれる（締め付けが機能を殺していない）
 *   5. サーバ確定の顧客 ID があるとき → 署名が無くても積まれる。ただし鍵は
 *      **顧客 ID** であって、名乗られた session_id ではない
 *      （共有鍵のずれでログイン済みの人の行動ログが全滅しないための逃げ道。
 *        他人の session を指しようがないので穴にはならない）
 *   6. `CHAT_SESSION_SECRET` 未設定（移行モード）→ **この変更以前と同じ挙動**
 *   7. 拒否しても「使い捨て session を発行して積む」ことはしない
 *      （＝ 外から叩くだけで孤立主体を量産できる形にしない。2026-08-30 に本番の
 *        identity_edges に実際にできた孤立行と同じ壊れ方をこちらから作らない）
 *   8. 未知の action（語彙違反）の口も同じゲートの内側にある
 *      （E1 の「捨てない」を、他人の鍵に書く抜け道にしない）
 *
 * ─ 安全 ─
 *   実ネットワーク非接触・実送信ゼロ。Supabase はモック。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { getHermetic, type Hermetic } from "../lib/hermetic";
import { signSessionId } from "../../src/lib/chat-session";

let h: Hermetic;

beforeEach(() => {
  h = getHermetic();
  h.supabase.reset();
});

/** validateSessionId が UUID v4 を要求するため、形の合う固定値を使う。 */
const VICTIM_SESSION = "5c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e01";
const OWN_SESSION = "5c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e02";
const CUSTOMER_GID = "gid://shopify/Customer/8811223344555";
const CUSTOMER_NUMERIC = "8811223344555";

interface PostOptions {
  sessionId: string;
  action?: string;
  /** `undefined` = 正しい署名を付ける / `null` = 署名を付けない / 文字列 = その値を付ける。 */
  proof?: string | null;
  /** X-API-Key を付けるか（既定: 付ける = web-app proxy 経由）。 */
  trusted?: boolean;
  shopifyCustomerId?: string;
  /** env の一時上書き（移行モードの検査に使う）。 */
  envOverride?: Record<string, unknown>;
}

async function postChatEvent(opts: PostOptions): Promise<Response> {
  const body: Record<string, unknown> = {
    session_id: opts.sessionId,
    action: opts.action ?? "chat_started",
  };
  const proof =
    opts.proof === undefined
      ? await signSessionId(opts.sessionId, String(env.CHAT_SESSION_SECRET))
      : opts.proof;
  if (proof !== null) body.session_proof = proof;
  if (opts.shopifyCustomerId) body.shopify_customer_id = opts.shopifyCustomerId;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.trusted !== false) headers["X-API-Key"] = String(env.SYNC_API_SECRET);

  const effectiveEnv = opts.envOverride ? { ...env, ...opts.envOverride } : env;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://elxea-agent.e2e.local/api/chat/event", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    effectiveEnv as typeof env,
    ctx,
  );
  // fire-and-forget（waitUntil）の書き込みを待ってから数える。
  await waitOnExecutionContext(ctx);
  return res;
}

function l0(): Array<Record<string, unknown>> {
  return h.supabase.all("customer_events");
}
function subjects(): Array<Record<string, unknown>> {
  return h.supabase.all("subjects");
}
function edges(): Array<Record<string, unknown>> {
  return h.supabase.all("identity_edges");
}

describe("hermetic L1 — 動線25: 行動ログの口に session の署名を要求する", () => {
  it("正しい署名なら従来どおり積まれる（締め付けが機能を殺していない）", async () => {
    const res = await postChatEvent({ sessionId: OWN_SESSION });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(l0()).toHaveLength(1);
    expect(l0()[0].event_type).toBe("behavior.chat_started");
    expect(edges()).toHaveLength(1);
    expect(edges()[0].identifier_kind).toBe("web_session_id");
    expect(edges()[0].identifier_value).toBe(OWN_SESSION);
  });

  it("署名なしで他人の session_id を名乗っても、その人の行動ログに 1 行も入らない", async () => {
    const res = await postChatEvent({ sessionId: VICTIM_SESSION, proof: null });

    // 応答コードは変えない（fire-and-forget の契約）。ただし積まなかったことは言う。
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      recorded: false,
      reason: "session_not_proven",
    });

    expect(l0(), "他人の session の L0 に行が積まれた").toHaveLength(0);
    expect(edges(), "他人の session が identity_edges に登録された").toHaveLength(0);
  });

  it("偽の署名でも積まれない（『署名フィールドがあれば通る』になっていない）", async () => {
    const wrong = await signSessionId(OWN_SESSION, String(env.CHAT_SESSION_SECRET));
    // 自分の session に対する正しい署名を、被害者の session_id に付け替える。
    const res = await postChatEvent({ sessionId: VICTIM_SESSION, proof: wrong });

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ recorded: false });
    expect(l0()).toHaveLength(0);
    expect(edges()).toHaveLength(0);
  });

  it("信頼経路（X-API-Key）でなければ、署名が正しくても積まれない", async () => {
    // 本番のブラウザは web-app の proxy 越しにしか来ない。鍵無しで届く呼び出しは
    // 誰でも作れるので、session_id の真正性を確かめる手前で落とす。
    const res = await postChatEvent({ sessionId: OWN_SESSION, trusted: false });

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ recorded: false });
    expect(l0()).toHaveLength(0);
  });

  it("拒否しても使い捨ての主体を発行しない（外から叩くだけで孤立主体を量産できない）", async () => {
    for (let i = 0; i < 5; i++) {
      await postChatEvent({ sessionId: VICTIM_SESSION, proof: null });
    }

    expect(subjects(), "拒否のたびに主体が発行されている（孤立主体の量産）").toHaveLength(0);
    expect(edges()).toHaveLength(0);
    expect(l0()).toHaveLength(0);
  });

  it("サーバ確定の顧客 ID があるときは、署名が無くても顧客 ID を鍵にして積む", async () => {
    // 共有鍵が片側だけずれた日に、ログイン済みの人の行動ログまで全滅させないための枝。
    // 鍵はサーバ側で確定した顧客 ID なので、他人の session を指しようがない。
    const res = await postChatEvent({
      sessionId: VICTIM_SESSION,
      proof: null,
      shopifyCustomerId: CUSTOMER_GID,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(l0()).toHaveLength(1);
    expect(edges()).toHaveLength(1);
    // 顧客番号は数値へ正規化され、**web_session_id ではなく** shopify_customer_id に入る
    //（2026-08-30 に本番でできた孤立行と同じ形を作らない）。
    expect(edges()[0].identifier_kind).toBe("shopify_customer_id");
    expect(edges()[0].identifier_value).toBe(CUSTOMER_NUMERIC);
    // 名乗られた被害者の session_id はどこにも登録されない。
    expect(
      edges().some((e) => e.identifier_value === VICTIM_SESSION),
      "名乗られた session_id が鍵として登録された",
    ).toBe(false);
  });

  it("CHAT_SESSION_SECRET 未設定（移行モード）では、この変更以前と同じ挙動になる", async () => {
    // 鍵が 4 箇所に行き渡る前にこのコードが本番に出ることを前提にした逃げ道
    //（lib/chat-session.ts の移行モードと同じ判断）。露出は以前と同じで、増えない。
    const res = await postChatEvent({
      sessionId: OWN_SESSION,
      proof: null,
      envOverride: { CHAT_SESSION_SECRET: undefined },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(l0()).toHaveLength(1);
    expect(edges()).toHaveLength(1);
    expect(edges()[0].identifier_value).toBe(OWN_SESSION);
  });

  it("未知の action（語彙違反）の口も同じゲートの内側にある", async () => {
    // E1「出来事は捨てない」は、他人の鍵に書き込む抜け道であってはならない。
    const rejected = await postChatEvent({
      sessionId: VICTIM_SESSION,
      action: "some_new_action",
      proof: null,
    });

    // 応答コードは 400 のまま（既存クライアントとの契約）。
    expect(rejected.status).toBe(400);
    expect(l0(), "署名なしでも語彙違反の記録として L0 に行が作れてしまう").toHaveLength(0);
    expect(edges()).toHaveLength(0);

    // 対照: 署名があれば E1 のとおり schema_ok = false で積まれる（機能は残っている）。
    const accepted = await postChatEvent({ sessionId: OWN_SESSION, action: "some_new_action" });
    expect(accepted.status).toBe(400);
    expect(l0()).toHaveLength(1);
    expect(l0()[0].schema_ok).toBe(false);
  });
});
