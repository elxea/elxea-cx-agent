/**
 * ハーメティック L1 — 動線21: ログイン済みの人がサイトで話した内容を、LINE 側が参照する。
 *
 * ─ なぜ既存の動線20 では足りなかったか（今回の穴）─
 *
 *   flow20 は canonical 解決 RPC の戻りを **手で置いて** いた
 *   （`identifier_values: [lineUserId, webSessionId]`）。つまり「連結成分が正しく
 *   できている前提での読み出し」しか見ていない。ところが 2026-08-30 の本番で
 *   壊れていたのは **その連結成分を作る側** だった:
 *
 *     - Web のチャットは `conversations.user_id = session_id` で保存されるのに、
 *       ログイン済みの人の session_id を人に結ぶ経路が無く（結ぶのは「Web で LINE
 *       ログインした瞬間」だけ）、別タブ＝別 session の発言はどこからも辿れない。
 *     - Web 側の横断ゲートは旧台帳 `user_identity_map.line_user_id` だけを見ており、
 *       LIFF / Account Link で連携した人（＝旧台帳に行が無い）は永久に開かない。
 *     - LINE のトーク userId と LINE ログインの sub が別 kind で並置されているため、
 *       連結成分が 2 つに割れていた。
 *
 *   よってこのファイルは **鍵を手で置かない**。canonical 解決 RPC は、モック
 *   Supabase に実際に積まれた `identity_edges` / `subject_links` から連結成分を
 *   計算して返す（本物の SQL 関数と同じ意味論）。つまり「書く側が正しく書けたか」まで
 *   込みで固定する。実経路は widget → web-app proxy 相当（X-API-Key + サーバ確定
 *   identity）→ `POST /api/chat` → DB → LINE webhook → `POST /webhook/line`。
 *
 * ─ 安全 ─
 *   実ネットワーク非接触・実送信ゼロ。Anthropic と canonical RPC は本ファイル内だけで
 *   横取りする（共有ルータには足さない）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { getHermetic, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";

/** サイトのチャットで伝える好み（LINE 側には一度も書いていない）。 */
const WEB_UTTERANCE = "花の香りの紅茶が好きです。";
/** 同じ画面で続けて言う一言（自分の 2 つ前の発言を見ているかの検査に使う）。 */
const WEB_FOLLOWUP = "覚えておいて。";
/** LINE 側で好みを尋ねる発話。 */
const LINE_QUESTION = "私のお茶の好みを教えて";

/** モック LLM の定型返答（実 API 非接触）。 */
const CANNED_REPLY = "承知しました。花の香りの紅茶がお好みなのですね。";

interface CapturedLlmCall {
  system: string;
  messages: Array<{ role: string; content: unknown }>;
}

let h: Hermetic;
let llmCalls: CapturedLlmCall[];
let localFetch: typeof fetch | undefined;
let innerFetch: typeof fetch | undefined;

function flattenSystem(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((b) => (b && typeof b === "object" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
}

function flattenMessages(messages: CapturedLlmCall["messages"]): string {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (!Array.isArray(m.content)) return "";
      return m.content
        .map((p) => (p && typeof p === "object" ? String((p as { text?: unknown }).text ?? "") : ""))
        .join("");
    })
    .join("\n");
}

function anthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_e2e_flow21",
      type: "message",
      role: "assistant",
      model: "claude-mock",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// canonical 解決 RPC — **モックの中身から計算する**（手で置かない）
// ---------------------------------------------------------------------------

interface EdgeRow {
  subject_id: string;
  identifier_kind: string;
  identifier_value: string;
}
interface LinkRow {
  subject_a: string;
  subject_b: string;
}

/**
 * `cdp_canonical_identifiers`（migration 043）と同じ意味論をインメモリで再現する。
 *
 * 種の (kind, value) から主体を引き、`subject_links` を無向辺として連結成分を辿り、
 * その成分に属する全 edge の識別子の生値を返す。**テストが鍵を先回りして置かない**
 * ことがこのファイルの要点なので、ここは必ず store から計算する。
 */
