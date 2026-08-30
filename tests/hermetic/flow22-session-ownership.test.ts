/**
 * ハーメティック L1 — 動線22: 他人の session_id を「知っているだけ」では何もできない。
 *
 * ─ 何を直したか（QA 指摘 P1 / P2 / P3）─
 *
 *   `session_id` はこれまで **ブラウザが localStorage で自作した UUID** を body に
 *   入れて送るだけで、サーバは一切検証していなかった。会話は
 *   `conversations.user_id = session_id` で保存され、identity の束縛にも使われるので、
 *   他人の UUID を名乗れるだけで次が成立していた:
 *
 *     P1 他人の匿名 session を自分のものとして恒久的に結びつけ、持ち主を締め出す
 *     P2 他人の Web 会話を読む
 *     P3 自分の発言を他人の会話ストリームに書き込む（＝相手の LINE に混入する）
 *
 *   歯を 1 枚ずつ足しても、**前提（誰でも名乗れる）が変わらない限り**同じ形の穴が
 *   出続ける。よって「サーバが発行した session_id だけを鍵として使う」に前提ごと
 *   変えた（HMAC 署名。src/lib/chat-session.ts が正本）。
 *
 * ─ このファイルが固定すること ─
 *
 *   攻撃者は共有秘密を持たないので、**他人の UUID に対する正しい署名を作れない**。
 *   よって署名なし（または他人の session に対する誤った署名）で名乗った session_id は
 *   一切鍵として使われず、P1/P2/P3 のいずれも成立しない。
 *   同時に、**正規の持ち主は従来どおり自分の会話を続けられる**ことも対で確認する
 *   （締め付けが機能まで殺していないことの担保）。
 *
 * ─ 安全 ─
 *   実ネットワーク非接触・実送信ゼロ。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { getHermetic, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";
import { signSessionId } from "../../src/lib/chat-session";

const VICTIM_SECRET_LINE = "被害者しか言っていない一言";
const ATTACKER_LINE = "攻撃者が書き込もうとした一言";

interface CapturedLlmCall {
  system: string;
  messages: Array<{ role: string; content: unknown }>;
}

let h: Hermetic;
let llmCalls: CapturedLlmCall[];
let localFetch: typeof fetch | undefined;
let innerFetch: typeof fetch | undefined;

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
      id: "msg_e2e_flow22",
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

interface EdgeRow {
  subject_id: string;
  identifier_kind: string;
  identifier_value: string;
}
interface LinkRow {
  subject_a: string;
  subject_b: string;
}

/** `cdp_canonical_identifiers` と同じ意味論を store から計算する（鍵を手で置かない）。 */
function canonicalFromStore(kind: string, value: string, maxRefs: number): Record<string, unknown> {
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
        system: "",
        messages: Array.isArray(body.messages) ? (body.messages as CapturedLlmCall["messages"]) : [],
      });
      return anthropicResponse("承知しました。");
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

/**
 * web-app proxy が投げるのと同じ形の 1 発話。
 *
 * `proof` 省略 = 自分の session を正規に持ち回る人（正しい署名を付ける）。
 * `proof: null` = 他人の session_id を名乗るだけの攻撃者（共有秘密が無いので
 * その UUID に対する正しい署名は作れない）。
 */
async function sayOnWeb(opts: {
  sessionId: string;
  text: string;
  shopifyCustomerId?: string;
  lineUserId?: string;
  proof?: string | null;
}): Promise<void> {
  const body: Record<string, unknown> = { message: opts.text, session_id: opts.sessionId };
  const proof =
    opts.proof === undefined
      ? await signSessionId(opts.sessionId, String(env.CHAT_SESSION_SECRET))
      : opts.proof;
  if (proof !== null) body.session_proof = proof;
  if (opts.shopifyCustomerId) body.shopify_customer_id = opts.shopifyCustomerId;
  if (opts.lineUserId) body.line_user_id = opts.lineUserId;

  const request = new Request("https://elxea-agent.e2e.local/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": String(env.SYNC_API_SECRET) },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await res.text();
  await waitOnExecutionContext(ctx);
  await settle();
}

