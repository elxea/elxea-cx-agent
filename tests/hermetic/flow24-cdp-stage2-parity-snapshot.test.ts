/**
 * ハーメティック — CDP 統合 Stage 2: 観測が「後から数えられる形」で残る（migration 048）。
 *
 * 何を守るテストか:
 *   Stage 2 の完了条件は「新旧解決の一致率 100% を **5 営業日** 観測」である。
 *   043 / 044 の時点では観測が console.log の 1 行にしかならず、連続営業日を
 *   後から問い合わせる先が無かった（＝リリースゲートの判定が原理的に不能）。
 *   048 でその日の 1 行を DB に残すようにした。ここが守るのは **読み書きの作法**:
 *
 *     1. 日次 tick は「保存まで済ませる関数」を呼ぶ（読み取りだけで済ませない）
 *     2. 観測日を呼び出し側から渡さない（渡せると過去の日を作り直せる／
 *        同じ日に 2 回走ったとき別の日として数えられうる）
 *     3. **比べる相手が 0 人の日を緑に数えない**（048 の芯）
 *     4. 048 未適用でも観測は止まらない（読み取り専用に落ちて理由が残る）
 *     5. 連続日数が読めなくても、その日の観測は成立する
 *
 * ─ ここで確かめないもの（意図的な線引き）─
 *   ON CONFLICT の冪等・生成列 is_green・連続営業日の数え方そのものは **plpgsql の意味**
 *   であり、モックで再現すれば「モックが再現した挙動」を確かめることになる。
 *   SQL の意味は tests/db/cdp-stage2-parity-snapshot.db.test.ts が実 DB で見る。
 *   ここは「呼び出し側がどう呼び、戻りをどう読むか」だけを固定する。
 *   SQL の**字面**（UNIQUE / ON CONFLICT / 生成列の式）は
 *   tests/unit/cdp-stage2-parity-snapshot.test.ts が固定する。
 *
 * ハーメティック＝実ネットワーク不使用・実送信ゼロ・実 DB 不使用。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import {
  runStage2Parity,
  PARITY_RPC,
  PARITY_SNAPSHOT_RPC,
  PARITY_STREAK_RPC,
} from "../../src/lib/cdp/stage2-parity";
import type { Env } from "../../src/index";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
  h.supabase.reset();
});

/** runStage2Parity は Env を取る。bindings はすべてモック値（vitest.config.ts）。 */
const testEnv = () => env as unknown as Env;

/** 044 の cdp_stage2_parity() が返す形（一致している日）。 */
function parityPayload(over: Record<string, unknown> = {}) {
  return {
    linked_ledger_rows: 3,
    linked_without_link: 0,
    identity_map_linked_rows: 2,
    identity_map_without_link: 0,
    delivery_identity_rows: 3,
    delivery_identity_missing: 0,
    links_total: 5,
    links_by_basis: { liff_id_token: 5 },
    max_component_size: 2,
    multi_line_components: 0,
    in_agreement: true,
    in_agreement_by: {
      linked_without_link: true,
      identity_map_without_link: true,
      delivery_identity_missing: true,
      multi_line_components: true,
    },
    ...over,
  };
}

/** 048 の cdp_stage2_parity_snapshot() が返す形（= 044 の戻り + 保存結果）。 */
function snapshotPayload(over: Record<string, unknown> = {}) {
  return {
    ...parityPayload(),
    snapshot_date: "2026-08-31",
    compared_count: 5,
    mismatch_count: 0,
    is_green: true,
    is_business_day: true,
    persisted: true,
    ...over,
  };
}

function streakPayload(over: Record<string, unknown> = {}) {
  return {
    today_jst: "2026-08-31",
    latest_business_day: "2026-08-31",
    anchor_date: "2026-08-31",
    is_stale: false,
    streak_business_days: 3,
    target_business_days: 5,
    meets_target: false,
    break_date: "2026-08-26",
    break_reason: "mismatch",
    holidays_excluded: false,
    days: [],
  };
}

describe("048: 日次 tick は観測を保存する関数を呼ぶ", () => {
  it("読み取り専用ではなく保存まで済ませる関数を呼ぶ", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({ body: snapshotPayload() }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(true);
    expect(h.supabase.rpcCalls[0]?.name).toBe(PARITY_SNAPSHOT_RPC);
    // 保存できているのに読み取り専用の関数も叩く、という二度手間はしない。
    expect(h.supabase.rpcCalls.map((c) => c.name)).not.toContain(PARITY_RPC);
  });

  it("観測日を呼び出し側から渡さない（過去の日を作り直せないようにする）", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({ body: snapshotPayload() }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    await runStage2Parity(testEnv());

    const call = h.supabase.rpcCalls.find((c) => c.name === PARITY_SNAPSHOT_RPC);
    expect(call).toBeDefined();
    // 引数が空 = 観測日は SQL 側（JST の今日）が決める。
    expect(Object.keys(call!.args)).toEqual([]);
  });

  it("同じ日に 2 回走っても、2 回とも同じ呼び方をする（日をずらす引数を作らない）", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({ body: snapshotPayload() }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    await runStage2Parity(testEnv());
    await runStage2Parity(testEnv());

    const calls = h.supabase.rpcCalls.filter((c) => c.name === PARITY_SNAPSHOT_RPC);
    expect(calls).toHaveLength(2);
    // 2 回とも引数なし → SQL 側では同じキー（今日）に当たり ON CONFLICT で 1 行のまま。
    for (const c of calls) expect(Object.keys(c.args)).toEqual([]);
  });

  it("保存できた日は、分母と食い違い数が結果に載る", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({
      body: snapshotPayload({ compared_count: 5, mismatch_count: 0 }),
    }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.snapshotDate).toBe("2026-08-31");
    expect(result.comparedCount).toBe(5);
    expect(result.mismatchCount).toBe(0);
    expect(result.inAgreement).toBe(true);
    expect(result.green).toBe(true);
  });
});

