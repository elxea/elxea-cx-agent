/**
 * ハーメティック L1 — 動線4: QR同梱ウェルカム（#3）→ 感想カード ループ（#4）。
 *
 * 監査 punch-list #3（コンテンツ/High）+ #4（動線/Med）の是正をガードする。
 *   #3: QR 同梱ウェルカムがブランド正本（brand-copy）を通り、読み仮名（エルクシア）・
 *       シングルオリジン・配信頻度が必ず入る（旧ハードコード文面の迂回を解消）。
 *   #4: QR 同梱ユーザーが slug→5桁番号 解決 → 当該お茶のカード（💬感想ボタン付き）へ乗り、
 *       card→感想→次の一杯 の個別最適ループに入る（旧・自由対話3択の行き止まりを解消）。
 *
 * 署名付き webhook（follow イベント）→ Worker インプロセス dispatch → LINE 送信モックで捕捉 → 中身を assert。
 *   QR の ref（pkg_{slug}）は follow event に載らない（LINE 仕様）ため、pending_follow_refs へ seed して
 *   getPendingFollowRef の読取を再現する。実送信ゼロ・実ネットワーク不使用（グローバルガード下）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { followEvent, messageEvent, synthLineUserId } from "../lib/synthetic";
import { _resetTeaCache, TEA_LIST_ENTRY_TRIGGER } from "../../src/lib/tea-menu";
import {
  BRAND_NAME_READING,
  WELCOME_DELIVERY_FREQUENCY,
  NEXT_CUP_GOOD_THANKS,
} from "../../src/lib/brand-copy";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache(); // Notion TTL キャッシュを毎テストで初期化（フィクスチャの決定性を担保）。
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/** QR 同梱物経由を再現: pending_follow_refs に ref を seed（有効期限は 9 分後）。 */
function seedPendingRef(user: string, ref: string): void {
  h.supabase.seed("pending_follow_refs", [
    {
      line_user_id: user,
      ref,
      expires_at: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
    },
  ]);
}

describe("hermetic L1 — 動線4: QR同梱ウェルカム → 感想カード ループ", () => {
  it("QR follow → ブランド正本ウェルカム（読み仮名/配信頻度/シングルオリジン）+ 評価可能カード → 感想で次の一杯", async () => {
    const user = synthLineUserId("f4a");
    seedPendingRef(user, "pkg_11301"); // 袋の 5 桁番号を埋め込んだ QR。

    const { status } = await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [followEvent(user)],
    });
    expect(status).toBe(200);

    const reply = h.line.texts().join("\n---\n");
    expect(reply.length).toBeGreaterThan(0);

    // --- #3: ウェルカムがブランド正本要素（brand-copy 由来）を含む ---
    expect(reply).toContain(BRAND_NAME_READING); // 読み仮名「エルクシア」
    expect(reply).toContain(WELCOME_DELIVERY_FREQUENCY); // 配信頻度 1 行
    expect(reply).toContain("シングルオリジン"); // single-origin

    // --- #4: 解決したお茶（11301）のカードが提示され、💬感想（rate token）が付く ---
    expect(reply).toContain("11301｜");
    const msgJson = JSON.stringify(h.line.allMessages());
    // カードの 💬感想 ボタン = 「感想｜11301」トークン（rating-capable card の証拠）。
    expect(msgJson).toContain(`感想${"｜"}11301`);
    // 旧・自由対話3択（内部トリガー）は QR 導線から消えている。
    expect(msgJson).not.toContain("onboarding:product_detail");
    expect(msgJson).not.toContain("onboarding:brewing_guide");

    // --- ループ到達の実証: 感想よい → お礼 + 次の一杯（同軸最小 = 11401） ---
    await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, `感想よい${"｜"}11301`)],
    });
    // UX③: 次の一杯は Flex カードで返る（従来のお礼＋提案文は altText に入る・fallback）。
    const reply2 = [
      ...h.line.texts(),
      ...h.line.flexes().map((f) => String(f.altText ?? "")),
    ].join("\n---\n");
    expect(reply2).toContain(NEXT_CUP_GOOD_THANKS);
    expect(reply2).toContain("11401｜");

    // --- DB 効果: QR 由来の感想が product_ratings（カルテの燃料）に記録される ---
    await settle();
    const ratings = h.supabase.all("product_ratings");
    const row = ratings.find((r) => r.user_ref === user && r.product_no === "11301");
    expect(row, "QR ユーザーの感想が product_ratings に入る").toBeTruthy();
    expect(row?.rating).toBe(1);
  });

  it("解決不能な slug（販売終了・番号変更 等）→ ウェルカムは届き、一覧入口へ着地（行き止まりにしない）", async () => {
    const user = synthLineUserId("f4b");
    seedPendingRef(user, "pkg_99999"); // フィクスチャに無い番号 = 未解決。

    const { status } = await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [followEvent(user)],
    });
    expect(status).toBe(200);

    const reply = h.line.texts().join("\n---\n");
    // ウェルカムは必ず届く（ブランド正本・配信頻度）。
    expect(reply).toContain(WELCOME_DELIVERY_FREQUENCY);

    const msgJson = JSON.stringify(h.line.allMessages());
    // 未解決でもカード無し・一覧入口 quick reply に着地（自由対話3択の行き止まりにしない）。
    expect(msgJson).toContain(TEA_LIST_ENTRY_TRIGGER); // 「お茶を選ぶ」入口
    // 存在しない番号のカードは出さない（創作しない・カードなら 99999｜名前 になる）。
    expect(reply).not.toContain("99999｜");
  });
});