function canonicalFromStore(
  kind: string,
  value: string,
  maxRefs: number,
): Record<string, unknown> {
  if (kind === "email_hash") return { found: false, reason: "identifier_kind_not_resolvable" };

  const edges = h.supabase.all("identity_edges") as unknown as EdgeRow[];
  const links = h.supabase.all("subject_links") as unknown as LinkRow[];

  const seed = edges.find((e) => e.identifier_kind === kind && e.identifier_value === value);
  if (!seed) return { found: false, reason: "not_found" };

  const adjacency = new Map<string, string[]>();
  for (const l of links) {
    (adjacency.get(l.subject_a) ?? adjacency.set(l.subject_a, []).get(l.subject_a)!).push(l.subject_b);
    (adjacency.get(l.subject_b) ?? adjacency.set(l.subject_b, []).get(l.subject_b)!).push(l.subject_a);
  }

  const seen = new Set<string>([seed.subject_id]);
  const queue = [seed.subject_id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  const linkCount = links.filter((l) => seen.has(l.subject_a) && seen.has(l.subject_b)).length;
  const values = [...new Set(edges.filter((e) => seen.has(e.subject_id)).map((e) => e.identifier_value))];

  return {
    found: true,
    canonical_id: [...seen].sort()[0],
    member_count: seen.size,
    link_count: linkCount,
    identifier_values: values.slice(0, maxRefs),
    identifier_total: values.length,
    truncated: values.length > maxRefs,
  };
}

beforeEach(() => {
  h = getHermetic();
  llmCalls = [];

  const inner = globalThis.fetch;
  innerFetch = inner;
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

    if (url.includes("/rest/v1/rpc/cdp_canonical_identifiers")) {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      return new Response(
        JSON.stringify(
          canonicalFromStore(
            String(body.p_kind ?? ""),
            String(body.p_value ?? ""),
            Number(body.p_max_refs ?? 50),
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("api.anthropic.com")) {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      llmCalls.push({
        system: flattenSystem(body.system),
        messages: Array.isArray(body.messages) ? (body.messages as CapturedLlmCall["messages"]) : [],
      });
      return anthropicResponse(CANNED_REPLY);
    }

    return inner(input, init);
  }) as typeof fetch;

  localFetch = wrapper;
  globalThis.fetch = wrapper;
});

afterEach(() => {
  if (localFetch !== undefined && innerFetch !== undefined && globalThis.fetch === localFetch) {
    globalThis.fetch = innerFetch;
  }
  localFetch = undefined;
  innerFetch = undefined;
});

// ---------------------------------------------------------------------------
// 実経路のドライバ
// ---------------------------------------------------------------------------

/**
 * web-app の proxy（`app/api/chat/route.ts`）が cx-agent に投げるのと同じ形の
 * リクエストを 1 本流す。
 *
 * `trusted` が true のときだけ X-API-Key とサーバ確定 identity を載せる
 * （＝ブラウザ直叩きとの違いをテストの中で作れるようにする）。
 */
async function sayOnWeb(opts: {
  sessionId: string;
  text: string;
  trusted: boolean;
  shopifyCustomerId?: string;
  lineUserId?: string;
}): Promise<number> {
  const body: Record<string, unknown> = { message: opts.text, session_id: opts.sessionId };
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (opts.trusted) {
    headers["X-API-Key"] = String(env.SYNC_API_SECRET);
    if (opts.shopifyCustomerId) body.shopify_customer_id = opts.shopifyCustomerId;
    if (opts.lineUserId) body.line_user_id = opts.lineUserId;
  }

  const request = new Request("https://elxea-agent.e2e.local/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  // SSE 本文を読み切ってからでないとストリーミング側の onDone（保存）が走らない。
  await res.text();
  await waitOnExecutionContext(ctx);
  await settle();
  return res.status;
}

/** LINE の 1 発話を実 webhook 経路で流す。 */
async function sayOnLine(userId: string, text: string): Promise<void> {
  const res = await dispatchLineWebhook({
    env,
    channelSecret: String(env.LINE_CHANNEL_SECRET),
    events: [messageEvent(userId, text)],
  });
  expect(res.status, "webhook が 200 で受理されていない").toBe(200);
  await settle();
}

/**
 * LIFF 連携が済んでいる人の状態を作る（本番と同じ形）。
 *
 * ⚠ `user_identity_map` には **わざと行を入れない**。LIFF / Account Link で連携した人は
 *   旧台帳に行が無い（customer_linkages と subject_links にしかない）。これが
 *   「ログイン済みなのに Web 側の横断ゲートが開かない」の再現条件そのもの。
 */
function seedLiffLinkedPerson(lineUserId: string, shopifyNumericId: string): void {
  h.supabase.seed("subjects", [{ subject_id: "01E2E00000000000000000000A" }, { subject_id: "01E2E00000000000000000000B" }]);
  h.supabase.seed("identity_edges", [
    {
      subject_id: "01E2E00000000000000000000A",
      identifier_kind: "line_messaging_uid",
      identifier_value: lineUserId,
      observed_by: "e2e-seed",
    },
    {
      subject_id: "01E2E00000000000000000000B",
      identifier_kind: "shopify_customer_id",
      identifier_value: shopifyNumericId,
      observed_by: "e2e-seed",
    },
  ]);
  h.supabase.seed("subject_links", [
    {
      subject_a: "01E2E00000000000000000000A",
      subject_b: "01E2E00000000000000000000B",
      basis: "liff_id_token",
      observed_by: "e2e-seed",
    },
  ]);
}

/** LINE ログインだけで連携している人（Shopify 顧客を持たない）。 */
function seedLineMessagingOnly(lineUserId: string): void {
  h.supabase.seed("subjects", [{ subject_id: "01E2E00000000000000000000C" }]);
  h.supabase.seed("identity_edges", [
    {
      subject_id: "01E2E00000000000000000000C",
      identifier_kind: "line_messaging_uid",
      identifier_value: lineUserId,
      observed_by: "e2e-seed",
    },
  ]);
}

/** LINE 側の呼び出しで Anthropic に渡ったプロンプト（最後の 1 件）。 */
function lastPrompt(): string {
  expect(llmCalls.length, "Anthropic が一度も呼ばれていない（AI 会話に到達していない）").toBeGreaterThan(0);
  return flattenMessages(llmCalls[llmCalls.length - 1].messages);
}

describe("hermetic L1 — 動線21: Web で話したことを LINE が参照する（実経路）", () => {
  it("ログイン済みの人の Web 発言が、初対面の session でも LINE 側の文脈に入る", async () => {
    const lineUserId = synthLineUserId("f21a");
    const shopifyNumericId = "9876543210001";
    // ブラウザが持つ会話 ID。**どの台帳にも登場していない新品**（別タブ / 別日 = 本番の状況）。
    const webSessionId = "11111111-2222-4333-8444-555555555001";

    seedLiffLinkedPerson(lineUserId, shopifyNumericId);

    // 1) サイトのチャット（web-app proxy 経由 = 信頼経路 + サーバ確定 identity）。
    const status = await sayOnWeb({
      sessionId: webSessionId,
      text: WEB_UTTERANCE,
      trusted: true,
      shopifyCustomerId: `gid://shopify/Customer/${shopifyNumericId}`,
      lineUserId,
    });
    expect(status, "Web チャットが 200 で受理されていない").toBe(200);

    // 発言が実際に保存されていること（保存の鍵は session_id）。
    const stored = h.supabase.all("conversations") as unknown as Array<Record<string, unknown>>;
    expect(
      stored.some((r) => r.channel === "web" && r.content === WEB_UTTERANCE),
      "Web の発言が conversations に保存されていない",
    ).toBe(true);

    // この session が「本人の鍵」として連結成分に載っていること（＝今回の本丸）。
    const edges = h.supabase.all("identity_edges") as unknown as EdgeRow[];
    expect(
      edges.some((e) => e.identifier_kind === "web_session_id" && e.identifier_value === webSessionId),
      "web session が主体として登録されていない（LINE から辿れない）",
    ).toBe(true);
    const component = canonicalFromStore("line_messaging_uid", lineUserId, 50);
    expect(
      (component.identifier_values as string[]) ?? [],
      "LINE の連結成分に web session が入っていない（ここが切れると LINE から永久に見えない）",
    ).toContain(webSessionId);

    // 2) LINE 公式で好みを尋ねる（署名付き実 webhook）。
    llmCalls = [];
    await sayOnLine(lineUserId, LINE_QUESTION);

    expect(lastPrompt(), "LINE 側の文脈に Web の発言が入っていない").toContain(WEB_UTTERANCE);
  });

  it("ネガティブ対照 — ブラウザ直叩き（X-API-Key 無し）の発言は LINE 側に出ない（SEC-3 fail-closed）", async () => {
    const lineUserId = synthLineUserId("f21b");
    const shopifyNumericId = "9876543210002";
    const webSessionId = "11111111-2222-4333-8444-555555555002";

    seedLiffLinkedPerson(lineUserId, shopifyNumericId);

    // ブラウザが自分で customer_id / line_user_id を名乗っても、鍵が無ければ無視される。
    await sayOnWeb({
      sessionId: webSessionId,
      text: WEB_UTTERANCE,
      trusted: false,
      shopifyCustomerId: `gid://shopify/Customer/${shopifyNumericId}`,
      lineUserId,
    });

    const edges = h.supabase.all("identity_edges") as unknown as EdgeRow[];
    expect(
      edges.some(
        (e) =>
          e.identifier_kind === "web_session_id" &&
          e.identifier_value === webSessionId &&
          e.observed_by === "web-chat",
      ),
      "信頼経路でないのに web session が本人の鍵として登録されている（なりすまし経路）",
    ).toBe(false);

    llmCalls = [];
    await sayOnLine(lineUserId, LINE_QUESTION);

    expect(
      lastPrompt(),
      "未検証の発言が LINE 側の文脈に混ざっている（SEC-3 の fail-closed が壊れている）",
    ).not.toContain(WEB_UTTERANCE);
  });

  it("ネガティブ対照 — 共有鍵はあるが本人が確定していない呼び出しでは横断しない (SEC-3)", async () => {
    /* proxy は session_id の**所有**を検証しない（ブラウザの cookie をそのまま渡す）。
       よって「共有鍵がある」だけで横断を開くと、ログアウト中のブラウザが他人の
       session_id を送るだけでその人の横断履歴に届く。本人 ID（顧客番号 or LINE
       userId）がサーバで確定していることまでを条件にする。 */
    const lineUserId = synthLineUserId("f21e");
    const shopifyNumericId = "9876543210005";
    const webSessionId = "11111111-2222-4333-8444-555555555005";

    seedLiffLinkedPerson(lineUserId, shopifyNumericId);

    // 本人の発言を先に作り、この session を本人の鍵として成分に載せる。
    await sayOnWeb({
      sessionId: webSessionId,
      text: WEB_UTTERANCE,
      trusted: true,
      shopifyCustomerId: `gid://shopify/Customer/${shopifyNumericId}`,
    });

    // LINE 側に、web からは見えてはいけない発言を残す。
    h.supabase.seed("conversations", [
      {
        user_id: lineUserId,
        channel: "line",
        role: "user",
        content: "LINE でしか話していない秘密の一言",
        created_at: "2026-08-01T00:30:00Z",
      },
    ]);

    // 共有鍵はあるが identity を名乗らない呼び出し（= 誰として話しているか不明）。
    llmCalls = [];
    await sayOnWeb({ sessionId: webSessionId, text: WEB_FOLLOWUP, trusted: true });

    expect(
      lastPrompt(),
      "本人が確定していない呼び出しに LINE 側の履歴が出ている（session_id を知っているだけで開いている）",
    ).not.toContain("LINE でしか話していない秘密の一言");
  });

  it("ネガティブ対照 — 他人が持ち主の session_id を送っても、和されず・書き込まれない (SEC-3 書き込み側)", async () => {
    /* proxy は session_id の所有を検証しない（ブラウザの cookie をそのまま転送する）。
       よってログイン済みの A が他人 B の session_id を送れる。確かめずに進むと
         (1) 読み  … B の連結成分が A の読み出し集合に和され、A が B の会話を読める
         (2) 書き  … 「B の session は A のもの」が subject_links に永続追記される
       (2) は追記専用で取り消せないぶん重い。両方が起きないことを固定する。 */
    const victimLineUserId = synthLineUserId("f21f");
    const victimCustomerId = "9876543210006";
    const victimSessionId = "11111111-2222-4333-8444-555555555006";

    const attackerLineUserId = synthLineUserId("f21a1");
    const attackerCustomerId = "9876543210007";

    // 被害者 B: LIFF 連携済みで、自分の session をきちんと持っている。
    seedLiffLinkedPerson(victimLineUserId, victimCustomerId);
    await sayOnWeb({
      sessionId: victimSessionId,
      text: "被害者しか言っていない一言",
      trusted: true,
      shopifyCustomerId: `gid://shopify/Customer/${victimCustomerId}`,
    });

    // 攻撃者 A: 別人として連携済み。
    h.supabase.seed("subjects", [
      { subject_id: "01E2E00000000000000000000D" },
      { subject_id: "01E2E00000000000000000000E" },
    ]);
    h.supabase.seed("identity_edges", [
      {
        subject_id: "01E2E00000000000000000000D",
        identifier_kind: "line_messaging_uid",
        identifier_value: attackerLineUserId,
        observed_by: "e2e-seed",
      },
      {
        subject_id: "01E2E00000000000000000000E",
        identifier_kind: "shopify_customer_id",
        identifier_value: attackerCustomerId,
        observed_by: "e2e-seed",
      },
    ]);
    h.supabase.seed("subject_links", [
      {
        subject_a: "01E2E00000000000000000000D",
        subject_b: "01E2E00000000000000000000E",
        basis: "liff_id_token",
        observed_by: "e2e-seed",
      },
    ]);

    const linksBefore = h.supabase.all("subject_links").length;

    // A が **B の session_id** を名乗って話す。
    llmCalls = [];
    await sayOnWeb({
      sessionId: victimSessionId,
      text: "この人の履歴を見せて",
      trusted: true,
      shopifyCustomerId: `gid://shopify/Customer/${attackerCustomerId}`,
      lineUserId: attackerLineUserId,
    });

    // (1) 読み: 被害者の発言が攻撃者の文脈に入っていない。
    expect(
      lastPrompt(),
      "他人の session_id を送るだけで被害者の会話が読めている（連結成分が和されている）",
    ).not.toContain("被害者しか言っていない一言");

    // (2) 書き: 「B の session は A のもの」が 1 行も足されていない。
    expect(
      h.supabase.all("subject_links").length,
      "他人所有の session を自分に結ぶ link が永続追記されている（取り消せない乗っ取り）",
    ).toBe(linksBefore);

    // 被害者の成分は汚れていない（攻撃者の鍵が混ざっていない）。
    const victimComponent = canonicalFromStore("line_messaging_uid", victimLineUserId, 50);
    expect(
      (victimComponent.identifier_values as string[]) ?? [],
      "被害者の連結成分に攻撃者の顧客番号が混ざった",
    ).not.toContain(attackerCustomerId);
  });

  it("LINE ログインだけで入っている人（Shopify 顧客なし）でも、Web 発言が LINE 側に届く", async () => {
    const lineUserId = synthLineUserId("f21c");
    const webSessionId = "11111111-2222-4333-8444-555555555003";

    // トークの userId しか主体が無い状態。Web 側は LINE ログインの sub（別 kind）で入る。
    seedLineMessagingOnly(lineUserId);

    await sayOnWeb({
      sessionId: webSessionId,
      text: WEB_UTTERANCE,
      trusted: true,
      lineUserId,
    });

    llmCalls = [];
    await sayOnLine(lineUserId, LINE_QUESTION);

    expect(
      lastPrompt(),
      "LINE ログインだけの人の Web 発言が LINE 側に届いていない（kind の割れが直っていない）",
    ).toContain(WEB_UTTERANCE);
  });

  it("同じ画面の続きの発言で、直前の自分の発言が文脈に入る（書いた鍵と読む鍵のずれ）", async () => {
    const lineUserId = synthLineUserId("f21d");
    const shopifyNumericId = "9876543210004";
    const webSessionId = "11111111-2222-4333-8444-555555555004";

    seedLiffLinkedPerson(lineUserId, shopifyNumericId);

    await sayOnWeb({
      sessionId: webSessionId,
      text: WEB_UTTERANCE,
      trusted: true,
      shopifyCustomerId: `gid://shopify/Customer/${shopifyNumericId}`,
      lineUserId,
    });

    llmCalls = [];
    await sayOnWeb({
      sessionId: webSessionId,
      text: WEB_FOLLOWUP,
      trusted: true,
      shopifyCustomerId: `gid://shopify/Customer/${shopifyNumericId}`,
      lineUserId,
    });

    expect(
      lastPrompt(),
      "同じ session の 1 つ前の発言が文脈に入っていない（毎ターン履歴 0 件になる退行）",
    ).toContain(WEB_UTTERANCE);
  });
});
