/**
 * ハーメティック L1 — 動線9: 連携成立時の好み引き継ぎ（carryover・設計 §3 / ジャーニー S5）。
 *
 * ❌→✅（spec §3 / 突合表 Table A #16 / 監査 #10）:
 *   従来 lineUsers→users の好みマージは TODO（mergedToShopify フラグ「だけ」定義・自動マージ処理 =
 *   mergeLineUserIntoShopify は不在）だった。本テストは新設した mergeLineUserIntoShopify を
 *   「モック連携（in-memory Firestore）」でロードベアリングにガードする:
 *     1. 好みを持つ lineUser を連携 → users カルテへ畳まれる。persona は既存 mergePersonaScores 流儀の
 *        「別軸への累積加算」（＝上書きしない・会員側スコアを保持）／ tasteProfile は union。
 *     2. 冪等: 二度呼んでも二重加算しない（mergedToShopify=true で no-op）。
 *     3. graceful: lineUser カルテ不在／入口回答のみ（persona も taste も無い）は no-op（users を触らない）。
 *
 * GA-ready: Shopify 連携（LIFF）は GA 前で、本番の唯一の呼び出し元 identity/link-liff は未発火
 *   （Firestore 未設定で no-op に倒れる・別 unit で配線を固定）。ここはその「連携が成立したら」を
 *   in-memory Firestore で模し（mocked-link）、GA したとき正しく畳まれる不変条件を先に固定する。
 *
 * 安全: Firestore REST はハーメティック fetch のモック対象外（googleapis は fail-closed で throw）。
 *   よって本テストは実 I/O を張らず DI（in-memory）で純粋駆動する。実送信ゼロ・実ネットワーク非接触
 *   （h.line.sends が空であることも明示的に確認する）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import {
  mergeLineUserIntoShopify,
  personaScoresToSignals,
  type CarryoverDeps,
  type CustomerProfile,
  type LineUserProfile,
  type FirestoreEnv,
} from "../../src/lib/firestore";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/** Firestore 資格情報は使わない（DI で I/O を差し替えるため任意のモック値でよい）。 */
const FS_ENV = {
  FIREBASE_PROJECT_ID: "e2e-mock-project",
  FIREBASE_CLIENT_EMAIL: "e2e@mock.local",
  FIREBASE_PRIVATE_KEY: "e2e-mock-key",
} as FirestoreEnv;

const LINE_ID = synthLineUserId("f9ca"); // 合成・非実在（U + 32hex）
const SHOPIFY_ID = "900800400901"; // 予約帯・非実在の数値顧客 ID

/** 好みを持つ未連携カルテ（persona は sensory 寄り・taste は青茶/リッチ/夜）。 */
function lineKarteWithPrefs(): LineUserProfile {
  return {
    lineUserId: LINE_ID,
    persona: {
      primary: "sensory",
      scores: { serenity: 2, explorer: 0, sensory: 6 },
      lastUpdated: "2026-07-01T00:00:00Z",
    },
    tasteProfile: {
      preferredCategories: ["oolong"],
      flavorPreferences: ["rich"],
      scenePref: "night",
    },
    mergedToShopify: false,
  };
}

/**
 * in-memory Firestore（実 REST 非接触）。lineUsers/users を Map で持ち、update は PATCH 相当の
 * 浅いマージで反映する（updateMask=指定キーのみ差し替え・実 update*Profile と同じ効果）。
 * write 回数を数え、冪等/no-op を「書き込みが起きない」ことでも検証できるようにする。
 */
function makeStore() {
  const lineUsers = new Map<string, LineUserProfile>();
  const users = new Map<string, CustomerProfile>();
  const writes = { customer: 0, line: 0 };
  const deps: CarryoverDeps = {
    getLineUser: async (id) => lineUsers.get(id) ?? null,
    getCustomer: async (id) => users.get(id) ?? null,
    updateCustomer: async (id, updates) => {
      writes.customer++;
      users.set(id, { ...(users.get(id) ?? {}), ...updates });
    },
    updateLineUser: async (id, updates) => {
      writes.line++;
      lineUsers.set(id, { ...(lineUsers.get(id) ?? {}), ...updates });
    },
  };
  return { deps, lineUsers, users, writes };
}