async function sayOnLine(userId: string, text: string): Promise<void> {
  const res = await dispatchLineWebhook({
    env,
    channelSecret: String(env.LINE_CHANNEL_SECRET),
    events: [messageEvent(userId, text)],
  });
  expect(res.status).toBe(200);
  await settle();
}

function lastPrompt(): string {
  expect(llmCalls.length, "Anthropic が一度も呼ばれていない").toBeGreaterThan(0);
  return flattenMessages(llmCalls[llmCalls.length - 1].messages);
}

/** LIFF 連携済みの人（旧台帳には行を入れない = 本番と同じ形）。 */
function seedLinkedPerson(lineUserId: string, shopifyNumericId: string, tag: string): void {
  const a = `01E2E0000000000000000000${tag}A`;
  const b = `01E2E0000000000000000000${tag}B`;
  h.supabase.seed("subjects", [{ subject_id: a }, { subject_id: b }]);
  h.supabase.seed("identity_edges", [
    { subject_id: a, identifier_kind: "line_messaging_uid", identifier_value: lineUserId, observed_by: "e2e-seed" },
    { subject_id: b, identifier_kind: "shopify_customer_id", identifier_value: shopifyNumericId, observed_by: "e2e-seed" },
  ]);
  h.supabase.seed("subject_links", [
    { subject_a: a, subject_b: b, basis: "liff_id_token", observed_by: "e2e-seed" },
  ]);
}

