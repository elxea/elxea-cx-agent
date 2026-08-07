/**
 * ハーメティック L1 — 動線16: 入口の答えを連携無しでも残す（穴3）＋ 毎日の照合（装置3）。
 *
 * 一次入力（仕様の正本）:
 *   roji同じ人だと分かる仕組み  https://www.notion.so/3b570c9d064c81d68610f9360f50c965
 *     第3章「穴3: 入口質問で押したボタンは、連携済みでないと記録そのものをしない」
 *     第3章「装置3: 合流を2重に起動する — 出来事のたび + 毎日の照合」
 *
 * ❌→✅:
 *   穴3   従来 recordOnboardingCompletion は customer_linkages に行が無いと**記録せず return** した。
 *         友だち追加直後は未連携が多数派なので、押したボタンは事実上どこにも残らなかった。
 *         → 連携の有無にかかわらず記録する（未連携なら未連携カルテへ）。
 *   上書き `onboarding` を丸ごと PATCH すると同じ map の中の `source`（入口の答え・項目15）が消える。
 *         → read-modify-write でサブフィールドを重ねる。
 *   装置3 毎日の照合で「連携済みなのに合流していない人」を拾い直す。回収範囲は lineUsers 由来のみ。
 *
 * 安全: DI（in-memory）で駆動し実 Firestore / 実 Supabase に触れない。外部送信ゼロ
 *   （LINE 送信が 1 通も起きないことも明示的に確認する）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { settle } from "../lib/webhook";
import { synthLineUserId } from "../lib/synthetic";
import { recordOnboardingCompletion } from "../../src/routes/line";
import { runKarteReconcile } from "../../src/lib/karte-reconcile";
import type {
  CustomerProfile,
  FirestoreEnv,
  LineUserProfile,
} from "../../src/lib/firestore";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/** Firestore 資格情報は DI で I/O を差し替えるためモック値でよい（実 REST には触れない）。 */
const FS_BINDINGS = {
  FIREBASE_PROJECT_ID: "e2e-mock-project",
  FIREBASE_CLIENT_EMAIL: "e2e@mock.local",
  FIREBASE_PRIVATE_KEY: "e2e-mock-key",
};

const FS_ENV = FS_BINDINGS as FirestoreEnv;

/** in-memory Firestore（PATCH 相当の浅いマージ）。 */
function makeStore() {
  const lineUsers = new Map<string, LineUserProfile>();
  const users = new Map<string, CustomerProfile>();
  return {
    lineUsers,
    users,
    getLineUser: async (id: string) => lineUsers.get(id) ?? null,
    getCustomer: async (id: string) => users.get(id) ?? null,
    updateLineUser: async (id: string, u: Partial<LineUserProfile>) => {
      lineUsers.set(id, { ...(lineUsers.get(id) ?? {}), ...u });
    },
    updateCustomer: async (id: string, u: Partial<CustomerProfile>) => {
      users.set(id, { ...(users.get(id) ?? {}), ...u });
    },
  };
}

describe("hermetic L1 — 動線16: 穴3（連携無しでも入口の答えを残す）", () => {
  it("★ 穴3: 未連携でもボタンのタップが未連携カルテに残る（従来は何も書かずに return した）", async () => {
    const user = synthLineUserId("f16a");
    const s = makeStore();

    await recordOnboardingCompletion(user, "about", { ...env, ...FS_BINDINGS } as never, {
      resolveShopifyId: async () => null, // 未連携
      getLineUser: s.getLineUser as never,
      updateLineUser: s.updateLineUser as never,
      getCustomer: s.getCustomer as never,
      updateCustomer: s.updateCustomer as never,
      addBehavior: async () => {},
      now: () => "2026-08-08T12:00:00.000Z",
    });

    // ★ ロードベアリング: 未連携でも記録が残る。early return を戻すとここが赤くなる。
    const karte = s.lineUsers.get(user);
    expect(karte, "未連携カルテが作られる").toBeTruthy();
    expect(karte!.onboarding?.initialAction).toBe("about");
    expect(karte!.onboarding?.completedAt).toBe("2026-08-08T12:00:00.000Z");
    // 本カルテには書かない（連携先が無いのだから当然）。
    expect(s.users.size).toBe(0);

    // 生の出来事も連携の有無に関係なく残る（穴3 の回復経路）。
    await settle();
    const row = h.supabase
      .all("flow_events")
      .find((e) => e.user_ref === user && e.event_name === "onboarding.complete");
    expect(row, "flow_events(onboarding.complete) が記録される").toBeTruthy();
    expect(row?.value).toBe("about");

    // 外部送信ゼロ。
    expect(h.line.sends.length).toBe(0);
  });

  it("★ 上書き封鎖: 先に答えた入口の答え（source）をボタンのタップが消さない", async () => {
    const user = synthLineUserId("f16b");
    const s = makeStore();
    // 入口質問に先に答えている（項目15）。
    s.lineUsers.set(user, {
      lineUserId: user,
      onboarding: { completedAt: null, initialAction: null, source: "marche" },
    });

    await recordOnboardingCompletion(user, "howto", { ...env, ...FS_BINDINGS } as never, {
      resolveShopifyId: async () => null,
      getLineUser: s.getLineUser as never,
      updateLineUser: s.updateLineUser as never,
      getCustomer: s.getCustomer as never,
      updateCustomer: s.updateCustomer as never,
      addBehavior: async () => {},
    });

    const ob = s.lineUsers.get(user)!.onboarding!;
    // ★ ロードベアリング: read-modify-write を外して map を丸ごと書くと source が消えて赤くなる。
    expect(ob.source, "入口の答えが消えない").toBe("marche");
    expect(ob.initialAction, "タップも記録される").toBe("howto");
  });

  it("連携済みなら本カルテへ。ここでも既存の onboarding サブフィールドを消さない", async () => {
    const user = synthLineUserId("f16c");
    const shopifyId = "900800400902";
    const s = makeStore();
    s.users.set(shopifyId, {
      onboarding: { completedAt: null, initialAction: null, source: "online" },
    });

    let behaviorWrites = 0;
    await recordOnboardingCompletion(user, "explore_tea", { ...env, ...FS_BINDINGS } as never, {
      resolveShopifyId: async () => shopifyId,
      getLineUser: s.getLineUser as never,
      updateLineUser: s.updateLineUser as never,
      getCustomer: s.getCustomer as never,
      updateCustomer: s.updateCustomer as never,
      addBehavior: async () => {
        behaviorWrites++;
      },
    });

    const ob = s.users.get(shopifyId)!.onboarding!;
    expect(ob.source, "本カルテ側の入口の答えも消さない").toBe("online");
    expect(ob.initialAction).toBe("explore_tea");
    expect(behaviorWrites, "連携済みでは behaviorLog も書く").toBe(1);
    // 未連携カルテには書かない。
    expect(s.lineUsers.size).toBe(0);
  });
});

