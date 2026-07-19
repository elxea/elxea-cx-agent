/**
 * ハーメティック L1 — 動線6: お茶の提示・メニュー・おすすめの出し分け（監査 punch-list #②-2）。
 *
 * 監査 #②-2 の是正をロードベアリングにガードする:
 *   従来 お茶一覧（entry / お茶を探す / お茶の一覧）は generic 固定順（種類→番号）で、
 *   その人の好み（カルテ）を読まなかった。#2 が「次の一杯」をカルテ対応にしたのと同じ源
 *   （persona / tasteProfile・会話側 core.ts buildPersonalizationBlock と一致）を一覧の並べ替えにも供給し、
 *   「その人に合うお茶を先頭へ surfacing する」出し分けを成立させる。本フローは:
 *     - handleTeaMenuFlow が entry 時にカルテを読み、buildEntryMessage の並びへ反映することを検証する。
 *     - 青茶を好むカルテ（tasteProfile.preferredCategories=["oolong"]）を注入すると、一覧の先頭が
 *       baseline の 11301（緑茶・generic 先頭）→ 40101（青茶）へ変わる（surfaced ahead）。
 *     - カルテ無し／空（本番既定ローダは Firebase 未設定で fail-safe 空）なら generic 並びのまま
 *       （先頭 11301・40101 は generic 位置）＝ no-karte ユーザーは完全に従来挙動（graceful fallback）。
 *   さらに buildEntryMessage 単体で、別カテゴリ（紅茶）カルテが先頭を surfacing することも純粋に示す。
 *
 * カルテ注入は handleTeaMenuFlow の deps シーム（loadKarte）で行う（Firestore 非接触・実ネットワーク不使用）。
 * teas はモック Notion（tests/lib/tea-fixtures.ts TEA_FIXTURE）由来。実送信ゼロ・グローバルガード下。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import { AROMA_DRY, AROMA_RICH, BODY_FULL, BODY_LIGHT } from "../lib/tea-fixtures";
import {
  _resetTeaCache,
  handleTeaMenuFlow,
  buildEntryMessage,
  TEA_LIST_ENTRY_TRIGGER,
} from "../../src/lib/tea-menu";
import type { TeaItem } from "../../src/lib/tea-menu";
import type { NextCupKarte } from "../../src/lib/next-cup";
import type { LineResponder, QuickReplyItem } from "../../src/lib/line";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache(); // Notion TTL キャッシュを毎テストで初期化（フィクスチャの決定性を担保）。
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/** お茶カードの quick reply トークン prefix（tea-menu.ts TOK.card = "このお茶" + 全角縦棒）。 */
const CARD_PREFIX = "このお茶｜";

/** 一覧の quick reply からお茶カードの 5 桁番号を「出現順」に取り出す（＝一覧の並び順）。 */
function entryOrder(qrs: QuickReplyItem[]): string[] {
  return qrs
    .filter((q) => q.action.text.startsWith(CARD_PREFIX))
    .map((q) => q.action.text.match(/\d{5}/)?.[0] ?? "");
}

/** 送信ごとの quick reply（お茶カードの番号列）を捕捉する Responder（Firestore/LINE 非接触）。 */
function captureEntryResponder(): { responder: LineResponder; order: () => string[] } {
  const orders: string[][] = [];
  const responder: LineResponder = {
    async text(_t: string, qr?: QuickReplyItem[]): Promise<void> {
      orders.push(entryOrder(qr ?? []));
    },
    async flex(_altText: string, _contents: Record<string, unknown>): Promise<void> {
      /* この動線では未使用 */
    },
  };
  return { responder, order: () => orders[0] ?? [] };
}

/** テスト用 TeaItem 生成（全フィールド充足・buildEntryMessage 単体テスト用）。 */
function mk(number: string, category: string, flavorProfiles: string[]): TeaItem {
  return {
    number,
    name: `お茶${number}`,
    category,
    flavorProfiles,
    descShort: "",
    howToBrew: "",
    temp: "",
    time: "",
    water: "",
    enjoy: "",
    story: "",
  };
}