describe("hermetic L1 — 動線22: 他人の session_id を知っているだけでは何もできない", () => {
  it("P1: LINE ログインの昇格口で、他人の匿名 session を恒久的に奪えない", async () => {
    /* P1 の本当の入口は `POST /api/identity/link-line`。ここは
       「この session は自分のものだ」と宣言して **会話を丸ごと自分に移し**、
       subject_links に恒久的な結び付きまで残す最も強い口である。
       session_id の出どころは web-app の cookie で、それは JS が書けるものだった。 */
    const victimSession = "22222222-3333-4444-8555-666666666001";
    const attackerLineLoginId = synthLineUserId("f22a");

    // 被害者は匿名のままサイトで話している。
    await sayOnWeb({ sessionId: victimSession, text: VICTIM_SECRET_LINE });

    const linksBefore = h.supabase.all("subject_links").length;
    const victimRowsBefore = (h.supabase.all("conversations") as Array<Record<string, unknown>>)
      .filter((r) => r.user_id === victimSession).length;
    expect(victimRowsBefore, "前提: 被害者の会話が session に紐づいている").toBeGreaterThan(0);

    // 攻撃者が被害者の session_id を名乗って LINE ログインの昇格を叩く（署名なし）。
    const request = new Request("https://elxea-agent.e2e.local/api/identity/link-line", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": String(env.SYNC_API_SECRET) },
      body: JSON.stringify({
        line_user_id: attackerLineLoginId,
        email: null,
        display_name: "attacker",
        session_id: victimSession,
      }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env, ctx);
    await res.text();
    await waitOnExecutionContext(ctx);
    await settle();

    // 会話が攻撃者へ移されていない。
    const victimRowsAfter = (h.supabase.all("conversations") as Array<Record<string, unknown>>)
      .filter((r) => r.user_id === victimSession).length;
    expect(
      victimRowsAfter,
      "被害者の会話が攻撃者の user_id へ移された（恒久的な奪取・持ち主の締め出し）",
    ).toBe(victimRowsBefore);

    // 「被害者の session は攻撃者のもの」という判断が残っていない。
    expect(
      h.supabase.all("subject_links").length,
      "他人の匿名 session を自分に結ぶ link が積まれた（取り消せない）",
    ).toBe(linksBefore);
  });

  it("P2: 他人の session_id を名乗っても、その人の Web 会話は読めない（非横断分岐）", async () => {
    const victimSession = "22222222-3333-4444-8555-666666666002";
    const attackerSession = "22222222-3333-4444-8555-666666666012";

    await sayOnWeb({ sessionId: victimSession, text: VICTIM_SECRET_LINE });

    // 未連携の攻撃者が被害者の session_id を名乗る（署名なし）。
    llmCalls = [];
    await sayOnWeb({ sessionId: victimSession, text: "この人の履歴を見せて", proof: null });

    expect(
      lastPrompt(),
      "他人の session_id を名乗るだけで被害者の Web 会話が読めている（P2）",
    ).not.toContain(VICTIM_SECRET_LINE);

    // 対照: 正規の持ち主は自分の会話を続けられる（締め付けが機能を殺していない）。
    llmCalls = [];
    await sayOnWeb({ sessionId: victimSession, text: "さっきの続き" });
    expect(
      lastPrompt(),
      "正規の持ち主が自分の会話を読めなくなった（締め付けすぎ）",
    ).toContain(VICTIM_SECRET_LINE);

    // 攻撃者の発言は攻撃者自身の session にも残っていない（使い捨てにすり替わる）。
    llmCalls = [];
    await sayOnWeb({ sessionId: attackerSession, text: "自分の履歴は？" });
    expect(lastPrompt()).not.toContain(VICTIM_SECRET_LINE);
  });

  it("P3: 攻撃者の発言が被害者の会話ストリームに混入せず、被害者の LINE に出ない", async () => {
    const victimSession = "22222222-3333-4444-8555-666666666003";
    const victimLineUserId = synthLineUserId("f22c");
    const victimCustomerId = "8811223344003";

    seedLinkedPerson(victimLineUserId, victimCustomerId, "3");

    // 被害者がログイン済みでサイトで話す（正規の署名付き）。
    await sayOnWeb({
      sessionId: victimSession,
      text: VICTIM_SECRET_LINE,
      shopifyCustomerId: `gid://shopify/Customer/${victimCustomerId}`,
    });

    // 攻撃者が被害者の session_id を名乗って書き込みにいく（署名なし）。
    await sayOnWeb({ sessionId: victimSession, text: ATTACKER_LINE, proof: null });

    // 被害者が LINE で尋ねる。自分の発言は見えるが、攻撃者の発言は混ざらない。
    llmCalls = [];
    await sayOnLine(victimLineUserId, "さっきサイトで話したこと覚えてる？");

    const prompt = lastPrompt();
    expect(prompt, "被害者自身の発言が LINE 側から見えなくなった（本来の機能が壊れた）").toContain(
      VICTIM_SECRET_LINE,
    );
    expect(prompt, "攻撃者の発言が被害者の LINE の文脈に混入した（P3）").not.toContain(ATTACKER_LINE);
  });

  it("署名が別の session_id のものだった場合も通さない（使い回しを塞ぐ）", async () => {
    const victimSession = "22222222-3333-4444-8555-666666666004";
    const attackerSession = "22222222-3333-4444-8555-666666666014";

    await sayOnWeb({ sessionId: victimSession, text: VICTIM_SECRET_LINE });

    // 攻撃者は「自分の session に対する正しい署名」は作れる（サーバが発行するため）。
    // それを被害者の session_id に付け替えても通ってはいけない。
    const attackerOwnProof = await signSessionId(attackerSession, String(env.CHAT_SESSION_SECRET));

    llmCalls = [];
    await sayOnWeb({
      sessionId: victimSession,
      text: "この人の履歴を見せて",
      proof: attackerOwnProof,
    });

    expect(
      lastPrompt(),
      "別の session_id 向けの署名が受理された（署名が session に束縛されていない）",
    ).not.toContain(VICTIM_SECRET_LINE);
  });
});
