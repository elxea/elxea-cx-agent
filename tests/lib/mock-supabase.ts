/**
 * モック Supabase クライアント（設計 §4-1 = モック client・ハーメティック・決定性優先）。
 *
 * 方式: @supabase/supabase-js が叩く PostgREST の HTTP（`${SUPABASE_URL}/rest/v1/<table>?...`）を
 *   fetch 層で横取りし、インメモリのテーブルストアで最小限の PostgREST セマンティクスを再現する。
 *   → createSupabaseClient にコード上のシームを入れず（本番コード不変）、実 DB にも接続しない。
 *
 * 対応オペレーション（本 Phase の webhook 動線が使う範囲に限定）:
 *   - GET   select（eq / in / is フィルタ、order、limit、select 射影、single）
 *   - GET   count（Prefer: count=exact / HEAD）
 *   - POST  insert / upsert（on_conflict）
 *   - PATCH update（eq フィルタ）
 *   - DELETE（eq フィルタ・後片付け用）
 * これ以外（複雑な演算子や RPC）は本 Phase の動線では不使用。
 */

type Row = Record<string, unknown>;

const PGRST_OBJECT = "application/vnd.pgrst.object+json";

/**
 * 一意制約を持つ列（表名 → 列名）。**実スキーマの写しである。**
 *
 * インメモリのストアは既定で何でも受け入れるので、DB 側の制約に依存する挙動
 * （二重加算が構造的に止まる、等）をモックで確かめると **常に緑になる**。
 * それでは「制約が効いている」ではなく「モックが素通しした」を確かめたことになる。
 *
 * ここに書けるのは **実際に UNIQUE index が張ってある列だけ**:
 *   customer_events.idempotency_key … 041 の customer_events_idempotency
 *   subjects.subject_id             … 040 の PRIMARY KEY
 * migration 側から消えたらここからも消すこと（写しなので、ずれたら嘘をつく）。
 */
const UNIQUE_COLUMNS: Record<string, string> = {
  customer_events: "idempotency_key",
  subjects: "subject_id",
};