describe("hermetic L1 — 動線6: お茶一覧の出し分け（監査 #②-2）", () => {
  it("カルテ(青茶を好む)を注入 → 一覧の先頭が baseline(11301) から 40101(青茶) へ surfacing される", async () => {
    const user = synthLineUserId("f6k");
    const cap = captureEntryResponder();
    const karte: NextCupKarte = {
      persona: null,
      tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null },
    };

    const handled = await handleTeaMenuFlow(user, TEA_LIST_ENTRY_TRIGGER, env, cap.responder, {
      loadKarte: async () => karte,
    });
    expect(handled).toBe(true);

    const order = cap.order();
    // ロードベアリング: 青茶カルテで 40101 が先頭へ前出しされる（generic では 4 番目）。
    expect(order[0]).toBe("40101");
    // A/B の肝: カルテ反映順は「40101 が 11301(generic 先頭) より前」。
    expect(order.indexOf("40101")).toBeLessThan(order.indexOf("11301"));
    // 全体順序も明示（40101 だけ前出し・残りは generic 種類→番号を保つ決定的 tiebreak）。
    expect(order).toEqual(["40101", "11301", "11401", "11501", "20101"]);
  });

  it("カルテ空 → generic 並び（先頭 11301・40101 は generic 位置）＝ no-karte 後方互換（青茶カルテとの A/B 対照）", async () => {
    const user = synthLineUserId("f6e");
    const cap = captureEntryResponder();

    await handleTeaMenuFlow(user, TEA_LIST_ENTRY_TRIGGER, env, cap.responder, {
      loadKarte: async () => ({ persona: null, tasteProfile: null }),
    });

    const order = cap.order();
    expect(order[0]).toBe("11301"); // generic 先頭（緑茶・最小番号）
    expect(order).toEqual(["11301", "11401", "11501", "40101", "20101"]); // generic 固定順
    // fallback の肝: カルテ無しでは 40101 は前出しされない（11301 より後ろ）。
    expect(order.indexOf("40101")).toBeGreaterThan(order.indexOf("11301"));
  });

  it("deps 未指定(本番既定ローダ) → Firebase 未設定で fail-safe、generic 並び 11301 に着地", async () => {
    const user = synthLineUserId("f6d");
    const cap = captureEntryResponder();

    // deps を渡さない = 本番と同じ経路（loadCustomerKarte）。ハーメティック env は Firebase 未設定なので
    // getFirestoreEnv が throw → 空カルテ → generic 並び。出し分け配線が本番でも fail-safe なことを示す。
    await handleTeaMenuFlow(user, TEA_LIST_ENTRY_TRIGGER, env, cap.responder);

    const order = cap.order();
    expect(order[0]).toBe("11301"); // 本番既定ローダでも fail-safe に generic へ倒れる
    expect(order).toEqual(["11301", "11401", "11501", "40101", "20101"]);
  });

  it("buildEntryMessage 単体: 紅茶カルテが先頭を surfacing / カルテ無しは generic（純粋・no-karte 対照）", () => {
    const teas = [
      mk("11301", "緑茶", [AROMA_RICH, BODY_FULL]),
      mk("40101", "青茶", [AROMA_RICH, BODY_FULL]),
      mk("20101", "紅茶", [AROMA_DRY, BODY_LIGHT]),
    ];

    // カルテ無し = generic（種類 緑茶→青茶→紅茶）→ 先頭 11301。
    expect(entryOrder(buildEntryMessage(teas, 0).quickReplies)).toEqual(["11301", "40101", "20101"]);

    // 紅茶を好むカルテ → 20101（紅茶）を先頭へ前出し（残りは generic 順を保つ）。
    const blackKarte: NextCupKarte = {
      persona: null,
      tasteProfile: { preferredCategories: ["black"], flavorPreferences: [], scenePref: null },
    };
    expect(entryOrder(buildEntryMessage(teas, 0, blackKarte).quickReplies)).toEqual([
      "20101",
      "11301",
      "40101",
    ]);
  });
});