describe("hermetic L1 — 動線9: 連携時の好み引き継ぎ（carryover・設計 §3）", () => {
  it("好みを持つ lineUser を連携 → users へ畳まれる（persona は別軸累積で上書きしない / taste は union）", async () => {
    const s = makeStore();
    s.lineUsers.set(LINE_ID, lineKarteWithPrefs());
    // 会員側は既に別の好みを持つ（引き継ぎで消えてはならない = anti-overwrite の対照）。
    s.users.set(SHOPIFY_ID, {
      membershipTier: "standard",
      persona: {
        primary: "serenity",
        scores: { serenity: 3, explorer: 1, sensory: 0 },
        lastUpdated: "2026-06-01T00:00:00Z",
      },
      tasteProfile: {
        preferredCategories: ["green"],
        flavorPreferences: ["sweet"],
        scenePref: "morning",
      },
    });

    const merged = await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);
    const after = s.users.get(SHOPIFY_ID)!;

    // ★ break-proof（ロードベアリング）: persona は「別軸への累積加算」で畳まれる。
    //   会員側 serenity=3 は保持され lineUser の +2 が乗って 5、sensory は 0→6。primary は最大軸 sensory。
    //   もし畳みを「上書き」に変えると serenity=2（or lineUser 値）になり、この 1 行が赤になる。
    //   畳みを外すと sensory=0 のままで赤になる。→ mergePersonaScores 流儀の引き継ぎが消えたら検知。
    expect(after.persona!.scores).toEqual({ serenity: 5, explorer: 1, sensory: 6 });
    expect(after.persona!.primary).toBe("sensory");

    // tasteProfile は union（重複排除・会員側を残す）。scenePref は lineUser 側（最新）を採る。
    expect(after.tasteProfile!.preferredCategories).toEqual(["green", "oolong"]);
    expect(after.tasteProfile!.flavorPreferences).toEqual(["sweet", "rich"]);
    expect(after.tasteProfile!.scenePref).toBe("night");
    // 会員側の非好みフィールドは触らない（部分更新）。
    expect(after.membershipTier).toBe("standard");

    // 連携元カルテには「統合済み」が立つ（二重加算防止フラグ）。
    expect(s.lineUsers.get(LINE_ID)!.mergedToShopify).toBe(true);
    // 戻り値も統合後カルテ（連携直後の読取に使える）。
    expect(merged!.persona!.scores.sensory).toBe(6);

    // data-only: LINE 送信は一度も起きない（外部送信ゼロ）。
    expect(h.line.sends.length).toBe(0);
  });

  it("会員カルテが空でも畳まれる（staging demo 相当: users 好み空 → 好みが移る）", async () => {
    const s = makeStore();
    s.lineUsers.set(LINE_ID, lineKarteWithPrefs());
    // users は seed しない（好み空・連携直後の会員）。

    const merged = await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);
    const after = s.users.get(SHOPIFY_ID)!;

    // 空 base への畳み込み: scores はそのまま移る（sensory=6 / primary=sensory）。
    expect(after.persona!.scores).toEqual({ serenity: 2, explorer: 0, sensory: 6 });
    expect(after.persona!.primary).toBe("sensory");
    expect(after.tasteProfile!.preferredCategories).toContain("oolong");
    expect(merged!.persona!.primary).toBe("sensory");
    expect(s.lineUsers.get(LINE_ID)!.mergedToShopify).toBe(true);
  });

  it("冪等: 二度呼んでも二重加算しない（mergedToShopify=true で 2 回目は no-op）", async () => {
    const s = makeStore();
    s.lineUsers.set(LINE_ID, lineKarteWithPrefs());

    await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);
    const writesAfterFirst = { ...s.writes };
    await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);

    // ★ 二重加算しない: sensory は 6 のまま（12 にならない）。
    expect(s.users.get(SHOPIFY_ID)!.persona!.scores.sensory).toBe(6);
    // 2 回目は書き込みを 1 度も追加しない（no-op）。
    expect(s.writes.customer).toBe(writesAfterFirst.customer);
    expect(s.writes.line).toBe(writesAfterFirst.line);
    expect(s.writes.customer).toBe(1);
  });

  it("graceful: lineUser カルテ不在 → no-op（users を一切触らない）", async () => {
    const s = makeStore();
    // lineUsers は空（未連携カルテそのものが無い）。会員側は既存の好みを持つ。
    s.users.set(SHOPIFY_ID, {
      persona: {
        primary: "serenity",
        scores: { serenity: 3, explorer: 0, sensory: 0 },
        lastUpdated: "2026-06-01T00:00:00Z",
      },
    });

    const merged = await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);

    expect(s.writes.customer).toBe(0); // 会員カルテへ書かない
    expect(s.writes.line).toBe(0);
    // 会員側の既存好みは不変。
    expect(s.users.get(SHOPIFY_ID)!.persona!.scores.serenity).toBe(3);
    // 戻り値は現状の会員カルテ（no-op でも読取に使える）。
    expect(merged!.persona!.scores.serenity).toBe(3);
  });

  // ── 穴2 の封鎖（2026-08-08・roji同じ人だと分かる仕組み 第3章）
  //   このテストは**期待値を反転させた**。改修前は「persona も taste も無ければ no-op」を
  //   正しい挙動として固定していたが、それこそが穴2 —— 「まだ買っていないがアンケートには
  //   答えた人」が合流済みの印すら付かず永久に孤児化する —— だった。
  //   いまの正しい挙動は「好みが空でも合流を成立させ、印を付ける」。
  it("★ 穴2: 入口回答のみ（好みが空）でも合流が成立し、合流済みの印が必ず付く", async () => {
    const s = makeStore();
    s.lineUsers.set(LINE_ID, {
      lineUserId: LINE_ID,
      onboarding: { completedAt: null, initialAction: null, source: "marche" },
    });
    s.users.set(SHOPIFY_ID, {
      persona: {
        primary: "serenity",
        scores: { serenity: 3, explorer: 0, sensory: 0 },
        lastUpdated: "2026-06-01T00:00:00Z",
      },
    });

    await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);
    const after = s.users.get(SHOPIFY_ID)!;

    // ★ ロードベアリング: 好みが空でも「合流済み」が立つ（＝孤児にならない）。
    //   早期 return を戻すとここが赤くなる。
    expect(s.lineUsers.get(LINE_ID)!.mergedToShopify).toBe(true);
    // 合流の記録（項目33）も残る。
    expect(s.lineUsers.get(LINE_ID)!.mergeRecord?.fromLineUserId).toBe(LINE_ID);

    // ★ 穴1: 入口の答えは落ちずに本カルテへ載る。
    expect(after.onboarding?.source).toBe("marche");

    // 会員側の既存の好みは一切消えない（合流は追加のみ）。
    expect(after.persona!.scores.serenity).toBe(3);
  });

  it("★ 穴1: 好みと一緒に、カルテの追加項目（安全・窓・イベント関心）もまとめて持ち越される", async () => {
    const s = makeStore();
    s.lineUsers.set(LINE_ID, {
      ...lineKarteWithPrefs(),
      onboarding: { completedAt: null, initialAction: null, source: "online" },
      safety: { tags: ["caffeine_sensitive"] },
      windowAffinity: { tea: 3, music: 2 },
      eventInterest: "onsite",
    });
    // 会員側は安全の申告を別に持つ（消えてはならない）。
    s.users.set(SHOPIFY_ID, { safety: { tags: ["allergy"] } });

    await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);
    const after = s.users.get(SHOPIFY_ID)!;

    // 改修前は persona / tasteProfile 以外が 1 つも載らなかった＝この 4 行が穴1 の検知点。
    expect(after.onboarding?.source).toBe("online");
    expect(after.windowAffinity).toEqual({ tea: 3, music: 2 });
    expect(after.eventInterest).toBe("onsite");
    // 安全は消す方向の統合を絶対にしない（両方残る）。
    expect(after.safety!.tags!.sort()).toEqual(["allergy", "caffeine_sensitive"]);

    // 好みの畳み込み（既存の流儀）は不変。
    expect(after.persona!.scores.sensory).toBe(6);
  });

  it("★ 穴1: 規則の表に無い新項目でも合流で持ち越される（項目を足しても落ちない）", async () => {
    const s = makeStore();
    // 「あとから誰かがカルテに足した項目」を模す（型に無いキー）。
    s.lineUsers.set(LINE_ID, {
      lineUserId: LINE_ID,
      surveyAnswers: { q1: "a", q2: "c" },
    } as unknown as LineUserProfile);

    await mergeLineUserIntoShopify(LINE_ID, SHOPIFY_ID, FS_ENV, s.deps);
    const after = s.users.get(SHOPIFY_ID)! as unknown as Record<string, unknown>;

    expect(after.surveyAnswers).toEqual({ q1: "a", q2: "c" });
    expect(s.lineUsers.get(LINE_ID)!.mergedToShopify).toBe(true);
  });

  it("純粋: personaScoresToSignals は各軸スコアをその軸トークン n 個へ展開（0/負/非有限は無視）", () => {
    expect(personaScoresToSignals({ serenity: 2, explorer: 0, sensory: 3 })).toEqual([
      "serenity",
      "serenity",
      "sensory",
      "sensory",
      "sensory",
    ]);
    expect(personaScoresToSignals({ serenity: 0, explorer: 0, sensory: 0 })).toEqual([]);
    expect(
      personaScoresToSignals({ serenity: -1, explorer: 0, sensory: Number.NaN }),
    ).toEqual([]);
  });
});