/** Postgres の一意制約違反（23505）を PostgREST の形で返す。 */
function uniqueViolation(table: string, column: string): Response {
  return new Response(
    JSON.stringify({
      code: "23505",
      details: null,
      hint: null,
      message: `duplicate key value violates unique constraint on ${table}.${column}`,
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

export interface SupabaseMock {
  /** テーブル名 → 行配列。 */
  store: Record<string, Row[]>;
  /** fetch ルータから呼ばれるハンドラ。 */
  handle(url: string, init?: RequestInit): Promise<Response>;
  /** ストアを空にする（beforeEach で使う）。 */
  reset(): void;
  /** テーブルに初期行を投入する。 */
  seed(table: string, rows: Row[]): void;
  /** テーブルの現在の行配列を返す（DB 効果の assert 用）。 */
  all(table: string): Row[];
}

/** Supabase の base URL（host 一致でルーティングするため保持）。 */
export function createSupabaseMock(): SupabaseMock {
  const store: Record<string, Row[]> = {};
  const table = (t: string): Row[] => (store[t] ??= []);

  function applyFilters(rows: Row[], params: URLSearchParams): Row[] {
    let out = rows;
    for (const [key, val] of params.entries()) {
      if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
      const m = /^([a-z]+)\.(.*)$/s.exec(val);
      if (!m) continue;
      const [, op, operand] = m;
      if (op === "eq") {
        out = out.filter((r) => String(r[key]) === operand);
      } else if (op === "neq") {
        out = out.filter((r) => String(r[key]) !== operand);
      } else if (op === "in") {
        const set = new Set(
          operand
            .replace(/^\(|\)$/g, "")
            .split(",")
            .map((s) => s.replace(/^"|"$/g, "")),
        );
        out = out.filter((r) => set.has(String(r[key])));
      } else if (op === "is") {
        if (operand === "null") out = out.filter((r) => r[key] == null);
        else if (operand === "true") out = out.filter((r) => r[key] === true);
        else if (operand === "false") out = out.filter((r) => r[key] === false);
      }
      // 本 Phase の動線が使わない演算子は無視（範囲外）。
    }
    return out;
  }

  function applyOrder(rows: Row[], params: URLSearchParams): Row[] {
    const order = params.get("order");
    if (!order) return rows;
    const [col, dir] = order.split(".");
    const asc = dir !== "desc";
    return [...rows].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (av === bv) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av < bv ? -1 : 1) * (asc ? 1 : -1);
    });
  }

  function project(rows: Row[], params: URLSearchParams): Row[] {
    const sel = params.get("select");
    if (!sel || sel === "*") return rows;
    const cols = sel
      .split(",")
      .map((s) => s.trim())
      .filter((c) => c.length > 0 && !c.includes("("));
    if (cols.length === 0) return rows;
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }

  function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return new Response(data === undefined ? "" : JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...extraHeaders },
    });
  }

  async function handle(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    const t = decodeURIComponent(u.pathname.replace(/^\/rest\/v1\//, ""));
    const params = u.searchParams;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers((init?.headers as HeadersInit) ?? {});
    const wantsSingle = (headers.get("accept") ?? "").includes(PGRST_OBJECT);
    const prefer = headers.get("prefer") ?? "";

    if (method === "GET" || method === "HEAD") {
      const matched = applyFilters(table(t), params);
      let rows = applyOrder(matched, params);
      const limit = params.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));

      // count（Prefer: count=exact / HEAD）。
      if (prefer.includes("count=") || method === "HEAD") {
        const total = matched.length;
        const upper = Math.max(0, rows.length - 1);
        const bodyRows = method === "HEAD" ? undefined : project(rows, params);
        return json(bodyRows, 200, { "content-range": `0-${upper}/${total}` });
      }

      const projected = project(rows, params);
      if (wantsSingle) {
        // .single(): 1 行なら object、0 or >1 なら PGRST116（supabase-js が error にマップ）。
        if (projected.length === 1) return json(projected[0], 200);
        return json(
          {
            code: "PGRST116",
            details: `Results contain ${projected.length} rows`,
            message: "JSON object requested, multiple (or no) rows returned",
          },
          406,
        );
      }
      return json(projected, 200);
    }

    if (method === "POST") {
      let incoming: Row[] = [];
      try {
        const parsed = JSON.parse(init?.body ? String(init.body) : "[]");
        incoming = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        incoming = [];
      }
      const onConflict = params.get("on_conflict");
      const uniqueCol = UNIQUE_COLUMNS[t];
      for (const row of incoming) {
        // 一意制約（onConflict 指定が無い素の insert のときだけ効く。
        // upsert は下の分岐が既存行を更新するので衝突しない）。
        if (uniqueCol && !onConflict && row[uniqueCol] !== undefined) {
          const clash = table(t).some((r) => String(r[uniqueCol]) === String(row[uniqueCol]));
          if (clash) return uniqueViolation(t, uniqueCol);
        }
        if (onConflict) {
          const idx = table(t).findIndex(
            (r) => String(r[onConflict]) === String(row[onConflict]),
          );
          if (idx >= 0) {
            table(t)[idx] = { ...table(t)[idx], ...row };
            continue;
          }
        }
        table(t).push({ ...row });
      }
      return prefer.includes("return=representation") ? json(incoming, 201) : json(undefined, 201);
    }

    if (method === "PATCH") {
      let patch: Row = {};
      try {
        patch = JSON.parse(init?.body ? String(init.body) : "{}") as Row;
      } catch {
        patch = {};
      }
      const targets = applyFilters(table(t), params);
      for (const r of targets) Object.assign(r, patch);
      return prefer.includes("return=representation") ? json(targets, 200) : json(undefined, 204);
    }

    if (method === "DELETE") {
      const toDelete = new Set(applyFilters(table(t), params));
      store[t] = table(t).filter((r) => !toDelete.has(r));
      return prefer.includes("return=representation") ? json([], 200) : json(undefined, 204);
    }

    return json({ message: `mock-supabase: 未対応 ${method} ${t}` }, 400);
  }

  return {
    store,
    handle,
    reset() {
      for (const k of Object.keys(store)) delete store[k];
    },
    seed(t, rows) {
      table(t).push(...rows.map((r) => ({ ...r })));
    },
    all(t) {
      return table(t);
    },
  };
}
