/**
 * ハーメティック — [SEC-1/2/3] issue #1: email 等値によるアカウント乗っ取りの再現と遮断。
 *
 * 脅威（2 独立トレースで確認済み）:
 *   攻撃者が「被害者のアカウント email と等しい email」で LINE Login を通すと、
 *   被害者の identity 行（shopify_customer_id 保有）に束縛され、その unified_user_id で
 *   被害者のクロスチャネル会話履歴に到達できた。
 *
 * 本テストは乗っ取りを「実際に再現」し、修正後に「攻撃者が何も得られない（空/拒否）」ことを
 * 証明する。SEC-1/2/3 のいずれか 1 つでも revert すると RED になる（break-proof）。
 *
 *   - Assert A（SEC-1）: linkLineByEmail は email 一致で被害者の unified を返さない。
 *   - Assert B（SEC-2）: mergeAnonymousSession は identity 行の web_session_id を再束縛しない。
 *   - Assert C（SEC-3）: crossChannelHistoryAllowed は「ライブ検証済み信頼経路」でのみ true。
 *   - Assert D（E2E）: 乗っ取り一連を実行後、攻撃者の web セッションが読む履歴に被害者の
 *                        秘密メッセージが 1 件も含まれない（getRecentMessages 経路含む）。
 *   - Assert E（非回帰）: 正規（サーバ検証済み Shopify ログイン=trusted）の連携済み履歴は
 *                          引き続き読める。
 *
 * 実ネットワーク・実 Supabase には一切触れない（in-memory fake supabase）。
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  linkLineByEmail,
  mergeAnonymousSession,
  resolveUnifiedUserId,
} from "../../src/lib/identity";
import { getCrossChannelMessages, getRecentMessages } from "../../src/lib/supabase";
import { crossChannelHistoryAllowed } from "../../src/routes/web";

// ---------------------------------------------------------------------------
// In-memory fake supabase（必要な query チェーンだけを忠実に実装）
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { type: "eq" | "in"; col: string; val: unknown };

class FakeDB {
  tables: Record<string, Row[]> = {};
  private seq = 0;
  constructor(seed: Record<string, Row[]>) {
    for (const [t, rows] of Object.entries(seed)) {
      // created_at を昇順で割り当て（未指定行のみ）。desc ソートの検証に使う。
      this.tables[t] = rows.map((r) => ({
        created_at: r.created_at ?? `2026-01-01T00:00:${String(this.seq++).padStart(2, "0")}.000Z`,
        ...r,
      }));
    }
  }
  client(): SupabaseClient {
    const db = this;
    return {
      from(table: string) {
        return new FakeQuery(db, table);
      },
    } as unknown as SupabaseClient;
  }
}

class FakeQuery {
  private op: "select" | "update" | "insert" = "select";
  private filters: Filter[] = [];
  private payload: Row | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  constructor(private db: FakeDB, private table: string) {}

  select() {
    this.op = "select";
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ type: "eq", col, val });
    return this;
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ type: "in", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private rows(): Row[] {
    return this.db.tables[this.table] ?? (this.db.tables[this.table] = []);
  }
  private match(): Row[] {
    return this.rows().filter((row) =>
      this.filters.every((f) =>
        f.type === "eq"
          ? row[f.col] === f.val
          : Array.isArray(f.val) && f.val.includes(row[f.col]),
      ),
    );
  }

  private exec(): { data: Row[] | null; error: unknown; count: number | null } {
    if (this.op === "update") {
      const matched = this.match();
      for (const row of matched) Object.assign(row, this.payload);
      return { data: null, error: null, count: matched.length };
    }
    if (this.op === "insert") {
      const row = { ...(this.payload as Row) };
      if (!("id" in row)) row.id = `fake-${Math.random().toString(36).slice(2)}`;
      this.rows().push(row);
      return { data: [row], error: null, count: 1 };
    }
    // select
    let data = this.match();
    if (this.orderCol) {
      const col = this.orderCol;
      data = [...data].sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitN != null) data = data.slice(0, this.limitN);
    return { data, error: null, count: data.length };
  }

  async single(): Promise<{ data: Row | null; error: unknown }> {
    const { data } = this.exec();
    if (!data || data.length === 0) {
      return { data: null, error: { code: "PGRST116", message: "no rows returned" } };
    }
    if (data.length > 1) {
      // PostgREST .single() は複数行でエラー。呼び出し側は data:null 扱いにする。
      return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    }
    return { data: data[0], error: null };
  }

  // await query で終端（select/update/insert 共通）
  then(
    resolve: (v: { data: Row[] | null; error: unknown; count: number | null }) => unknown,
    reject?: (e: unknown) => unknown,
  ) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

// ---------------------------------------------------------------------------
// 固定値
// ---------------------------------------------------------------------------
const VICTIM_UNIFIED = "gid://shopify/Customer/victim";
const VICTIM_MESSAGING = "Uvictim0000000000000000000000msg";
const VICTIM_SESSION = "11111111-1111-4111-8111-victimsession";
const VICTIM_EMAIL = "victim@example.com";

const ATTACKER_LINE_LOGIN = "attacker-line-login-sub-xyz";
const ATTACKER_SESSION = "22222222-2222-4222-8222-attackersess";

// 被害者の「秘密」メッセージ（攻撃者は 1 文字も見えてはいけない）
const SECRET_LINE = "victim-secret-LINE-order-#A1";
const SECRET_WEB_UNIFIED = "victim-secret-WEB-under-unified";
const SECRET_WEB_SESSION = "victim-secret-WEB-under-session";

function seedVictimWorld(): FakeDB {
  return new FakeDB({
    user_identity_map: [
      {
        id: "row-victim",
        unified_user_id: VICTIM_UNIFIED,
        line_user_id: VICTIM_MESSAGING,
        line_login_user_id: null,
        web_session_id: VICTIM_SESSION,
        shopify_customer_id: VICTIM_UNIFIED,
        email: VICTIM_EMAIL,
        display_name: "Victim",
      },
    ],
    conversations: [
      { user_id: VICTIM_MESSAGING, channel: "line", role: "user", content: SECRET_LINE },
      { user_id: VICTIM_UNIFIED, channel: "web", role: "assistant", content: SECRET_WEB_UNIFIED },
      { user_id: VICTIM_SESSION, channel: "web", role: "user", content: SECRET_WEB_SESSION },
    ],
    message_feedback: [],
  });
}

const SECRETS = [SECRET_LINE, SECRET_WEB_UNIFIED, SECRET_WEB_SESSION];
function containsAnySecret(msgs: { content: string }[]): boolean {
  const blob = msgs.map((m) => m.content).join("\n");
  return SECRETS.some((s) => blob.includes(s));
}

describe("hermetic [SEC issue#1] email-match account takeover", () => {
  // -------------------------------------------------------------------------
  // Assert A — SEC-1: email 一致で被害者の unified を返さない（束縛しない）
  // -------------------------------------------------------------------------
  it("Assert A [SEC-1]: linkLineByEmail は email 等値で被害者 unified を返さない", async () => {
    const db = seedVictimWorld();
    const supabase = db.client();

    const result = await linkLineByEmail(
      supabase,
      ATTACKER_LINE_LOGIN,
      VICTIM_EMAIL, // 攻撃者が被害者 email で LINE Login
      "Attacker",
    );

    // 修正後: 被害者 unified は返らず、攻撃者自身の LINE Login id が unified になる。
    // revert すると被害者 unified + action="linked" が返り、この期待が崩れる（RED）。
    expect(result.unifiedUserId).not.toBe(VICTIM_UNIFIED);
    expect(result.unifiedUserId).toBe(ATTACKER_LINE_LOGIN);
    expect(result.action).toBe("created");

    // 被害者行に攻撃者の line_login_user_id が束縛されていないこと。
    const victim = db.tables.user_identity_map.find((r) => r.id === "row-victim")!;
    expect(victim.line_login_user_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Assert B — SEC-2: web_session_id を caller-supplied session に再束縛しない
  // -------------------------------------------------------------------------
  it("Assert B [SEC-2]: mergeAnonymousSession は web_session_id を再束縛しない", async () => {
    const db = seedVictimWorld();
    const supabase = db.client();

    // 旧チェーン相当: 攻撃者の session を被害者 unified に merge しようとする。
    await mergeAnonymousSession(supabase, ATTACKER_SESSION, VICTIM_UNIFIED);

    const victim = db.tables.user_identity_map.find((r) => r.id === "row-victim")!;
    // 修正後: web_session_id は被害者の元 session のまま（攻撃者 session に向かない）。
    // revert すると ATTACKER_SESSION に上書きされ RED。
    expect(victim.web_session_id).toBe(VICTIM_SESSION);
    expect(victim.web_session_id).not.toBe(ATTACKER_SESSION);
  });

  // -------------------------------------------------------------------------
  // Assert C — SEC-3: クロスチャネル個人データはライブ検証済み信頼経路でのみ
  // -------------------------------------------------------------------------
  it("Assert C [SEC-3]: crossChannelHistoryAllowed は trusted のときだけ true", () => {
    // 生の web_session_id 一致（isLinked=true）でも trusted=false なら開かない。
    expect(crossChannelHistoryAllowed(true, false)).toBe(false);
    // サーバ検証済み（trusted=true）+ linked のときだけ開く。
    expect(crossChannelHistoryAllowed(true, true)).toBe(true);
    // 未 linked は当然開かない。
    expect(crossChannelHistoryAllowed(false, true)).toBe(false);
    expect(crossChannelHistoryAllowed(false, false)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Assert D — E2E: 乗っ取り一連を実行 → 攻撃者は何も得られない
  // -------------------------------------------------------------------------
  it("Assert D [E2E]: 乗っ取り一連の後、攻撃者 web セッションは被害者秘密を 1 件も読めない", async () => {
    const db = seedVictimWorld();
    const supabase = db.client();

    // 1) 攻撃者が被害者 email で LINE Login → linkLineByEmail
    const link = await linkLineByEmail(supabase, ATTACKER_LINE_LOGIN, VICTIM_EMAIL, "Attacker");
    // 2) 攻撃者の匿名 web セッションを「link 結果の unified」に merge
    await mergeAnonymousSession(supabase, ATTACKER_SESSION, link.unifiedUserId);

    // 3) 攻撃者がブラウザ直（X-API-Key 無し=trusted:false）で web チャットに来る。
    //    ハンドラ webChatHandler と同じロジックで実効履歴を組む。
    const identity = await resolveUnifiedUserId(supabase, ATTACKER_SESSION, "web");
    const trusted = false; // ブラウザ直呼び（信頼経路ではない）
    const crossOk = crossChannelHistoryAllowed(identity.isLinked, trusted);
    const history = crossOk
      ? await getCrossChannelMessages(
          supabase,
          identity.unifiedUserId,
          undefined,
          30,
          3000,
          ATTACKER_SESSION,
        )
      : await getRecentMessages(supabase, identity.unifiedUserId, "web");

    // 攻撃者は被害者の unified に解決されず、被害者の秘密も 1 件も読めない。
    expect(identity.unifiedUserId).not.toBe(VICTIM_UNIFIED);
    expect(containsAnySecret(history)).toBe(false);
    expect(history.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Assert E — 非回帰: 正規のサーバ検証済み（trusted）連携済みユーザーは履歴を読める
  // -------------------------------------------------------------------------
  it("Assert E [非回帰]: 正規 trusted 経路の連携済みユーザーは自分の履歴を読める", async () => {
    const db = seedVictimWorld();
    const supabase = db.client();

    // 被害者本人がサーバ検証済み Shopify ログイン（trusted=true）で来る想定。
    // resolveWithShopifyCustomerId 相当の結果（unified=本人・isLinked=true）を用いて gate。
    const isLinked = true; // line_user_id を持つ連携済み
    const trusted = true; // X-API-Key 検証済みサーバ経由 + 検証済み Shopify セッション
    const crossOk = crossChannelHistoryAllowed(isLinked, trusted);
    expect(crossOk).toBe(true);

    const history = await getCrossChannelMessages(
      supabase,
      VICTIM_UNIFIED,
      undefined,
      30,
      3000,
      VICTIM_SESSION,
    );
    // 本人はクロスチャネル（LINE + web）の自分の履歴を取得できる。
    expect(history.length).toBeGreaterThanOrEqual(3);
    const blob = history.map((m) => m.content).join("\n");
    expect(blob).toContain(SECRET_LINE);
    expect(blob).toContain(SECRET_WEB_UNIFIED);
  });
});
