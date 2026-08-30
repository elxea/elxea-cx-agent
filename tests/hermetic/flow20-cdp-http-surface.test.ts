/**
 * ハーメティック L1 — CDP の HTTP の口が fail-closed であること
 *
 * ─ なぜ要るか ─
 *
 * CDP は 4 つの HTTP の口を持つ。1 つは書き込み（出来事を積む）、3 つは読み出し
 * （解析側が L0 を取りに来る）。どれも共有秘密（`SYNC_API_SECRET` / `X-API-Key`）
 * で守られている **はず** だが、それを確かめる自動検査がどこにも無かった。
 *
 *   - `tests/unit/cdp-export.test.ts` は引数の読み方だけを見る（口は開けない）
 *   - `tests/db/cdp-stage3-l0-readout.db.test.ts` は SQL だけを見る（HTTP を通らない）
 *   - `tests/hermetic/flow19` は `/api/chat/event`（公開の口）を通る経路だけを見る
 *
 * つまり「認証を外しても、どのテストも赤くならない」状態だった。認証の穴は
 * **成功したときに何も起きない** 種類の壊れ方（誰も 401 を見ないので気づけない）
 * なので、ここで固定する。
 *
 * ─ 何を検査するか ─
 *
 *   1. 4 つの口すべてが、鍵なしで 401
 *   2. 4 つの口すべてが、**違う鍵** で 401（「ヘッダーがあれば通る」になっていない）
 *   3. サーバ側に秘密が無い状態では、**正しいはずの鍵でも** 401
 *      （fail-closed。誤設定で無認証開放しない — `sync-auth.ts` の宣言の実測）
 *   4. 正しい鍵なら 401 ではない（＝ 3 の拒否が「常に 401」ではないことの裏取り）
 *   5. 401 の本文に鍵の有無を推測させる情報が入らない（理由はログにだけ出す）
 *
 *   4 が要るのは、1〜3 だけだと「ハンドラが壊れていて常に 401」でも全部緑になる
 *   ためである。落ちる側だけを検査した認証テストは、認証が死んでいることを
 *   合格と読み替える。
 *
 * ─ ハーメティック ─
 *   実ネットワーク不使用・実送信ゼロ。Supabase はモック。
 *   `SYNC_API_SECRET` は vitest.config.ts の bindings に **無い**（＝ 既定は「秘密なし」）。
 *   3 はその既定のまま検査し、1・2・4 はテスト中だけ env に載せて外す。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";

let h: Hermetic;

/** テスト中だけ載せる秘密。実在の値ではない。 */
const SECRET = "hermetic-mock-sync-api-secret";

type MutableEnv = { SYNC_API_SECRET?: string };

beforeEach(() => {
  h = installHermeticFetch(env);
  h.supabase.reset();
});

afterEach(() => {
  // 秘密を持ち越さない。持ち越すと「既定は秘密なし」を前提にした検査 3 が
  // 実行順で結果を変える（いちばん見つけにくい壊れ方）。
  delete (env as unknown as MutableEnv).SYNC_API_SECRET;
  h.restore();
});

function withSecret(value: string | undefined): void {
  if (value === undefined) delete (env as unknown as MutableEnv).SYNC_API_SECRET;
  else (env as unknown as MutableEnv).SYNC_API_SECRET = value;
}

/** CDP の HTTP の口。ここに 1 行足せば、下の検査 5 本すべてがその口に及ぶ。 */
const SURFACES = [
  {
    name: "POST /api/events（出来事を積む口）",
    method: "POST" as const,
    path: "/api/events",
    body: {
      events: [
        {
          event_type: "behavior.view_content",
          channel: "web",
          identifier_kind: "web_anonymous_id",
          identifier_value: "0123456789abcdef0123456789abcdef",
          dedupe: "auth-probe",
          source: "hermetic.auth-probe",
        },
      ],
    },
  },
  {
    name: "GET /api/cdp/l0/events（L0 を取りに来る口）",
    method: "GET" as const,
    path: "/api/cdp/l0/events?after_seq=0&limit=1",
    body: null,
  },
  {
    name: "GET /api/cdp/l0/daily-counts（日次件数の口）",
    method: "GET" as const,
    path: "/api/cdp/l0/daily-counts?from=2026-08-01&to=2026-08-02",
    body: null,
  },
  {
    name: "GET /api/cdp/l0/subject-map（主体対応表の口）",
    method: "GET" as const,
    path: "/api/cdp/l0/subject-map?after_edge_seq=0&limit=1",
    body: null,
  },
];

async function call(
  surface: (typeof SURFACES)[number],
  apiKey: string | null,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (surface.body) headers["content-type"] = "application/json";
  if (apiKey !== null) headers["X-API-Key"] = apiKey;

  const res = await worker.fetch(
    new Request(`https://example.com${surface.path}`, {
      method: surface.method,
      headers,
      ...(surface.body ? { body: JSON.stringify(surface.body) } : {}),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("CDP の HTTP の口 — 鍵が無ければ通さない", () => {
  for (const surface of SURFACES) {
    it(`${surface.name}: 鍵なしは 401`, async () => {
      withSecret(SECRET);
      const res = await call(surface, null);
      expect(res.status).toBe(401);
    });

    it(`${surface.name}: 違う鍵は 401（ヘッダーがあれば通る、になっていない）`, async () => {
      withSecret(SECRET);
      const res = await call(surface, "not-the-secret");
      expect(res.status).toBe(401);
    });

    it(`${surface.name}: サーバに秘密が無ければ、正しいはずの鍵でも 401（fail-closed）`, async () => {
      withSecret(undefined);
      const res = await call(surface, SECRET);
      expect(res.status).toBe(401);
    });

    it(`${surface.name}: 正しい鍵は 401 にならない（拒否が「常に 401」ではない）`, async () => {
      withSecret(SECRET);
      const res = await call(surface, SECRET);
      // 中身の成否（200 / 500 / 502）はモック Supabase の作り込み次第なので問わない。
      // ここで確かめたいのは「認証で弾かれていない」ことだけ。
      expect(res.status).not.toBe(401);
    });
  }

  it("401 の本文に、鍵の有無を外から探れる情報が入らない", async () => {
    withSecret(SECRET);

    for (const surface of SURFACES) {
      const noKey = await call(surface, null);
      const wrongKey = await call(surface, "not-the-secret");

      const a = await noKey.text();
      const b = await wrongKey.text();

      // 「鍵が無い」と「鍵が違う」は原因も対処も違うが、**外に出す本文は同じ**に
      // しておく（違えば、鍵の存在を総当たりで探れる）。理由の出し先はログだけ。
      expect(a).toBe(b);

      // 秘密そのもの・その断片が漏れていない。
      expect(a).not.toContain(SECRET);
      expect(a).not.toContain(SECRET.slice(0, 8));
    }
  });
});
