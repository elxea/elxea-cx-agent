/**
 * ハーメティック L1 — E6': Firebase 未設定なら起動を拒否する（fail-closed）。
 *
 * 何を守るテストか:
 *   このリポジトリには `try { getFirestoreEnv(env) } catch { return }` という縮退が
 *   各所にあり、Firebase が未設定でも例外を出さず「何もしないで成功したように見える」
 *   状態で動き続けられた。カルテも persona も書かれないのに、ログにも監視にも何も出ない。
 *
 *   実害は 2 つ出ている:
 *     (1) 2026-08 の CDP 審査で、3 つの設計案すべてが「本番の cx-agent は Firestore
 *         未設定なのではないか」と疑った。実機で secret を数えるまで誰も確定できなかった
 *         ＝ **設定されているのかいないのかを、外から見て言えなかった**。
 *     (2) その誤読が persona 二重加算の見落としに直結した（「cx-agent 側は動いて
 *         いないはずだから二重にはならない」という前提が成立して見えていた）。
 *
 *   よってここで固定するのは「静かに縮退しないこと」である。未設定なら止まる。
 *   止まれば必ず気づく。
 *
 * 検査する契約:
 *   1. 未設定 + 申告なし          → 業務経路は 503（実質の起動拒否）
 *   2. 未設定 + 申告あり（非本番）→ 通す（ハーメティック / staging のため）
 *   3. 未設定 + 申告あり + 本番   → **それでも 503**（逃げ道が本番に効くなら fail-closed ではない）
 *   4. `/` と `/health/firebase`  → ゲートの対象外（止まっている理由を外から読めなくしない）
 *   5. `/health/firebase` は接続先プロジェクト ID だけを返す（PII を返さない）
 *
 * ハーメティック＝実ネットワーク不使用・実送信ゼロ。env を一時的に書き換えるだけで、
 * 終わったら必ず元へ戻す（他のテストへ漏らさない）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";

let h: Hermetic;

const mutableEnv = env as unknown as Record<string, unknown>;
const TOUCHED = [
  "FIRESTORE_UNCONFIGURED_ACK",
  "DELIVERY_TARGET_ENV",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
] as const;

let saved: Record<string, unknown>;

beforeEach(() => {
  h = installHermeticFetch(env);
  saved = {};
  for (const k of TOUCHED) saved[k] = mutableEnv[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete mutableEnv[k];
    else mutableEnv[k] = saved[k];
  }
  h.restore();
});

function set(key: string, value: string | undefined): void {
  if (value === undefined) delete mutableEnv[key];
  else mutableEnv[key] = value;
}

/** 資格情報 3 点をモック値で揃える（実 Firestore は叩かない — ゲートは存在だけを見る）。 */
function configureFirebase(): void {
  set("FIREBASE_PROJECT_ID", "e6-mock-project");
  set("FIREBASE_CLIENT_EMAIL", "e6-mock@example.invalid");
  set("FIREBASE_PRIVATE_KEY", "e6-mock-key");
}

function unconfigureFirebase(): void {
  set("FIREBASE_PROJECT_ID", undefined);
  set("FIREBASE_CLIENT_EMAIL", undefined);
  set("FIREBASE_PRIVATE_KEY", undefined);
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://elxea-agent.e2e.local${path}`),
    env as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* expected-failure: JSON でない応答もそのまま見たい */
  }
  return { status: res.status, body };
}

describe("hermetic L1 — E6': Firebase 未設定なら起動拒否", () => {
  it("未設定 + 申告なし: 業務経路は 503（静かに縮退しない）", async () => {
    unconfigureFirebase();
    set("FIRESTORE_UNCONFIGURED_ACK", undefined);

    const res = await get("/api/identity/linkage-status?shopifyCustomerId=1");
    expect(res.status, "未設定なのに業務経路が通ってしまった").toBe(503);
    expect(JSON.stringify(res.body)).toContain("firestore_not_configured");
  });

  it("未設定 + 申告あり（非本番）: 通す（ハーメティック / staging のため）", async () => {
    unconfigureFirebase();
    set("DELIVERY_TARGET_ENV", "test");
    set("FIRESTORE_UNCONFIGURED_ACK", "true");

    const res = await get("/api/identity/linkage-status?shopifyCustomerId=1");
    // 503 でなければ何でもよい（401/400 はこの口自身の認証・検証の応答であり、
    // ゲートを通り抜けた証拠になる）。ここで見たいのはゲートが塞いでいないこと。
    expect(res.status, "申告があるのにゲートで塞がれた").not.toBe(503);
  });

  it("未設定 + 申告あり + 本番: それでも 503（逃げ道は本番に効かない）", async () => {
    unconfigureFirebase();
    set("DELIVERY_TARGET_ENV", "prod");
    set("FIRESTORE_UNCONFIGURED_ACK", "true");

    const res = await get("/api/identity/linkage-status?shopifyCustomerId=1");
    expect(
      res.status,
      "本番で申告が効いてしまった — これを許すと fail-closed ではなくなる",
    ).toBe(503);
  });

  it("設定済み: 業務経路はゲートで塞がれない", async () => {
    configureFirebase();
    set("FIRESTORE_UNCONFIGURED_ACK", undefined);
    set("DELIVERY_TARGET_ENV", "prod");

    const res = await get("/api/identity/linkage-status?shopifyCustomerId=1");
    expect(res.status, "設定済みなのにゲートで塞がれた").not.toBe(503);
  });

  it("`/` はゲートの対象外（サービスの生存は常に読める）", async () => {
    unconfigureFirebase();
    set("FIRESTORE_UNCONFIGURED_ACK", undefined);

    const res = await get("/");
    expect(res.status, "止まっている理由を読む前に入口が塞がれた").toBe(200);
  });

  it("`/health/firebase` は未設定を 503 + project_id=null で報告する", async () => {
    unconfigureFirebase();
    set("FIRESTORE_UNCONFIGURED_ACK", undefined);

    const res = await get("/health/firebase");
    // ゲートの対象外なので「503 で塞がれた」のではなく「未設定だと報告した」503。
    expect(res.status).toBe(503);
    const body = res.body as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.project_id, "未設定なら null を返す（突合側は不一致と同じ扱いにする）").toBe(
      null,
    );
  });

  it("`/health/firebase` は設定済みなら接続先プロジェクト ID だけを返す", async () => {
    configureFirebase();

    const res = await get("/health/firebase");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.project_id).toBe("e6-mock-project");

    // PII も資格情報も返さない。返す鍵の集合そのものを固定して、
    // 「便利だから」と顧客の情報が足されるのを止める。
    expect(Object.keys(body).sort()).toEqual(
      ["configured", "delivery_target_env", "project_id", "service"].sort(),
    );
    const serialized = JSON.stringify(body);
    expect(serialized, "秘密鍵が漏れている").not.toContain("e6-mock-key");
    expect(serialized, "サービスアカウントのアドレスが漏れている").not.toContain(
      "e6-mock@example.invalid",
    );
  });
});