describe("hermetic L1 — 動線16: 毎日の照合（装置3・取りこぼしゼロの最後の担保）", () => {
  it("★ 連携済みなのに合流していない人を拾い直す", async () => {
    const linked = synthLineUserId("f16d");
    const already = synthLineUserId("f16e");
    const noKarte = synthLineUserId("f16f");
    const mergedCalls: Array<{ line: string; shopify: string }> = [];

    const result = await runKarteReconcile({ ...env, ...FS_BINDINGS } as never, {
      fsEnv: FS_ENV,
      listLinkages: async () => [
        { lineUserId: linked, shopifyCustomerId: "900800400903" },
        { lineUserId: already, shopifyCustomerId: "900800400904" },
        { lineUserId: noKarte, shopifyCustomerId: "900800400905" },
      ],
      getLineUser: (async (id: string) => {
        if (id === linked) return { lineUserId: linked } as LineUserProfile;
        if (id === already) return { lineUserId: already, mergedToShopify: true } as LineUserProfile;
        return null; // 未連携カルテそのものが無い
      }) as never,
      merge: (async (lineUserId: string, shopifyCustomerId: string) => {
        mergedCalls.push({ line: lineUserId, shopify: shopifyCustomerId });
        return null;
      }) as never,
    });

    // ★ ロードベアリング: 未合流の 1 件だけを拾う（合流済み・カルテ不在は触らない）。
    expect(mergedCalls).toEqual([{ line: linked, shopify: "900800400903" }]);
    expect(result.scanned).toBe(3);
    expect(result.merged).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.notRun).toBeNull();

    // 回収できない範囲を自己申告する（「照合が回ったから全部安全」と読み違えさせない）。
    expect(result.outOfScope.join("")).toContain("穴3");
    expect(result.outOfScope.join("")).toContain("穴4");

    // 外部送信ゼロ。
    expect(h.line.sends.length).toBe(0);
  });

  it("1 件の失敗で全体を止めない（次回の照合で再試行される）", async () => {
    const a = synthLineUserId("f160");
    const b = synthLineUserId("f161");
    let ok = 0;

    const result = await runKarteReconcile({ ...env, ...FS_BINDINGS } as never, {
      fsEnv: FS_ENV,
      listLinkages: async () => [
        { lineUserId: a, shopifyCustomerId: "900800400906" },
        { lineUserId: b, shopifyCustomerId: "900800400907" },
      ],
      getLineUser: (async (id: string) => ({ lineUserId: id }) as LineUserProfile) as never,
      merge: (async (lineUserId: string) => {
        if (lineUserId === a) throw new Error("transient firestore failure");
        ok++;
        return null;
      }) as never,
    });

    expect(result.failed).toBe(1);
    expect(result.merged).toBe(1);
    expect(ok).toBe(1);
  });

  it("Firestore 未設定なら静かに何もしない（cron を落とさない）", async () => {
    const result = await runKarteReconcile(env as never, {
      listLinkages: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result.notRun).toBe("firestore not configured");
    expect(result.scanned).toBe(0);
  });
});
