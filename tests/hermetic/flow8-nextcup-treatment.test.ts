/**
 * ハーメティック L1 — 動線8: 「次の一杯」treatment 記録（設計 v2.1 #1 最優先・spec §6-3）。
 *
 * 計測の止血をロードベアリングにガードする:
 *   「次の一杯」を実際に見せたとき、どの銘柄をどの版（karte 個別化 / baseline）で見せたかを
 *   flow_events(next_cup_shown) に残す。これを残さないと「どの版を見せたか」が後から遡れない
 *   消えるデータになり、個別最適の効果測定（A/B）が原理的にできなくなる。
 *
 * 検証（別カルテ → 別版タグ + 見せた銘柄）:
 *   - karte 個別化（青茶カルテ）で 40101 を見せたら next_cup_shown{product_no:40101, value:"karte"}。
 *   - 空カルテ（baseline）で 11401 を見せたら next_cup_shown{product_no:11401, value:"baseline"}。
 *   - rate-bad（提案ゼロ・見せない）では next_cup_shown を書かない（「見せたときだけ」の境界）。
 *   metadata（ratedNo / baselineNo）も固定し、後段で版を再導出できる証跡を残すことを示す。
 *
 * カルテ注入は handleTeaMenuFlow の deps シーム（loadKarte）で行う（Firestore 非接触・実ネットワーク不使用）。
 * flow_events は fire-and-forget のため settle() で書き込みを待ってから assert する（flow2 と同じ流儀）。
 * teas はモック Notion（tests/lib/tea-fixtures.ts TEA_FIXTURE）由来。実送信ゼロ・グローバルガード下。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { settle } from "../lib/webhook";
import { synthLineUserId } from "../lib/synthetic";
import { _resetTeaCache, handleTeaMenuFlow } from "../../src/lib/tea-menu";
import type { NextCupKarte } from "../../src/lib/next-cup";
import type { LineResponder, QuickReplyItem } from "../../src/lib/line";

/** TOK の区切り（全角縦棒 U+FF5C）。感想よい{SEP}{番号} で rate-good を駆動する。 */
const SEP = "｜";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache(); // Notion TTL キャッシュを毎テストで初期化（フィクスチャの決定性を担保）。
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/** 送信テキストを捨てる Responder（本動線は flow_events の効果を見るので本文は使わない）。 */
function nullResponder(): LineResponder {
  return {
    async text(_t: string, _qr?: QuickReplyItem[]): Promise<void> {
      /* 破棄 */
    },
    async flex(_altText: string, _contents: Record<string, unknown>): Promise<void> {
      /* この動線では未使用 */
    },
  };
}

/** 指定ユーザーの next_cup_shown 行だけを取り出す（他ユーザー・他イベントは除外）。 */
function nextCupRows(user: string): Array<Record<string, unknown>> {
  return h.supabase
    .all("flow_events")
    .filter((e) => e.user_ref === user && e.event_name === "next_cup_shown");
}

describe("hermetic L1 — 動線8: 次の一杯の treatment 記録（v2.1 #1）", () => {
  it('karte 個別化で 40101 を見せる → next_cup_shown{product_no:40101, value:"karte"}', async () => {
    const user = synthLineUserId("f8k");
    const karte: NextCupKarte = {
      persona: null,
      tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null },
    };

    const handled = await handleTeaMenuFlow(user, `感想よい${SEP}11301`, env, nullResponder(), {
      loadKarte: async () => karte,
    });
    expect(handled).toBe(true);

    await settle(); // fire-and-forget の flow_events 書き込みを待つ。
    const rows = nextCupRows(user);
    expect(rows.length, "見せたら next_cup_shown が 1 件").toBe(1);
    const row = rows[0];
    expect(row.product_no, "見せた銘柄（青茶・カルテ反映）").toBe("40101");
    expect(row.value, "版タグ = 個別化が baseline と別銘柄を選んだ").toBe("karte");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.ratedNo, "+1 された起点").toBe("11301");
    expect(meta.baselineNo, "baseline なら 11401 だった（≠ 見せた 40101 ＝個別化が効いた証跡）").toBe("11401");
  });

  it('空カルテ（baseline）で 11401 を見せる → next_cup_shown{product_no:11401, value:"baseline"}', async () => {
    const user = synthLineUserId("f8b");

    await handleTeaMenuFlow(user, `感想よい${SEP}11301`, env, nullResponder(), {
      loadKarte: async () => ({ persona: null, tasteProfile: null }),
    });

    await settle();
    const rows = nextCupRows(user);
    expect(rows.length, "見せたら next_cup_shown が 1 件").toBe(1);
    const row = rows[0];
    expect(row.product_no, "baseline の同軸最小").toBe("11401");
    expect(row.value, "カルテが結果を変えていない → baseline").toBe("baseline");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.baselineNo, "baseline == 見せた銘柄").toBe("11401");
  });

  it("rate-bad（提案ゼロ・見せない）→ next_cup_shown を書かない（見せたときだけの境界）", async () => {
    const user = synthLineUserId("f8n");

    await handleTeaMenuFlow(user, `感想いまいち${SEP}11301`, env, nullResponder(), {
      loadKarte: async () => ({ persona: null, tasteProfile: null }),
    });

    await settle();
    expect(nextCupRows(user).length, "見せていないので記録しない").toBe(0);
  });
});