describe("048 の芯: 比べる相手が 0 人の日を緑に数えない", () => {
  it("in_agreement=true でも compared_count=0 なら緑にしない", async () => {
    // 旧台帳に連携済みの行が 1 つも無い日。4 つの数はすべて 0 なので
    // 044 の in_agreement は true になるが、これは「一致した」ではなく
    // 「何も比べていない」。一致率 100% の分母が 0 の日である。
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({
      body: snapshotPayload({
        linked_ledger_rows: 0,
        identity_map_linked_rows: 0,
        links_total: 0,
        compared_count: 0,
        mismatch_count: 0,
        is_green: false,
        in_agreement: true,
      }),
    }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.ok).toBe(true);
    // 突合そのものの結果は隠さない（044 の値をそのまま持つ）。
    expect(result.inAgreement).toBe(true);
    expect(result.comparedCount).toBe(0);
    // が、「一致した 1 日」には数えない。
    expect(result.green).toBe(false);
  });

  it("SQL が is_green=true と言っても compared_count=0 なら緑にしない（fail-closed）", async () => {
    // 048 が入っていない古い定義や、将来の書き換えで分母を落とした戻りが来ても、
    // 読む側で分母を確かめる。絞り込みなので赤を緑にすることは構造上できない。
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({
      body: snapshotPayload({ compared_count: 0, is_green: true }),
    }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.green).toBe(false);
  });

  it("食い違いがある日は緑にならない（分母があっても）", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({
      body: snapshotPayload({
        linked_without_link: 1,
        in_agreement: false,
        compared_count: 5,
        mismatch_count: 1,
        is_green: false,
      }),
    }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.inAgreement).toBe(false);
    expect(result.green).toBe(false);
    expect(result.mismatchCount).toBe(1);
  });
});

describe("048 未適用でも観測は止まらない", () => {
  it("保存の関数が無ければ読み取り専用に落ち、理由が残る", async () => {
    // PARITY_SNAPSHOT_RPC は未登録 = DB にその関数が無い（PGRST202 / 404）。
    h.supabase.onRpc(PARITY_RPC, () => ({ body: parityPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.persistReason).toContain("snapshot_rpc_failed");
    expect(result.inAgreement).toBe(true);
    // 保存できていない日は分母を確かめられないので緑にしない
    //（「観測が始まっていない」と「観測して一致していた」を混ぜない）。
    expect(result.green).toBe(false);
    expect(h.supabase.rpcCalls.map((c) => c.name)).toEqual([PARITY_SNAPSHOT_RPC, PARITY_RPC]);
  });

  it("043 も未適用なら ok=false で理由が残る（黙って緑にしない）", async () => {
    const result = await runStage2Parity(testEnv());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("rpc_failed");
    expect(result.persisted).toBe(false);
    expect(result.green).toBeUndefined();
  });

  it("Supabase 未設定なら理由を残して何も呼ばない", async () => {
    const result = await runStage2Parity({} as Env);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("supabase_not_configured");
    expect(h.supabase.rpcCalls).toHaveLength(0);
  });

  it("戻りの形が壊れていたら中途半端に読まない", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({ body: "not-an-object" }));

    const result = await runStage2Parity(testEnv());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("rpc_shape_unexpected");
  });
});

describe("連続営業日は 1 行に載るが、読めなくても観測は成立する", () => {
  it("読めたらそのまま載る（数え方の正本は SQL 側）", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({ body: snapshotPayload() }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.streak?.streak_business_days).toBe(3);
    expect(result.streak?.target_business_days).toBe(5);
    expect(result.streak?.meets_target).toBe(false);
    expect(result.streakReason).toBeUndefined();
  });

  it("読めなくてもその日の保存は成立している（理由だけ残す）", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({ body: snapshotPayload() }));
    // PARITY_STREAK_RPC は未登録 = 404。

    const result = await runStage2Parity(testEnv());

    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.green).toBe(true);
    expect(result.streak).toBeUndefined();
    expect(result.streakReason).toContain("streak_rpc_failed");
  });

  it("連続日数が読めても、保存の関数が無い日には読みにいかない", async () => {
    h.supabase.onRpc(PARITY_RPC, () => ({ body: parityPayload() }));
    h.supabase.onRpc(PARITY_STREAK_RPC, () => ({ body: streakPayload() }));

    const result = await runStage2Parity(testEnv());

    expect(result.persisted).toBe(false);
    // 保存できていない = その日の行が無い。連続日数を読んでも今日を含まないので
    // 「今日まで連続している」と読み違えさせない。
    expect(result.streak).toBeUndefined();
    expect(h.supabase.rpcCalls.map((c) => c.name)).not.toContain(PARITY_STREAK_RPC);
  });
});

describe("観測は決して throw しない（日次 tick の他の仕事を巻き込まない）", () => {
  it("RPC が 500 を返しても throw せず理由を返す", async () => {
    h.supabase.onRpc(PARITY_SNAPSHOT_RPC, () => ({
      status: 500,
      body: { code: "XX000", message: "boom" },
    }));
    h.supabase.onRpc(PARITY_RPC, () => ({ status: 500, body: { code: "XX000", message: "boom" } }));

    await expect(runStage2Parity(testEnv())).resolves.toMatchObject({ ok: false });
  });
});
